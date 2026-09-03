// Pending-approval continuation short-circuit.
//
// The gap this closes: when a sensitive-tool proposal is sitting pending for
// a conversation, a user typing "continue" still ran the WHOLE loop — full
// system prompt, full transcript, a model call (measured 40-150K tokens on
// real conversations), often re-calling listApprovals — only to produce
// "still waiting on your approval". One production conversation did this
// across turns 4-24; the phrase recurs 16 times across its history.
//
// The fix is narrow on purpose (see CONTENTLESS_CONTINUATION_PHRASES below):
// only a message that carries NO instruction beyond "keep going" ever
// short-circuits. "continue with the other leads" is a real instruction and
// MUST reach the model like any other turn.
//
// Reuses pendingApprovalForConversation (lib/approvals/store.ts) rather than
// writing a second pending-approval query — two places deciding the same
// thing is a bug class this codebase has already shipped twice.

import { pendingApprovalForConversation, type SafeApproval } from '@/lib/approvals/store';
import { log } from '@/lib/logger';

// EXACT-MATCH ONLY. Deliberately a whole-message allow-list, never a
// substring/prefix test: substring-matching "continue" would also match
// "continue with the other leads", silently eating a real instruction the
// user typed. Every entry here is a message that, taken on its own, asks for
// nothing but "keep going" — no new information for the model to act on.
// Compared after normalizeContinuation() (trim, lowercase, strip trailing
// punctuation/emoji), so "Continue!", "continue.", "Continue 👍" all match
// "continue" but "continue please, and also check the domain" matches
// nothing and goes to the model as normal.
export const CONTENTLESS_CONTINUATION_PHRASES: ReadonlySet<string> = new Set([
  'continue',
  'keep going',
  'go on',
  'carry on',
  'go ahead',
  'proceed',
  'any update',
  'any updates',
  'status',
  'status update',
  'update',
  'updates',
  '?',
  'ok',
  'okay',
  'ok continue',
  'okay continue',
  'continue please',
  'please continue',
  'yes continue',
]);

/** Trim, lowercase, and strip trailing punctuation/emoji so "Continue!",
 *  "continue.", and "continue 👍" all normalize to "continue" — but nothing
 *  is stripped from the MIDDLE of the message, so extra words survive and
 *  correctly fail the allow-list match. */
export function normalizeContinuation(message: string): string {
  let s = message.trim().toLowerCase();
  // Repeatedly strip trailing whitespace, ASCII punctuation, and emoji/variation
  // selectors until a pass changes nothing — handles "continue!! 👍🏽" in one go
  // without assuming a fixed order of trailing characters.
  for (;;) {
    const stripped = s
      .replace(/[\s!.?…,;:"'`~]+$/u, '')
      .replace(/[\p{Extended_Pictographic}‍️\u{1F3FB}-\u{1F3FF}]+$/u, '');
    // Never strip a bare "?" down to nothing — it is itself an allow-listed
    // phrase (a lone question mark asking "well?"), not punctuation ON a
    // longer message.
    if (stripped === s || !stripped) break;
    s = stripped;
  }
  return s;
}

/** True only for a whole message that is exactly one of
 *  CONTENTLESS_CONTINUATION_PHRASES after normalization. */
export function isContentlessContinuation(message: string | undefined | null): boolean {
  if (!message) return false;
  const norm = normalizeContinuation(message);
  if (!norm) return false;
  return CONTENTLESS_CONTINUATION_PHRASES.has(norm);
}

/** Write the reply by hand from what's actually on the row — this is code
 *  writing to a person, not a model, so it must be honest and specific: name
 *  the tool, the item count for a batch, and how to act. Never claim work is
 *  progressing; it is blocked until a human decides. */
export function buildPendingApprovalReply(approval: SafeApproval): string {
  const calls = Array.isArray((approval.args_redacted as any)?.calls)
    ? (approval.args_redacted as any).calls as unknown[]
    : null;
  const what = calls && calls.length
    ? `${approval.title} (a batch of ${calls.length} item${calls.length === 1 ? '' : 's'})`
    : approval.title;
  return [
    `Still waiting on your approval for **${what}** — I haven't run it yet.`,
    approval.summary,
    'Approve it, reject it, or approve for the rest of this session from the approval card above, and I\'ll pick back up right away.',
  ].join('\n\n');
}

export interface PendingApprovalShortCircuit {
  approval: SafeApproval;
  reply: string;
}

/** Returns a status reply (and the pending row it describes) when THIS turn
 *  should skip the model entirely — an approval is genuinely pending for
 *  this conversation/account, and the user's message carries no instruction
 *  beyond "keep going". Returns null whenever the turn must go through the
 *  model as normal, including when the approvals lookup itself throws: a DB
 *  hiccup must never swallow a user's turn, so this fails OPEN to the normal
 *  path rather than guessing. */
export async function checkPendingApprovalShortCircuit(
  accountId: string,
  conversationId: string | null | undefined,
  message: string | undefined,
): Promise<PendingApprovalShortCircuit | null> {
  if (!conversationId) return null;
  if (!isContentlessContinuation(message)) return null;
  let approval: SafeApproval | null;
  try {
    approval = await pendingApprovalForConversation(accountId, conversationId);
  } catch (e) {
    log.warn('agent: pending-approval lookup failed for continuation short-circuit, falling through to normal turn', {
      accountId, conversationId, error: String((e as any)?.message || e),
    });
    return null;
  }
  if (!approval) return null;
  return { approval, reply: buildPendingApprovalReply(approval) };
}
