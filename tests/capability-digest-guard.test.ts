// A capability that can spend money or reach a real person MUST state its
// outcome from its own return value.
//
// THE PRODUCTION DEFECT. Asked about an outreach batch, the assistant said "the
// last batch already went out to all 13 marketing and e-commerce agency
// contacts". Nothing had gone out — one email existed, from two weeks earlier.
// It had reconstructed the claim from its OWN earlier prose sitting in the
// transcript. The OUTBOX grounding block (lib/outreach/history.ts,
// lib/agent/context.ts) closed that for outreach by stating the true send count
// as fact every turn; nothing generalised it to the other domains that report
// actions.
//
// A `digest` is the general mechanism, and the rule it has to obey is the one
// already written in lib/capabilities/video.ts: a digest reaches the model AS
// FACT, so "Analysed <url>" on a call that returned nothing is the assistant
// telling itself something happened that did not.
//
// WHY THIS TEST IS DRIVEN OFF THE REGISTRY. A hand-written list of twelve names
// would be correct today and silently wrong the first time someone adds a
// thirteenth gated capability — which is precisely how the gap opened. The
// guard below enumerates CAPABILITIES at runtime, so a new `external_send` or
// `spend` entry fails this file on the day it is added, with no edit here.
//
// WIDENED to `destructive` and `standing_rule`. The registry-driven guard did
// its job for the two gates it covered and, exactly as designed, said nothing
// about the two it did not: measured against the live registry, `destructive`
// was 6 of 6 without a digest and `standing_rule` 7 of 7 — 100% uncovered on
// both. Those are the highest-consequence gates left. `destructive` removes
// data; `standing_rule` installs behaviour that keeps running after the turn
// ends. A false claim in either direction — "deleted it" when the delete
// matched nothing, or silence when an automation is now live — is not
// recoverable the way a wrong read is.
//
// STILL OUT: `internal_write` (45 of 62 without a digest) and `read` (26 of
// 96). Their absence here is an OPEN ITEM, not an accepted state — see
// BACKLOG.md §12, which carries the counts and what proves it closed. They are
// left out only because that surface is 71 capabilities and belongs in its own
// packet; adding them to GUARDED_GATES is the whole change when it is done.

import { describe, it, expect } from 'vitest';
import { CAPABILITIES } from '@/lib/capabilities/registry';
import { SENSITIVE_GATES, type Capability } from '@/lib/capabilities/types';

/** The gates this file requires a digest on. Adding a gate here is how the
 *  guard grows; nothing else in the file needs to change. */
const GUARDED_GATES = ['external_send', 'spend', 'destructive', 'standing_rule'] as const;

/** Every registered capability whose false claim costs money, reaches a real
 *  person, destroys data, or arms something that runs unattended. Read from the
 *  registry, never listed by hand. */
const costly = (): Capability[] =>
  CAPABILITIES.filter((c) => (GUARDED_GATES as readonly string[]).includes(c.gate));

/** Sensitive gates the guard does NOT yet cover. Asserted below so that this
 *  list and GUARDED_GATES together stay exhaustive over SENSITIVE_GATES: a new
 *  sensitive gate class cannot be added to lib/capabilities/types.ts and
 *  quietly escape both. */
const NOT_YET_GUARDED: string[] = [];

