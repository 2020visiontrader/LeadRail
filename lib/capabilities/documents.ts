// Document capabilities — reading what the user has actually given us.
//
// TWO PROBLEMS THIS CLOSES, and the second one is mine.
//
// 1. A document was only ever visible inside the chat it was dropped into.
//    There was no account-level place to put source material, so a brand book
//    had to be re-uploaded per conversation, and a plan or a scheduled run —
//    neither of which is "a chat someone dropped a file into" — could never see
//    one at all.
//
// 2. The attachment block told the model the untruncated remainder "can be
//    searched", and nothing could search it. I then replaced that with a note
//    telling it to call `readAttachment`, which did not exist either — so the
//    model would now actually attempt the call and get "unknown tool". A false
//    promise the model acts on is worse than one it only believes. These are
//    the tools that make the note true.
//
// The read is deliberately OFFSET-AND-QUERY rather than "return the whole
// document": a library document can be far larger than a turn should spend its
// context on, and the point of the budget work was to spend context on purpose
// rather than by accident.

import { z } from 'zod';
import { obj, S, type Capability } from './types';
import { supabase } from '@/lib/db';

/** How much text one read returns. Generous — the caller asked for this
 *  specific passage — but not unbounded, because a 400-page contract returned
 *  whole would evict the conversation it was being read for. */
const READ_WINDOW = Number(process.env.DOCUMENT_READ_CHARS) || 40_000;
/** Characters of context either side of a query match. Enough to read a clause
 *  in its surroundings rather than as a fragment. */
const MATCH_CONTEXT = 1_500;

interface DocRow {
  id: string; filename: string; title: string | null; kind: string | null;
  chars: number; scope: string; status: string; extracted_text: string | null;
  conversation_id: string | null; created_at: string;
}

async function findDoc(accountId: string, ref: string): Promise<DocRow | null> {
  const needle = (ref || '').trim();
  if (!needle) return null;
  try {
    // Exact id first, then title, then filename — most specific to least, so a
    // user who names a document precisely is never resolved to a different one.
    for (const col of ['id', 'title', 'filename'] as const) {
      // `id` is a uuid column; a non-uuid ref would make Postgres error rather
      // than simply not match, so only try it when the ref could be one.
      if (col === 'id' && !/^[0-9a-f-]{36}$/i.test(needle)) continue;
      const q = supabase.from('assistant_attachments').select('*').eq('account_id', accountId);
      const { data } = col === 'id' ? await q.eq('id', needle).limit(1) : await q.ilike(col, needle).limit(1);
      const row = Array.isArray(data) ? data[0] : null;
      if (row) return row as DocRow;
    }
    // Last resort: a partial filename match, so "brand book" finds
    // "brand-book-v3.pdf".
    const { data } = await supabase.from('assistant_attachments')
      .select('*').eq('account_id', accountId).ilike('filename', `%${needle}%`).limit(1);
    return (Array.isArray(data) ? data[0] : null) as DocRow | null;
  } catch {
    return null;
  }
}

