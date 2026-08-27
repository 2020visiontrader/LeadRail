'use client';
import { useEffect, useState, useCallback } from 'react';
import Button from '@/components/Button';
import Input from '@/components/Input';
import Badge from '@/components/Badge';
import LoadingSpinner from '@/components/LoadingSpinner';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';

// Settings -> Workspace -> Documents. Migration 067 gave every attachment a
// `scope` ('conversation' | 'library') and a `title`, and lib/documents/
// attachments.ts already reads scope='library' into EVERY conversation's
// context — attachmentContextBlock even labels one "available in every chat"
// when it renders. None of that was reachable: nothing in the product could
// set scope, so every row landed as 'conversation' and the library was a
// column nobody could ever fill in. This panel is that missing control.
//
// It lists the WHOLE account (GET ?all=1 — see listAllAttachments), not one
// conversation, because "what documents does this workspace have" is a
// different question than "what is in this chat", and settings is where the
// former belongs.

interface DocRow {
  id: string;
  filename: string;
  title: string | null;
  scope: 'conversation' | 'library' | string;
  mime_type: string | null;
  bytes: number;
  status: string;
  created_at: string;
  conversation_id: string | null;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function statusBadge(status: string): { label: string; tone: 'green' | 'amber' | 'red' | 'blue' | 'gray' } {
  switch (status) {
    case 'ready': return { label: 'Read', tone: 'green' };
    case 'image': return { label: 'Image', tone: 'blue' };
    case 'video': return { label: 'Video', tone: 'blue' };
    case 'unreadable': return { label: 'Could not read', tone: 'amber' };
    default: return { label: status, tone: 'gray' };
  }
}

export default function DocumentLibrary() {
  const { notify } = useToast();
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGet<{ attachments: DocRow[] }>('/api/assistant/attachments?all=1');
      setDocs(res.attachments || []);
    } catch (e: any) {
      notify(e?.message || 'Failed to load documents', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  async function toggleScope(doc: DocRow) {
    const nextScope = doc.scope === 'library' ? 'conversation' : 'library';
    setBusyId(doc.id);
    try {
      const res = await apiSend<{ attachment: DocRow }>(`/api/assistant/attachments/${doc.id}`, 'PATCH', { scope: nextScope });
      setDocs((cur) => cur.map((d) => (d.id === doc.id ? res.attachment : d)));
      notify(
        nextScope === 'library'
          ? `"${doc.title || doc.filename}" is now in the library — every chat, plan and scheduled run can see it.`
          : `"${doc.title || doc.filename}" is chat-only again.`,
        'success',
      );
    } catch (e: any) {
      notify(e?.message || 'Could not change where that document reaches', 'error');
    } finally {
      setBusyId(null);
    }
  }

  function startRename(doc: DocRow) {
    setRenamingId(doc.id);
    setRenameValue(doc.title || doc.filename);
  }

  async function saveRename(doc: DocRow) {
    const title = renameValue.trim();
    setBusyId(doc.id);
    try {
      // An empty box means "go back to the filename" — sent as null so the
      // fallback in the row (and in attachmentContextBlock's label) kicks in,
      // rather than storing an empty string that reads as a blank name.
      const res = await apiSend<{ attachment: DocRow }>(`/api/assistant/attachments/${doc.id}`, 'PATCH', {
        title: title || null,
      });
      setDocs((cur) => cur.map((d) => (d.id === doc.id ? res.attachment : d)));
      setRenamingId(null);
    } catch (e: any) {
      notify(e?.message || 'Could not rename that document', 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(doc: DocRow) {
    const label = doc.title || doc.filename;
    if (!window.confirm(`Delete "${label}"? This removes the file and its extracted text everywhere — every chat that could see it, included.`)) return;
    setBusyId(doc.id);
    try {
      await apiSend(`/api/assistant/attachments/${doc.id}`, 'DELETE');
      setDocs((cur) => cur.filter((d) => d.id !== doc.id));
      notify(`Deleted "${label}"`, 'success');
    } catch (e: any) {
      notify(e?.message || 'Could not delete that document', 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function open(doc: DocRow) {
    try {
      const res = await apiGet<{ url: string }>(`/api/assistant/attachments/${doc.id}`);
      if (res.url) window.open(res.url, '_blank', 'noopener,noreferrer');
    } catch (e: any) {
      notify(e?.message || 'Could not open that document', 'error');
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
      <div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Documents</h2>
        <p className="text-sm text-[var(--text-secondary)]">
          Every file uploaded to your assistant, across every chat. A document marked <strong>Library</strong> is
          available in every chat, every plan and every scheduled run — save your brand book, pricing sheet or lead
          list once instead of re-attaching it each time you need it. Everything else is <strong>Chat only</strong>:
          visible in the conversation it was uploaded to and nowhere else.
        </p>
      </div>

      {loading ? (
        <LoadingSpinner />
      ) : docs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border-default)] p-6 text-center text-sm text-[var(--text-secondary)]">
          No documents yet. Attach a file from any chat, then come back here to save it to the library — a document
          saved to the library is available in every chat, every plan and every scheduled run, so a brand book or a
          pricing sheet only needs uploading once.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-[var(--border-default)] text-left text-[var(--text-secondary)]">
                <th className="py-2 pr-3 font-medium">Name</th>
                <th className="py-2 pr-3 font-medium">Scope</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Size</th>
                <th className="py-2 pr-3 font-medium">Uploaded</th>
                <th className="py-2 pr-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => {
                const busy = busyId === doc.id;
                const sb = statusBadge(doc.status);
                const isLibrary = doc.scope === 'library';
                return (
                  <tr key={doc.id} className="border-b border-[var(--border-default)] last:border-0">
                    <td className="max-w-[280px] py-2.5 pr-3">
                      {renamingId === doc.id ? (
                        <div className="flex items-center gap-2">
                          <Input
                            value={renameValue}
                            onChange={(e) => setRenameValue((e.target as HTMLInputElement).value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') saveRename(doc); if (e.key === 'Escape') setRenamingId(null); }}
                            autoFocus
                            className="!py-1"
                          />
                          <Button variant="secondary" onClick={() => saveRename(doc)} loading={busy} className="!px-2 !py-1 text-xs">Save</Button>
                          <Button variant="ghost" onClick={() => setRenamingId(null)} className="!px-2 !py-1 text-xs">Cancel</Button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => open(doc)}
                          title={doc.filename}
                          className="truncate text-left font-medium text-[var(--text-primary)] hover:underline"
                        >
                          {doc.title || doc.filename}
                        </button>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      <Badge tone={isLibrary ? 'indigo' : 'gray'}>{isLibrary ? 'Library — every chat' : 'Chat only'}</Badge>
                    </td>
                    <td className="py-2.5 pr-3"><Badge tone={sb.tone}>{sb.label}</Badge></td>
                    <td className="py-2.5 pr-3 text-[var(--text-secondary)]">{humanSize(doc.bytes)}</td>
                    <td className="py-2.5 pr-3 text-[var(--text-secondary)]">{new Date(doc.created_at).toLocaleDateString()}</td>
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center justify-end gap-2">
                        {renamingId !== doc.id && (
                          <Button variant="ghost" onClick={() => startRename(doc)} disabled={busy} className="!px-2 !py-1 text-xs">Rename</Button>
                        )}
                        <Button variant="secondary" onClick={() => toggleScope(doc)} loading={busy} className="!px-2 !py-1 text-xs">
                          {isLibrary ? 'Remove from library' : 'Add to library'}
                        </Button>
                        <Button variant="danger" onClick={() => remove(doc)} loading={busy} className="!px-2 !py-1 text-xs">Delete</Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
