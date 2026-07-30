// Ambassador / referral program.
//
// One code per ambassador (vanity handle out front, UUID key behind it). Two
// ways to use it: a link (/r/<code> — sets a first-party cookie) and the code
// typed at signup (UGC / podcast). Attribution: cookie window (60d); a typed
// code OVERRIDES last-click. Reward unlocks on a QUALIFYING event, then sits in
// a hold window before it is payable. Double-sided: ambassador + referred friend.
import { createHash } from 'node:crypto';
import { supabase } from '@/lib/db';

export const REF_COOKIE = 'ma_ref';
export const REF_WINDOW_DAYS = 60;

/** Privacy-preserving one-way hash for click de-dup / fraud signals (never raw PII). */
function hash(v: string): string {
  const salt = process.env.APP_SESSION_SECRET || 'ref-salt';
  return createHash('sha256').update(`${salt}:${v}`).digest('hex').slice(0, 32);
}

/** Normalize a candidate handle to A–Z 0–9, 3–24 chars. */
export function normalizeCode(raw: string): string {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
}

/** Look up an active code (case-insensitive). Null if missing/inactive. */
export async function getCodeByValue(code: string) {
  const norm = normalizeCode(code);
  if (norm.length < 3) return null;
  const { data } = await supabase
    .from('referral_codes')
    .select('*')
    .ilike('code', norm)
    .eq('is_active', true)
    .maybeSingle();
  return data;
}

/** The account's ambassador code, if any. */
export async function getMyCode(accountId: string) {
  const { data } = await supabase
    .from('referral_codes')
    .select('*')
    .eq('account_id', accountId)
    .eq('kind', 'ambassador')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data;
}

/** Create (or return existing) the account's ambassador code. Vanity handle is
 *  validated for uniqueness; falls back to a suffixed variant on collision. */
