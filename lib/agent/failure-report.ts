// Best-effort support-ticket filing for a turn that failed to produce an
// answer, called from app/api/agent/stream/route.ts's catch and !terminalSent
// paths.
//
// WHY THIS IS ITS OWN FUNCTION, NOT AN INLINE CALL. `fileFailure` (see
// lib/support/tickets.ts) does real I/O — an insert or an update against
// support_tickets. That can fail on its own (a DB blip, a bad connection) for
// reasons that have nothing to do with the turn that triggered it. The route
// already had ONE bug from exactly this shape: a `send()` inside `catch`
// throwing again and skipping `saveConversation` entirely (see
// stream-guard.ts and tests/stream-disconnect.test.ts). Ticket filing must
// never become a second way to reproduce that class of defect — a failed
// attempt to REPORT a failure must not turn into a bigger failure than the
// one being reported. So every call is wrapped here, once, in a try/catch
// that swallows and logs rather than lets anything propagate into the
// route's own finally block.
//
// WHAT GOES IN. Enough for triage — route, a normalized reason, the
// provider/health state if the caller has it, conversation id, account id —
// and nothing else. Explicitly NOT the user's document content or message
// text: `fileFailure`'s `detail` field is written verbatim to a ticket a
// human reads later, and the content of what someone attached or asked is
// not something a failure report needs to carry to be actionable.

import { log } from '@/lib/logger';

export interface StreamFailureReport {
  accountId: string;
  conversationId?: string;
  route: string;
  /** Short machine reason — 'exception' | 'incomplete' | 'blocked', or an
   *  HTTP-style status when one is known. Kept short and shape-stable so
   *  fingerprinting collapses repeats of the same failure onto one ticket
   *  instead of one ticket per occurrence. */
  reason: string;
  /** Human-readable detail for triage — an error message or a short
   *  description of the health state observed. Never the user's message or
   *  attachment content. */
  detail: string;
  providersDown: boolean;
  severity?: 'low' | 'normal' | 'high' | 'critical';
}

/**
 * File (or fold into an existing) support ticket for this failure. Never
 * throws, never rejects — a failure here is logged and dropped, exactly the
 * standard the codebase already holds attachment binding to a few lines
 * above this call site in the route (see the comment at the bindAttachments
 * .catch() in app/api/agent/stream/route.ts).
 */
export async function reportStreamFailure(input: StreamFailureReport): Promise<void> {
  try {
    // LAZY IMPORT, ON PURPOSE. This is a failure path — it only runs after a
    // turn has already gone wrong. `lib/support/tickets` pulls in the whole
    // support-ticket module chain (lib/db's supabase client, fingerprinting,
    // etc.), and a static `import` at the top of this file made every module
    // graph that reaches app/api/agent/stream/route.ts (which imports this
    // file unconditionally) eagerly load that chain at module-load time, for
    // a function most turns never call. That cost ~9s of module load and
    // pushed tests/regressions.test.ts and tests/parity.test.ts past their
    // 30s hook timeout. Loading it here, only when a failure is actually
    // being reported, keeps the common path cheap. Do NOT "tidy" this back
    // to a static import — the whole point is to defer the cost, not just
    // relocate it. The dynamic import can itself reject (e.g. if the module
    // fails to load); that's caught by the same try/catch as fileFailure
    // itself, so this function still never throws.
    const { fileFailure } = await import('@/lib/support/tickets');
    await fileFailure({
      accountId: input.accountId,
      shape: {
        route: input.route,
        statusCode: input.providersDown ? 503 : null,
        message: `${input.reason}: ${input.detail}`,
      },
      detail: input.detail,
      severity: input.providersDown ? 'high' : (input.severity ?? 'normal'),
    });
  } catch (e) {
    log.error('agent stream: reportStreamFailure failed (best-effort, turn unaffected)', e, {
      conversationId: input.conversationId,
      reason: input.reason,
    });
  }
}