describe('every capability that spends or sends declares a digest', () => {
  it('the gated set is non-empty (a registry that failed to load would vacuously pass)', () => {
    // Without this, an import cycle that left CAPABILITIES undefined-or-empty
    // — a real failure mode in this repo, see the SCHEDULED_CAPABILITIES note
    // in lib/capabilities/registry.ts — would turn the guard below into a test
    // that asserts nothing at all.
    // 12 external_send+spend when this file was written, plus the 13
    // destructive+standing_rule capabilities the widening brought in.
    expect(costly().length).toBeGreaterThanOrEqual(25);
  });

  it('every sensitive gate is either guarded or explicitly named as not yet guarded', () => {
    // Keeps the two lists honest against the type. Without it, a new sensitive
    // gate class added to SENSITIVE_GATES would be covered by neither, and
    // nothing would say so.
    const uncovered = SENSITIVE_GATES.filter(
      (g) => !(GUARDED_GATES as readonly string[]).includes(g) && !NOT_YET_GUARDED.includes(g),
    );
    expect(uncovered).toEqual([]);
  });

  it('none of them is missing one', () => {
    // The message has to name the capability AND its gate: "a digest is
    // missing" sends the reader back to the registry to work out which of 183
    // entries it means, and the gate is what tells them how bad it is.
    const missing = costly().filter((c) => typeof c.digest !== 'function').map((c) => `${c.gate}:${c.name}`);
    expect(missing, `capabilities on a guarded gate with no digest (gate:name): ${missing.join(', ') || 'none'}`).toEqual([]);
  });

  // Per-gate coverage, so a failure points at ONE capability by name rather
  // than at a list. The gate list is derived, so a new gate added to
  // GUARDED_GATES generates its own cases with no edit here.
  for (const gate of GUARDED_GATES) {
    describe(`gate: ${gate}`, () => {
      for (const c of CAPABILITIES.filter((x) => x.gate === gate)) {
        it(`${c.name} declares a digest`, () => {
          expect(
            typeof c.digest,
            `${c.name} is gated '${gate}' and declares no digest. Without one, successObservation() ` +
            'falls back to the raw JSON and the model states the outcome itself — which is how it came ' +
            'to tell a user a batch "already went out to all 13 contacts" when nothing had been sent. ' +
            'Add a digest in the capability\'s own file that reads the RETURN, not the arguments, and ' +
            "returns '' when the result carries no evidence.",
          ).toBe('function');
        });
      }
    });
  }
});

describe('a digest speaks only for a result that carries evidence', () => {
  // The failure this closes is not "the digest is ugly", it is "the digest
  // asserts an action that did not happen". So every gated capability is fed
  // the results a failed, empty or unrecognised call actually produces, and
  // must say NOTHING. '' is the contract: lib/agent/loop.ts's
  // successObservation() falls back to the raw JSON alone when a digest is
  // empty, which is exactly the pre-digest behaviour.
  const empties: Array<[string, any]> = [
    ['null', null],
    ['undefined', undefined],
    ['false', false],
    ['an empty object', {}],
    ['an error payload', { error: 'Meta error (400): Invalid parameter' }],
    ['a bare string', 'ok'],
    ['a success:false acknowledgement', { success: false }],
  ];
  // NOT in the list above, deliberately, and this is a finding rather than an
  // omission. A bare `[]` is a RECOGNISED, evidence-bearing shape for
  // enrollInSequence: enrollContacts upserts with ignoreDuplicates, so an empty
  // array is the platform saying nobody was enrolled, and its digest correctly
  // says "Enrolled 0 leads … 2 of the 2 requested were not enrolled". That is
  // the opposite of the defect this file guards — it is a truthful NEGATIVE,
  // and forcing it to '' would delete the very correction commit fecab1f made.
  // What must hold for an empty array is that no digest claims a success.
  it('an empty array never becomes a claim that something succeeded', () => {
    for (const c of costly()) {
      const out = (c.digest!({ sequenceId: 'seq-1', contactIds: ['a', 'b'] }, []) ?? '').trim();
      if (!out) continue;
      expect(out).not.toMatch(/\bSent\b|\bPublished\b|\bDelivered\b|\bRevealed\b|\bis LIVE\b/);
      expect(out).toMatch(/\b0\b|\bno\b/i);
    }
  });

  for (const [label, result] of empties) {
    it(`returns '' for ${label}`, () => {
      for (const c of costly()) {
        // Arguments deliberately WELL-FORMED and plausible. If a digest is
        // narrating its request rather than its result, this is where it shows:
        // the args say a send was asked for, the result says nothing happened,
        // and anything but '' is the capability inventing the outcome.
        const args = {
          contactId: 'contact-1', sequenceId: 'seq-1', contactIds: ['contact-1', 'contact-2'],
          subject: 'Hello', html: '<p>hi</p>', id: 'camp-1', dailyBudget: 50,
          platform: 'facebook', accountExternalId: 'page-1', message: 'hi', text: 'hi',
          commentId: 'comment-1', recipientId: 'person-1', channelId: 'chan-1',
          dueAt: '2026-09-09T10:00:00Z', metaObjectId: 'act-1', status: 'ACTIVE',
          hide: true, inboxMessageId: 'inbox-1', bodyHtml: '<p>hi</p>',
          externalId: 'apollo-1', email: 'a@b.com', name: 'Ada', company: 'Acme', limit: 25,
        };
        let out: string;
        try {
          out = c.digest!(args, result) ?? '';
        } catch (e) {
          throw new Error(`${c.name}.digest threw on ${label}: ${(e as Error).message}`);
        }
        expect(`${c.name}: ${out}`).toBe(`${c.name}: `);
      }
    });
  }
});

