// Private file storage on Supabase Storage.
//
// Every tenant file lives under a `<account_id>/…` prefix in a PRIVATE bucket.
// Nothing is public: reads are served through short-lived signed URLs, and a
// tenant's whole prefix is removed on account purge. This is the enforcement
// point for "every account's files are private."
import { supabase } from '@/lib/db';

export const DECK_BUCKET = 'venture-decks';
export const ATTACHMENT_BUCKET = 'outreach-attachments';
// Binary files createFile (lib/capabilities/deliverables.ts) hands back to a
// chat user — xlsx/docx/pdf. Kept separate from ATTACHMENT_BUCKET because
// these are chat deliverables, not outbound email attachments, and can be
// purged/retained on a different policy later without touching outreach.
export const DELIVERABLE_BUCKET = 'chat-deliverables';
// Every image/video the assistant generates — brand images, character
// reference anchors, ad creative — lands here instead of the old
// `public/generated/` (gitignored, unauthenticated, destroyed on every
// deploy). Private and tenant-prefixed like every other bucket in this file:
// possession of the URL is NOT access, an account_id prefix scopes purge, and
// nothing here is ever public. See uploadGenerated() below for the one write
// path every generation site shares.
export const GENERATED_BUCKET = 'generated-media';

// Signed-URL lifetimes. Decks are re-signed on demand (short). Outreach
// attachments are embedded in an email a recipient may open days later, so they
// get a longer window — but still finite and revocable (delete the object).
export const DECK_URL_TTL = 60 * 60;               // 1 hour
export const ATTACHMENT_URL_TTL = 60 * 60 * 24 * 30; // 30 days
// Chat deliverables: long enough that a user coming back to a conversation
// hours or days later can still open the link, short enough that a leaked
// link doesn't stay live forever.
export const DELIVERABLE_URL_TTL = 60 * 60 * 24 * 7; // 7 days
// Generated media: the URL this mints is a DISPLAY convenience for the turn
// that generated it (shown in chat, or shown in the campaign/content board
// shortly after) — it is never the identifier anything durable stores. A
// character reference persists `storage_path` and re-signs a fresh URL every
// time it's used as conditioning (lib/capabilities/content.ts), so this TTL
// only has to outlive one chat session's worth of review, not the asset's
// actual lifetime. 24 hours covers same-day review (including a user coming
// back to a long-running conversation later that day) without leaving a link
// that still works if it leaks weeks later.
export const GENERATED_URL_TTL = 60 * 60 * 24; // 24 hours

/** Ensure a bucket exists and is PRIVATE. Idempotent; never throws. */
export async function ensurePrivateBucket(bucket: string): Promise<void> {
  // createBucket fails if it already exists — that's fine. If it exists but was
  // ever public, force it private.
  const created = await supabase.storage.createBucket(bucket, { public: false }).then(
    () => true,
    () => false,
  );
  if (!created) {
    await supabase.storage.updateBucket(bucket, { public: false }).catch(() => {});
  }
}

/** Upload bytes to a private bucket. Returns the storage path (not a URL). */
export async function putPrivate(
  bucket: string,
  path: string,
  bytes: Buffer | Uint8Array,
  contentType?: string,
): Promise<{ path: string; error?: string }> {
  await ensurePrivateBucket(bucket);
  const up = await supabase.storage.from(bucket).upload(path, bytes, {
    contentType: contentType || 'application/octet-stream',
    upsert: true,
  });
  if (up.error) return { path, error: up.error.message };
  return { path };
}

/** Mint a short-lived signed URL for a private object. Null on failure. */
export async function signUrl(bucket: string, path: string, ttl: number): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, ttl);
  if (error || !data) return null;
  return data.signedUrl;
}

function extFor(mimeType: string): string {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('webm')) return 'webm';
  return 'bin';
}

/**
 * Upload generated image/video bytes to GENERATED_BUCKET and hand back BOTH
 * the storage path (the stable identifier — persist THIS) and a freshly
 * signed URL (for immediate display — never persist THIS). The one write
 * path every one of the four generation sites shares (lib/capabilities/
 * content.ts, lib/capabilities/workspace.ts, app/api/generate/image/route.ts)
 * so the upload/sign logic exists once, not three times.
 */
export async function uploadGenerated(
  accountId: string,
  bytes: Buffer | Uint8Array,
  mimeType: string,
): Promise<{ storagePath: string; url: string }> {
  const { randomUUID } = await import('node:crypto');
  const storagePath = `${accountId}/${randomUUID()}.${extFor(mimeType)}`;
  const put = await putPrivate(GENERATED_BUCKET, storagePath, bytes, mimeType);
  if (put.error) throw new Error(`Could not store the generated file: ${put.error}`);
  const url = await signUrl(GENERATED_BUCKET, storagePath, GENERATED_URL_TTL);
  if (!url) throw new Error('The file was generated and stored, but a preview link could not be signed. Try again.');
  return { storagePath, url };
}

/** Recursively list every object path under a prefix (Supabase list is one level). */
async function listAll(bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error || !data) return out;
  for (const entry of data) {
    const full = prefix ? `${prefix}/${entry.name}` : entry.name;
    // A folder entry has no id/metadata; recurse into it.
    if ((entry as any).id == null) {
      out.push(...(await listAll(bucket, full)));
    } else {
      out.push(full);
    }
  }
  return out;
}

/** Delete every object under `<prefix>` in a bucket. Returns count removed. */
export async function removePrefix(bucket: string, prefix: string): Promise<number> {
  const paths = await listAll(bucket, prefix);
  if (!paths.length) return 0;
  // remove in chunks to stay well under request limits
  let removed = 0;
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const { error } = await supabase.storage.from(bucket).remove(chunk);
    if (!error) removed += chunk.length;
  }
  return removed;
}