export const DOCUMENT_CAPABILITIES: Capability[] = [
  {
    name: 'listDocuments',
    domain: 'knowledge',
    title: 'List saved documents',
    description:
      "List the documents saved to this account's library — files the user keeps available to every chat, not just ones attached to the current conversation. Use before asking the user to re-send something they may already have given you.",
    gate: 'read',
    inputSchema: obj({ includeThisChat: { type: 'boolean' } }, []),
    zod: z.object({ includeThisChat: z.boolean().optional() }),
    run: async (accountId, a, ctx?: any) => {
      try {
        let q = supabase.from('assistant_attachments')
          .select('id, filename, title, kind, chars, scope, status, created_at')
          .eq('account_id', accountId)
          .order('created_at', { ascending: false })
          .limit(100);
        // Library by default. A chat's own attachments are already in the
        // prompt, so listing them again is noise unless asked for.
        q = a.includeThisChat && ctx?.conversationId
          ? q.or(`scope.eq.library,conversation_id.eq.${ctx.conversationId}`)
          : q.eq('scope', 'library');
        const { data } = await q;
        const rows = (data || []) as any[];
        return {
          documents: rows.map((r) => ({
            id: r.id,
            name: r.title || r.filename,
            kind: r.kind,
            characters: r.chars,
            savedToLibrary: r.scope === 'library',
            readable: r.status === 'ready',
          })),
        };
      } catch {
        return { documents: [] };
      }
    },
    digest: (_a, r: any) => {
      if (!r) return '';
      return r.documents?.length
        ? `${r.documents.length} document(s) saved and readable.`
        : 'No documents are saved to the library.';
    },
  },
  {
    name: 'readDocument',
    domain: 'knowledge',
    title: 'Read part of a document',
    description:
      'Read a saved or attached document by name or id. Pass `query` to find the passages mentioning something, or `offset` to continue reading from where you stopped. Use this when a document was truncated in your context, or when you need a part of one you have not been shown.',
    gate: 'read',
    inputSchema: obj({ document: S.string, query: S.string, offset: S.number }, ['document']),
    zod: z.object({
      document: z.string().min(1),
      query: z.string().min(2).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    run: async (accountId, a) => {
      const doc = await findDoc(accountId, a.document);
      if (!doc) return { found: false, reason: 'No document by that name or id on this account.' };
      const text = doc.extracted_text || '';
      if (!text) {
        // Named, not silently empty — "no text" and "no such document" are
        // different facts and the model must be able to tell the user which.
        return { found: true, name: doc.title || doc.filename, text: '', note: doc.status === 'ready' ? 'This document has no readable text.' : `Not readable: ${doc.status}.` };
      }

      if (a.query) {
        const hay = text.toLowerCase();
        const needle = a.query.toLowerCase();
        const passages: { at: number; text: string }[] = [];
        let from = 0;
        while (passages.length < 8) {
          const at = hay.indexOf(needle, from);
          if (at === -1) break;
          passages.push({
            at,
            text: text.slice(Math.max(0, at - MATCH_CONTEXT), at + needle.length + MATCH_CONTEXT),
          });
          from = at + needle.length;
        }
        return {
          found: true,
          name: doc.title || doc.filename,
          totalCharacters: text.length,
          matches: passages.length,
          passages,
          // Says plainly when the answer is "it is not in there", rather than
          // returning nothing and letting that read as a failure to look.
          note: passages.length ? undefined : `"${a.query}" does not appear in this document.`,
        };
      }

      const start = Math.min(a.offset ?? 0, text.length);
      const slice = text.slice(start, start + READ_WINDOW);
      const end = start + slice.length;
      return {
        found: true,
        name: doc.title || doc.filename,
        totalCharacters: text.length,
        from: start,
        to: end,
        text: slice,
        more: end < text.length ? `${text.length - end} characters remain — call again with offset ${end}.` : undefined,
      };
    },
    digest: (_a, r: any) => {
      if (!r) return '';
      if (!r.found) return 'No document by that name.';
      if (r.passages) return `${r.matches} passage(s) found in ${r.name}.`;
      return `Read ${r.name} from ${r.from} to ${r.to} of ${r.totalCharacters} characters.`;
    },
    // A document's text IS the deliverable here — the shared observation cap
    // would truncate the very passage that was asked for.
    observationLimit: READ_WINDOW + 4_000,
  },
  {
    name: 'saveDocumentToLibrary',
    domain: 'knowledge',
    title: 'Keep a document for every chat',
    description:
      'Save a document attached to this conversation into the account library, so it is available in every future chat, plan and scheduled run. Use when the user says to keep, remember, or always use a file — a brand book, a price list, a style guide.',
    gate: 'internal_write',
    inputSchema: obj({ document: S.string, title: S.string }, ['document']),
    zod: z.object({ document: z.string().min(1), title: z.string().max(200).optional() }),
    run: async (accountId, a) => {
      const doc = await findDoc(accountId, a.document);
      if (!doc) return { saved: false, reason: 'No document by that name in this chat.' };
      try {
        await supabase.from('assistant_attachments')
          .update({ scope: 'library', title: a.title || doc.title || doc.filename })
          .eq('account_id', accountId).eq('id', doc.id);
        return { saved: true, name: a.title || doc.title || doc.filename };
      } catch {
        return { saved: false, reason: 'Could not save it.' };
      }
    },
    digest: (_a, r: any) => {
      if (!r) return '';
      return r.saved ? `"${r.name}" is now available in every chat.` : 'Not saved.';
    },
  },
  {
    name: 'removeDocumentFromLibrary',
    domain: 'knowledge',
    title: 'Stop keeping a document',
    description:
      'Remove a document from the account library so it is no longer offered in every chat. The file itself is kept; only its account-wide reach is withdrawn.',
    gate: 'internal_write',
    inputSchema: obj({ document: S.string }, ['document']),
    zod: z.object({ document: z.string().min(1) }),
    run: async (accountId, a) => {
      const doc = await findDoc(accountId, a.document);
      if (!doc) return { removed: false };
      try {
        await supabase.from('assistant_attachments')
          .update({ scope: 'conversation' })
          .eq('account_id', accountId).eq('id', doc.id);
        return { removed: true, name: doc.title || doc.filename };
      } catch {
        return { removed: false };
      }
    },
  },
];