describe('the outcome is read from the RETURN, never restated from the ARGUMENTS', () => {
  const digestFor = (name: string) => {
    const c = CAPABILITIES.find((x) => x.name === name);
    if (!c?.digest) throw new Error(`${name} has no digest`);
    return c.digest;
  };

  // The clearest divergence in the registry. enrichLead SPENDS a credit and
  // Apollo can still hand back a profile with the address locked — matchPerson
  // (lib/integrations/apollo.ts) resolves `email: null, email_status: 'locked'`
  // in exactly that case. The request named an email; the outcome has none.
  it('enrichLead does not claim an email it was merely asked about', () => {
    const line = digestFor('enrichLead')(
      { email: 'ada@acme.com', name: 'Ada Lovelace' },
      {
        title: 'CTO', seniority: 'c_suite', headline: null, location: 'London',
        linkedin_url: null, employment_history: [], organization: { name: 'Acme' },
        email: null, email_status: 'locked', raw: {},
      },
    );
    expect(line).not.toContain('ada@acme.com');
    expect(line).toMatch(/locked/i);
    // And the profile facts that DID come back are still reported.
    expect(line).toContain('CTO');
  });

  it('enrichLead states the email when the result really carries one', () => {
    const line = digestFor('enrichLead')(
      { name: 'Ada Lovelace' },
      { title: 'CTO', organization: { name: 'Acme' }, email: 'real@acme.com', email_status: 'verified', employment_history: [] },
    );
    expect(line).toContain('real@acme.com');
    expect(line).not.toMatch(/still locked/i);
  });

  // sourceLeads is asked for 25 and Apollo returns 3. The count in the line has
  // to be 3.
  it('sourceLeads counts returned candidates, not the requested limit', () => {
    const line = digestFor('sourceLeads')(
      { limit: 25, titles: ['founder'] },
      {
        candidates: [
          { external_id: 'a', name: 'Ada', title: 'CEO', email: null, email_status: 'locked' },
          { external_id: 'b', name: 'Grace', title: 'CTO', email: null, email_status: 'locked' },
          { external_id: 'c', name: 'Alan', title: 'CTO', email: null, email_status: 'locked' },
        ],
        total: 1621,
      },
    );
    expect(line).toContain('3 candidates');
    expect(line).not.toContain('25');
    expect(line).toContain('1621');
    expect(line).toMatch(/masked/i);
  });

  it('sourceLeads says plainly when a paid search found nobody', () => {
    const line = digestFor('sourceLeads')({ limit: 25 }, { candidates: [], total: 0 });
    expect(line).toMatch(/no candidates/i);
  });

  // publishSocialPost on TikTok does NOT publish: publishTiktokDraft pushes the
  // video to the creator's inbox as a draft they must post themselves. A digest
  // built from args.platform + the capability title would say "Published to
  // TikTok" for a post nobody can see.
  it('publishSocialPost calls a TikTok draft a draft, not a publish', () => {
    const line = digestFor('publishSocialPost')(
      { platform: 'tiktok', message: 'new drop', videoUrl: 'https://x/y.mp4' },
      { data: { publish_id: 'v_pub_url~abc123' }, error: { code: 'ok' } },
    );
    expect(line).toMatch(/draft/i);
    expect(line).toMatch(/NOT published/i);
    expect(line).toContain('v_pub_url~abc123');
  });

  it('publishSocialPost reports a real publish as live', () => {
    const line = digestFor('publishSocialPost')(
      { platform: 'facebook', message: 'hello' },
      { id: '1122334455_998877' },
    );
    expect(line).toMatch(/Published/);
    expect(line).toContain('1122334455_998877');
  });

  // The Send API states its own recipient. When the two disagree — which is
  // what a redirected or resolved id looks like — the platform's wins.
  it('sendSocialMessage reports the recipient the platform confirmed', () => {
    const line = digestFor('sendSocialMessage')(
      { platform: 'instagram', recipientId: 'REQUESTED_ID', text: 'hi' },
      { recipient_id: 'CONFIRMED_ID', message_id: 'mid.abc' },
    );
    expect(line).toContain('CONFIRMED_ID');
    expect(line).not.toContain('REQUESTED_ID');
    expect(line).toContain('mid.abc');
  });

  // replyToSocialComment's receipt is the id of the reply it CREATED. Echoing
  // back the comment it was asked to reply to would prove nothing.
  it('replyToSocialComment names the created reply, not the comment replied to', () => {
    const line = digestFor('replyToSocialComment')(
      { commentId: 'PARENT_COMMENT', message: 'thanks!', platform: 'facebook' },
      { id: 'NEW_REPLY_ID' },
    );
    expect(line).toContain('NEW_REPLY_ID');
    expect(line).not.toContain('PARENT_COMMENT');
  });

  // scheduleSocialPost must not restate args.dueAt — Buffer normalises and may
  // shift it — and must never let "scheduled" be read as "published".
  it('scheduleSocialPost does not restate the requested due time', () => {
    const line = digestFor('scheduleSocialPost')(
      { platform: 'linkedin', text: 'hi', dueAt: '2026-12-25T09:00:00Z', channelId: 'chan-1' },
      { id: 'buffer-post-9' },
    );
    expect(line).toContain('buffer-post-9');
    expect(line).not.toContain('2026-12-25T09:00:00Z');
    expect(line).toMatch(/NOT published/i);
  });

  it('scheduleSocialPost reports the due time Buffer itself confirmed', () => {
    const line = digestFor('scheduleSocialPost')(
      { dueAt: '2026-12-25T09:00:00Z', channelId: 'chan-1', text: 'hi', platform: 'linkedin' },
      { id: 'buffer-post-9', due_at: '2026-12-25T11:30:00Z' },
    );
    expect(line).toContain('2026-12-25T11:30:00Z');
    expect(line).not.toContain('09:00:00Z');
  });

  // launchCampaign's evidence is the four Meta ids. The daily budget in the
  // args is NOT restated: launchCampaign falls back to the campaign's own
  // stored budget when the argument is absent, so the argument may never have
  // been the number spent.
  it('launchCampaign reports Meta ids and not the requested budget', () => {
    const line = digestFor('launchCampaign')(
      { id: 'camp-1', dailyBudget: 500 },
      { campaign: 'meta-camp', adSet: 'adset-77', ad: 'ad-88', creative: 'cre-99' },
    );
    expect(line).toContain('ad-88');
    expect(line).toContain('adset-77');
    expect(line).not.toContain('500');
  });

  it('launchCampaign says nothing for a result with no ad ids', () => {
    expect(digestFor('launchCampaign')({ id: 'camp-1' }, { campaign: 'meta-camp' })).toBe('');
  });

  // replyToThread's recipient exists only on the result — sendInboxReply
  // resolves it from the original inbound message, and the args never carried
  // one at all.
  it('replyToThread names the recipient the send resolved', () => {
    const line = digestFor('replyToThread')(
      { inboxMessageId: 'inbox-1', bodyHtml: '<p>hi</p>' },
      { sent: true, providerId: 'resend-123', from: 'me@leadrail.io', to: 'them@acme.com' },
    );
    expect(line).toContain('them@acme.com');
    expect(line).toContain('resend-123');
  });

  it('replyToThread says nothing when the result does not confirm a send', () => {
    expect(digestFor('replyToThread')({ inboxMessageId: 'inbox-1' }, { sent: false, providerId: null })).toBe('');
  });

  // The two capabilities whose platforms return a bare acknowledgement. They
  // are allowed to speak, but only about the acknowledgement — asserting the
  // object's resulting state as an observed fact is what they must not do.
  it('setAdStatus reports an accepted call and admits it is not a re-read', () => {
    const line = digestFor('setAdStatus')({ metaObjectId: 'ad-1', status: 'ACTIVE' }, { success: true });
    expect(line).toMatch(/accepted/i);
    expect(line).toContain('ACTIVE');
    expect(line).toMatch(/re-read/i);
  });

  it('hideSocialComment reports an accepted call and admits it is not a re-read', () => {
    const line = digestFor('hideSocialComment')({ commentId: 'c-1', hide: true }, { success: true });
    expect(line).toMatch(/accepted/i);
    expect(line).toMatch(/hide/i);
    expect(line).toMatch(/no comment id/i);
  });

  it('hideSocialComment distinguishes unhide from hide', () => {
    const line = digestFor('hideSocialComment')({ commentId: 'c-1', hide: false }, { success: true });
    expect(line).toMatch(/unhide/i);
  });
});

