// Private file storage on Supabase Storage.
//
// Every tenant file lives under a `<account_id>/…` prefix in a PRIVATE bucket.
// Nothing is public: reads are served through short-lived signed URLs, and a
// tenant's whole prefix is removed on account purge. This is the enforcement
// point for "every account's files are private."
import { supabase } from '@/lib/db';

export const DECK_BUCKET = 'venture-decks';
export const ATTACHMENT_BUCKET = 'outreach-attachments';

// Signed-URL lifetimes. Decks are re-signed on demand (short). Outreach
// attachments are embedded in an email a recipient may open days later, so they
// get a longer window — but still finite and revocable (delete the object).
export const DECK_URL_TTL = 60 * 60;               // 1 hour
export const ATTACHMENT_URL_TTL = 60 * 60 * 24 * 30; // 30 days

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