export async function createMyCode(accountId: string, ownerEmail: string, desired?: string) {
  const existing = await getMyCode(accountId);
  if (existing) return existing;

  const base = normalizeCode(desired || ownerEmail.split('@')[0] || 'REF') || 'REF';
  let candidate = base.slice(0, 20);
  for (let i = 0; i < 40; i++) {
    const test = i === 0 ? candidate : `${base.slice(0, 16)}${i + 1}`;
    const { data: taken } = await supabase.from('referral_codes').select('id').ilike('code', test).maybeSingle();
    if (!taken) { candidate = test; break; }
  }
  const { data, error } = await supabase
    .from('referral_codes')
    .insert([{ account_id: accountId, owner_email: ownerEmail, code: candidate, kind: 'ambassador' }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Log a click on a referral link. Best-effort; never throws. */
export async function recordClick(code: string, ip?: string | null, ua?: string | null, referer?: string | null) {
  const row = await getCodeByValue(code);
  if (!row) return;
  await supabase.from('referral_clicks').insert([{
    code_id: row.id, code: row.code,
    ip_hash: ip ? hash(ip) : null,
    ua_hash: ua ? hash(ua) : null,
    referer: referer ? referer.slice(0, 300) : null,
  }]).then(() => {}, () => {});
}

/**
 * Attribute a signup to a referral code. Called when a new account is created,
 * with the code from the signup form (strongest) or the cookie (last-click).
 * Guards self-referral and re-attribution. `via` records which signal won.
 */
export async function attributeSignup(opts: {
  referredAccountId: string;
  referredEmail?: string;
  typedCode?: string | null;
  cookieCode?: string | null;
}): Promise<{ attributed: boolean; via?: 'code' | 'link'; reason?: string }> {
  const via: 'code' | 'link' | null = opts.typedCode ? 'code' : opts.cookieCode ? 'link' : null;
  const codeValue = opts.typedCode || opts.cookieCode;
  if (!codeValue || !via) return { attributed: false, reason: 'no_code' };

  const code = await getCodeByValue(codeValue);
  if (!code) return { attributed: false, reason: 'unknown_code' };
  // Anti-self-referral: an account cannot refer itself.
  if (code.account_id === opts.referredAccountId) return { attributed: false, reason: 'self_referral' };

  // Already attributed? Don't overwrite an existing referral for this account.
  const { data: prior } = await supabase
    .from('referrals').select('id').eq('referred_account_id', opts.referredAccountId).maybeSingle();
  if (prior) return { attributed: false, reason: 'already_attributed' };

  await supabase.from('referrals').insert([{
    code_id: code.id,
    referrer_account_id: code.account_id,
    referred_account_id: opts.referredAccountId,
    referred_email: opts.referredEmail || null,
    status: 'pending',
    attributed_via: via,
  }]).then(() => {}, () => {});

  await supabase.from('accounts')
    .update({ referred_by_code: code.code, referred_by_account: code.account_id })
    .eq('id', opts.referredAccountId).then(() => {}, () => {});

  return { attributed: true, via };
}

/**
 * Mark a referral qualified (the qualifying event fired — e.g. first paid
 * conversion) and write the double-sided reward ledger with a hold window.
 * Idempotent: a referral already past pending is left alone.
 */
export async function qualifyReferral(referredAccountId: string): Promise<{ qualified: boolean; reason?: string }> {
  const { data: ref } = await supabase
    .from('referrals').select('*').eq('referred_account_id', referredAccountId).maybeSingle();
  if (!ref) return { qualified: false, reason: 'no_referral' };
  if (ref.status !== 'pending') return { qualified: false, reason: 'already_' + ref.status };

  const { data: code } = await supabase.from('referral_codes').select('*').eq('id', ref.code_id).maybeSingle();
  if (!code) return { qualified: false, reason: 'no_code' };

  const now = new Date();
  const holdUntil = new Date(now.getTime() + (code.hold_days || 30) * 86400_000).toISOString();

  await supabase.from('referrals')
    .update({ status: 'qualified', qualified_at: now.toISOString() })
    .eq('id', ref.id).then(() => {}, () => {});

  const rewards = [
    {
      referral_id: ref.id, account_id: code.account_id, beneficiary: 'ambassador',
      reward_type: code.reward_type, amount: code.reward_amount, status: 'held', hold_until: holdUntil,
    },
    {
      referral_id: ref.id, account_id: ref.referred_account_id, beneficiary: 'friend',
      reward_type: code.friend_reward_type || 'credit', amount: code.friend_reward_amount || 0,
      status: 'held', hold_until: holdUntil,
    },
  ].filter((r) => Number(r.amount) > 0);
  if (rewards.length) await supabase.from('referral_rewards').insert(rewards).then(() => {}, () => {});

  return { qualified: true };
}

/** Ambassador funnel + earnings for the portal. */
export async function getReferralStats(accountId: string) {
  const code = await getMyCode(accountId);
  if (!code) return { code: null, clicks: 0, signups: 0, qualified: 0, rewards: { held: 0, payable: 0, paid: 0 } };

  const [{ count: clicks }, { data: refs }, { data: rewards }] = await Promise.all([
    supabase.from('referral_clicks').select('id', { count: 'exact', head: true }).eq('code_id', code.id),
    supabase.from('referrals').select('status').eq('code_id', code.id),
    supabase.from('referral_rewards').select('amount, status').eq('account_id', accountId).eq('beneficiary', 'ambassador'),
  ]);
  const signups = (refs || []).length;
  const qualified = (refs || []).filter((r: any) => r.status === 'qualified' || r.status === 'rewarded').length;
  const sum = (s: string) => (rewards || []).filter((r: any) => r.status === s).reduce((a: number, r: any) => a + Number(r.amount || 0), 0);
  return {
    code: { code: code.code, reward_type: code.reward_type, reward_amount: code.reward_amount },
    clicks: clicks || 0, signups, qualified,
    rewards: { held: sum('held'), payable: sum('payable'), paid: sum('paid') },
  };
}

/** Held rewards past their hold window become payable. Returns count matured. */
export async function maturateRewards(): Promise<number> {
  const { data } = await supabase
    .from('referral_rewards')
    .update({ status: 'payable' })
    .eq('status', 'held')
    .lte('hold_until', new Date().toISOString())
    .select('id');
  return (data || []).length;
}