describe('a destructive digest makes the SCOPE of what was removed legible', () => {
  const digestFor = (name: string) => {
    const c = CAPABILITIES.find((x) => x.name === name);
    if (!c?.digest) throw new Error(`${name} has no digest`);
    return c.digest;
  };

  // deleteSocialAutomation is the only delete in the registry whose return
  // carries the deleted row's real prior state: ownedRule() loads it BEFORE the
  // delete and throws when it is absent. `was.enabled` is the fact a reviewer
  // actually needs — deleting a dormant rule changes nothing about the future,
  // deleting a live one stops a standing behaviour.
  it('deleteSocialAutomation says a LIVE rule was the thing removed', () => {
    const line = digestFor('deleteSocialAutomation')(
      { id: 'REQUESTED_ID' },
      { deleted: true, id: 'rule-9', was: { trigger: 'comment_received', action: 'reply', enabled: true } },
    );
    expect(line).toContain('rule-9');
    expect(line).not.toContain('REQUESTED_ID');   // the id reported is the one the result carries
    expect(line).toMatch(/SWITCHED ON/);
    expect(line).toMatch(/comment_received/);
    expect(line).toMatch(/\b1 social automation rule\b/);
  });

  it('deleteSocialAutomation does not imply a dormant rule was doing anything', () => {
    const line = digestFor('deleteSocialAutomation')(
      { id: 'rule-9' },
      { deleted: true, id: 'rule-9', was: { trigger: 'dm_received', action: 'hide', enabled: false } },
    );
    expect(line).toMatch(/already switched off/i);
    expect(line).not.toMatch(/SWITCHED ON/);
  });

  // THE ARGS-VS-RETURN CASE FOR A DELETE. deleteDeal (lib/crm.ts) returns a
  // bare `{ ok: true }` — no id, no name, no amount. The only place the deal's
  // identity exists is the request, and printing it as the outcome is exactly
  // the failure this mechanism exists to stop.
  it('deleteDeal reports one deal and does NOT restate the id it was asked about', () => {
    const line = digestFor('deleteDeal')({ id: 'deal-abc-123' }, { ok: true });
    expect(line).not.toContain('deal-abc-123');
    expect(line).toMatch(/\b1 deal\b/);
    expect(line).toMatch(/soft delete/i);       // the scope: hidden, not erased
    expect(line).toMatch(/carries no id/i);     // and it says why no id is given
  });

  // deleteContentItem/deletePillar (lib/content/store.ts) issue .delete() with
  // NO .select() and no row count, so `{id, deleted:true}` is returned whether
  // or not a row existed. The digest may report the accepted call; it may NOT
  // report a row as removed.
  it('deleteContentItem does not claim a row existed to delete', () => {
    const line = digestFor('deleteContentItem')({ itemId: 'item-1' }, { id: 'item-1', deleted: true });
    expect(line).toMatch(/at most that one row/i);
    expect(line).toMatch(/NOT evidence a row existed/i);
    expect(line).not.toMatch(/\bDeleted 1\b|\bRemoved 1\b/);
  });

  it('deleteContentPillar states that no content was deleted with the pillar', () => {
    const line = digestFor('deleteContentPillar')({ pillarId: 'p-1' }, { id: 'p-1', deleted: true });
    expect(line).toMatch(/No content items were deleted/i);
    expect(line).toMatch(/NOT evidence a pillar existed/i);
  });

  // deleteAutomation THROWS 'not found' on a no-match delete, so unlike the two
  // above, a result really is evidence of one removed row — and the digest is
  // allowed to say so. It must still not invent the rule's state.
  it('deleteAutomation claims exactly one row and admits what it cannot know', () => {
    const line = digestFor('deleteAutomation')({ automationId: 'auto-1' }, { id: 'auto-1', deleted: true });
    expect(line).toMatch(/\b1 CRM automation\b/);
    expect(line).toMatch(/no name, trigger or active flag/i);
  });

  it('deleteSocialComment bounds the scope to one comment and admits it is not a re-read', () => {
    const line = digestFor('deleteSocialComment')(
      { commentId: 'c-1', platform: 'facebook' },
      { deleted: true, commentId: 'c-1' },
    );
    expect(line).toMatch(/one comment/i);
    expect(line).toMatch(/not a re-read/i);
  });
});

