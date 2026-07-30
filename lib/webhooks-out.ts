// ============================================================
// Phase D #18 — signed outbound webhooks. Customers register endpoints; the
// platform emits events into a durable delivery queue (webhook_deliveries),
// drained by the tick. Each POST is HMAC-SHA256 signed over the raw body so the
// receiver can verify authenticity. Bounded retries with exponential backoff.
// ============================================================
import crypto from 'node:crypto';
import { supabase } from '@/lib/db';

const MAX_ATTEMPTS = 6;
const SIG_HEADER = 'x-maos-signature';

export function signPayload(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Queue an event for every active endpoint of the account subscribed to it.
 * Best-effort: never throws into the calling business path. No-op if 012 isn't
 * applied yet or the account has no endpoints.
 */
export async function emitEvent(accountId: string, event: string, payload: Record<string, any>): Promise<void> {
  if (!accountId || !event) return;
  try {
    const { data: endpoints } = await supabase
      .from('webhook_endpoints')
      .select('id, events')
      .eq('account_id', accountId)
      .eq('is_active', true);
    if (!endpoints?.length) return;
    const rows = endpoints
      .filter((e: any) => !e.events?.length || e.events.includes(event))
      .map((e: any) => ({
        account_id: accountId,
        endpoint_id: e.id,
        event,
        payload,
        status: 'pending',
        next_attempt_at: new Date().toISOString(),
      }));
    if (rows.length) await supabase.from('webhook_deliveries').insert(rows);
  } catch {
    // table absent or transient error — swallow; delivery is not business-critical
  }
}

function backoffMs(attempts: number): number {
  // 1m, 2m, 4m, 8m, 16m, 32m
  return Math.min(2 ** Math.max(0, attempts - 1), 32) * 60 * 1000;
}

/** Drain due webhook deliveries. Called from the cron tick. */
export async function processDueWebhookDeliveries(limit = 20) {
  const claimId = crypto.randomUUID();
  let claimed: any[] = [];
  try {
    const { data, error } = await supabase.rpc('claim_webhook_deliveries', {
      p_limit: limit, p_claim: claimId, p_lock_seconds: 120,
    });
    if (error) throw error;
    claimed = data || [];
  } catch {
    return { processed: 0, considered: 0 }; // 012 not applied yet
  }

  // Resolve endpoint url+secret for the claimed batch.
  const endpointIds = [...new Set(claimed.map((d: any) => d.endpoint_id))];
  const epMap = new Map<string, { url: string; secret: string }>();
  if (endpointIds.length) {
    const { data: eps } = await supabase
      .from('webhook_endpoints').select('id, url, secret').in('id', endpointIds);
    for (const e of eps || []) epMap.set(e.id, { url: e.url, secret: e.secret });
  }

  let delivered = 0, failed = 0;
  for (const d of claimed) {
    const ep = epMap.get(d.endpoint_id);
    if (!ep) {
      await supabase.from('webhook_deliveries')
        .update({ status: 'failed', last_error: 'endpoint removed', next_attempt_at: null, claim_id: null, locked_until: null })
        .eq('id', d.id);
      continue;
    }
    const body = JSON.stringify({ event: d.event, data: d.payload, delivery_id: d.id, ts: new Date().toISOString() });
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [SIG_HEADER]: signPayload(ep.secret, body),
          'x-maos-event': d.event,
          'x-maos-delivery': d.id,
        },
        body,
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));

      if (res.ok) {
        await supabase.from('webhook_deliveries')
          .update({ status: 'delivered', response_status: res.status, delivered_at: new Date().toISOString(), claim_id: null, locked_until: null })
          .eq('id', d.id);
        await supabase.from('webhook_endpoints')
          .update({ last_status: res.status, last_delivery_at: new Date().toISOString() })
          .eq('id', d.endpoint_id);
        delivered++;
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (e: any) {
      const permanent = d.attempts >= MAX_ATTEMPTS;
      await supabase.from('webhook_deliveries').update({
        status: 'failed',
        last_error: String(e?.message || e).slice(0, 300),
        next_attempt_at: permanent ? null : new Date(Date.now() + backoffMs(d.attempts)).toISOString(),
        claim_id: null,
        locked_until: null,
      }).eq('id', d.id);
      await supabase.from('webhook_endpoints').update({ last_status: 0 }).eq('id', d.endpoint_id).then(() => {}, () => {});
      failed++;
    }
  }
  return { processed: claimed.length, delivered, failed };
}
