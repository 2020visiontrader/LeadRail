import { supabase } from '@/lib/db';

// ============================================================
// Suppression / blocklist (gap #3 in the analysis).
// Enforced in EVERY send path: outreach, sequences, newsletter.
// A send is suppressed when the exact address OR its domain is listed
// for the sending account. Account-scoped so one tenant cannot leak
// another tenant's suppression list.
// ============================================================

function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}
function domainOf(email: string): string {
  const at = normalizeEmail(email).lastIndexOf('@');
  return at >= 0 ? normalizeEmail(email).slice(at + 1) : '';
}

/** True when this address (or its domain) is suppressed for the account. */
export async function isSuppressed(accountId: string, email: string): Promise<boolean> {
  if (!accountId || !email) return false;
  const addr = normalizeEmail(email);
  const dom = domainOf(addr);
  const { data, error } = await supabase
    .from('suppressions')
    .select('id')
    .eq('account_id', accountId)
    .or(`email.eq.${addr},domain.eq.${dom}`)
    .limit(1);
  if (error) return false; // fail-open on read errors — never blocks a legit send on infra hiccup
  return Boolean(data && data.length);
}

/** Return only the addresses that are NOT suppressed for the account (batched). */
export async function filterSuppressed<T extends { email: string }>(
  accountId: string,
  recipients: T[],
): Promise<T[]> {
  if (!accountId || !recipients.length) return recipients;
  const { data } = await supabase
    .from('suppressions')
    .select('email, domain')
    .eq('account_id', accountId);
  if (!data || !data.length) return recipients;
  const emails = new Set(data.filter((r) => r.email).map((r) => String(r.email).toLowerCase()));
  const domains = new Set(data.filter((r) => r.domain).map((r) => String(r.domain).toLowerCase()));
  return recipients.filter((r) => {
    const addr = normalizeEmail(r.email);
    return !emails.has(addr) && !domains.has(domainOf(addr));
  });
}

/** Add (or upsert) a suppression. Safe to call repeatedly. */
export async function addSuppression(input: {
  accountId: string;
  email?: string;
  domain?: string;
  reason?: string;
  source?: string;
}): Promise<void> {
  const email = input.email ? normalizeEmail(input.email) : null;
  const domain = input.domain ? String(input.domain).trim().toLowerCase() : null;
  if (!input.accountId || (!email && !domain)) return;
  await supabase.from('suppressions').upsert(
    [{ account_id: input.accountId, email, domain, reason: input.reason || 'manual', source: input.source || null }],
    { onConflict: email ? 'account_id,email' : 'account_id,domain', ignoreDuplicates: true },
  );
}

// ============================================================
// Social-identity suppression (Packet 7.3 — automation runner).
// migration 045 extends this SAME table with nullable platform/external_id
// columns rather than forking a parallel concept — one place a person's
// "don't contact me" ever lives, one place that checks it.
//
// isSuppressed() above is deliberately FAIL-OPEN: it backs sends a human
// already reviewed and approved, where an infra hiccup should not block a
// legitimate, already-decided send. isSocialSuppressed() is the opposite on
// purpose — it backs the ONLY fully-autonomous send path in the product
// (social_automations rules firing off a webhook with no human in the loop),
// where a read failure must never be interpreted as "not suppressed". Never
// change this function to fail-open; that would silently reopen the CASL gap
// packet 7.3 exists to close.
// ============================================================

/** True when this social identity is suppressed OR the check itself failed —
 * callers must treat both as "do not send". Never throws. */
export async function isSocialSuppressed(accountId: string, platform: string, externalId: string): Promise<boolean> {
  if (!accountId || !platform || !externalId) return true; // fail closed on malformed input too
  try {
    const { data, error } = await supabase
      .from('suppressions')
      .select('id')
      .eq('account_id', accountId)
      .eq('platform', platform)
      .eq('external_id', externalId)
      .limit(1);
    if (error) return true; // fail CLOSED — the opposite of isSuppressed() above, deliberately
    return Boolean(data && data.length);
  } catch {
    return true;
  }
}

/** Suppress a social identity (e.g. someone who asked to stop hearing from an
 * automated rule) for this account. Upserts; safe to call repeatedly. */
export async function addSocialSuppression(input: {
  accountId: string;
  platform: string;
  externalId: string;
  reason?: string;
  source?: string;
}): Promise<void> {
  if (!input.accountId || !input.platform || !input.externalId) return;
  await supabase.from('suppressions').upsert(
    [{
      account_id: input.accountId,
      platform: input.platform,
      external_id: input.externalId,
      reason: input.reason || 'manual',
      source: input.source || null,
    }],
    { onConflict: 'account_id,platform,external_id', ignoreDuplicates: true },
  );
}