describe('a standing_rule digest states that the thing KEEPS RUNNING after this turn', () => {
  const digestFor = (name: string) => {
    const c = CAPABILITIES.find((x) => x.name === name);
    if (!c?.digest) throw new Error(`${name} has no digest`);
    return c.digest;
  };

  // The property that distinguishes this gate from every other write. A digest
  // that reads like a one-off action ("automation created") is actively
  // misleading: approving one send authorises one action, approving a standing
  // rule authorises an unbounded stream of them. Driven off the registry so a
  // standing_rule capability added later must supply a fixture here or fail.
  const ARMED: Record<string, [any, any]> = {
    promoteObservation: [{ observationId: 'obs-1' }, { promoted: true, fact: 'Tuesday sends open best' }],
    createSocialAutomation: [
      { platform: 'facebook', externalId: 'page-1', trigger: 'comment_received', action: 'reply' },
      { id: 'rule-1', trigger: 'comment_received', action: 'reply', daily_cap: 25, enabled: true },
    ],
    enableSocialAutomation: [{ id: 'rule-1' }, { id: 'rule-1', trigger: 'comment_received', action: 'reply', daily_cap: 25, enabled: true }],
    resumeAllSocialAutomations: [{}, { id: 'acct-1', social_automations_paused: false }],
    createAutomation: [
      { name: 'Tag repliers', trigger: 'email.replied', action: 'add_tag' },
      { id: 'auto-1', name: 'Tag repliers', trigger: { type: 'email.replied' }, action: { type: 'add_tag', config: { tag: 'hot' } }, is_active: true },
    ],
    enableAutomation: [
      { automationId: 'auto-1' },
      { id: 'auto-1', name: 'Tag repliers', trigger: { type: 'email.replied' }, action: { type: 'add_tag', config: { tag: 'hot' } }, is_active: true },
    ],
    createScheduledTask: [
      { name: 'Daily digest', prompt: 'summarise', interval: 'daily' },
      { id: 'task-1', name: 'Daily digest', interval: 'daily', enabled: true, next_run_at: '2026-09-04T06:00:00Z' },
    ],
  };

  const standing = CAPABILITIES.filter((c) => c.gate === 'standing_rule');

  it('every standing_rule capability has a fixture here (a new one must not slip through)', () => {
    expect(standing.map((c) => c.name).filter((n) => !(n in ARMED))).toEqual([]);
  });

  for (const c of standing) {
    it(`${c.name} says the effect outlasts this turn`, () => {
      const [args, result] = ARMED[c.name];
      const line = c.digest!(args, result) ?? '';
      expect(line).not.toBe('');
      // "after this turn", "future turns", "from now on" — some statement of
      // continuation. The exact wording is the capability's business; that it
      // makes the claim at all is this file's.
      expect(
        line,
        `${c.name}'s digest for an ARMED result does not say the rule keeps acting beyond this turn: "${line}"`,
      ).toMatch(/after this turn|future turns|from now on|until it is (switched off|withdrawn)/i);
      // …and does not simultaneously read as dormant. Without this the check
      // is satisfiable by the OFF-branch wording, which also says "after this
      // turn" (as in "nothing happens after this turn until it is enabled").
      // Found by revert-checking: a digest reading `enabled` off the ARGUMENTS
      // instead of the row passed this test until the line below was added.
      expect(
        line,
        `${c.name}'s digest describes an ARMED result as dormant: "${line}"`,
      // Only the dormant markers. NOT a blanket /did not/: resume's correct
      // line contains "This did NOT switch any rule on", which is the truthful
      // negative this gate needs, not a sign the rule is dormant.
      ).not.toMatch(/does NOTHING yet|will NOT run|is NOT switched on|was NOT promoted/i);
    });
  }

  // --- ARGS VS RETURN, one per capability where they can diverge -----------

  // The clearest divergence in this gate. promoteEdge (lib/memory/edges.ts)
  // refuses on four paths and returns {promoted:false, reason}. The request
  // named an observation to promote; the outcome is that nothing was promoted.
  it('promoteObservation does not announce a rule the platform refused to create', () => {
    const line = digestFor('promoteObservation')(
      { observationId: 'obs-1' },
      { promoted: false, reason: 'already established' },
    );
    expect(line).toMatch(/NOT promoted/);
    expect(line).toMatch(/already established/);
    expect(line).not.toMatch(/after this turn|will act on it by itself/i);
  });

  // createSocialAutomation's stored daily_cap falls back to 25 when the
  // argument is absent, and migration 040's CHECK is the real bound. The cap
  // the rule will honour is the row's, never the argument's.
  it('createSocialAutomation reports the STORED daily cap, not the requested one', () => {
    const line = digestFor('createSocialAutomation')(
      { platform: 'facebook', externalId: 'page-1', trigger: 'comment_received', action: 'reply', dailyCap: 200 },
      { id: 'rule-1', trigger: 'comment_received', action: 'reply', daily_cap: 25, enabled: false },
    );
    expect(line).toContain('25 actions a day');
    expect(line).not.toContain('200');
    // Created OFF: it must NOT read as something now running.
    expect(line).toMatch(/does NOTHING yet/);
  });

  // An enable that came back with the row still off is a rule that is still
  // dormant, however the call was framed.
  it('enableSocialAutomation believes the row, not the request', () => {
    const line = digestFor('enableSocialAutomation')({ id: 'rule-1' }, { id: 'rule-1', enabled: false, daily_cap: 25 });
    expect(line).toMatch(/NOT switched on/);
    expect(line).not.toMatch(/SWITCHED ON\b/);
  });

  it('enableAutomation believes is_active on the row, not the request', () => {
    const line = digestFor('enableAutomation')(
      { automationId: 'auto-1' },
      { id: 'auto-1', name: 'Tag repliers', is_active: false },
    );
    expect(line).toMatch(/NOT switched on/);
    expect(line).not.toMatch(/is now SWITCHED ON/);
  });

  // Un-pausing the account-level gate is not the same as enabling any rule,
  // and the result says nothing at all about how many are on. Inferring a live
  // fleet here is the same shape as the "went out to all 13 contacts" defect.
  it('resumeAllSocialAutomations does not imply any rule is now live', () => {
    const line = digestFor('resumeAllSocialAutomations')({}, { id: 'acct-1', social_automations_paused: false });
    expect(line).toMatch(/did NOT switch any rule on/i);
    expect(line).toMatch(/says nothing about how many are enabled/i);
  });

  it('resumeAllSocialAutomations reports a row that is still paused as still paused', () => {
    const line = digestFor('resumeAllSocialAutomations')({}, { id: 'acct-1', social_automations_paused: true });
    expect(line).toMatch(/still paused/i);
    expect(line).not.toMatch(/may act by itself again/i);
  });

  // createScheduledTask defaults to ARMED. Reading `enabled` off the arguments
  // would report a stored draft where the row describes an unattended agent
  // loop with a first run already scheduled — and next_run_at exists ONLY on
  // the return, computed by the store.
  it('createScheduledTask reports the row as armed even when the args said otherwise', () => {
    const line = digestFor('createScheduledTask')(
      { name: 'Daily digest', prompt: 'summarise', interval: 'weekly', enabled: false },
      { id: 'task-1', name: 'Daily digest', interval: 'daily', enabled: true, next_run_at: '2026-09-04T06:00:00Z' },
    );
    expect(line).toMatch(/ARMED/);
    expect(line).toContain('2026-09-04T06:00:00Z');
    expect(line).toContain('daily');
    expect(line).not.toContain('weekly');
  });

  it('createScheduledTask reports a row stored OFF as not running', () => {
    const line = digestFor('createScheduledTask')(
      { name: 'Daily digest', prompt: 'summarise', interval: 'daily' },
      { id: 'task-1', name: 'Daily digest', interval: 'daily', enabled: false, next_run_at: '2026-09-04T06:00:00Z' },
    );
    expect(line).toMatch(/will NOT run on its own/);
    expect(line).not.toMatch(/ARMED/);
  });

  it('createAutomation reports is_active from the stored row', () => {
    const line = digestFor('createAutomation')(
      { name: 'Tag repliers', trigger: 'email.replied', action: 'add_tag', config: { tag: 'hot' } },
      { id: 'auto-1', name: 'Tag repliers', trigger: { type: 'email.replied' }, action: { type: 'add_tag', config: { tag: 'hot' } }, is_active: false },
    );
    expect(line).toMatch(/does NOTHING yet/);
    expect(line).toContain('tag them "hot"');
    expect(line).not.toMatch(/fires by itself/);
  });
});
