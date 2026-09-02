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

import { describe, it, expect } from 'vitest';
import { CAPABILITIES } from '@/lib/capabilities/registry';
import type { Capability } from '@/lib/capabilities/types';

/** Every registered capability whose false claim costs money or reaches a real
 *  person. Read from the registry, never listed by hand. */
const costly = (): Capability[] =>
  CAPABILITIES.filter((c) => c.gate === 'external_send' || c.gate === 'spend');

describe('every capability that spends or sends declares a digest', () => {
  it('the gated set is non-empty (a registry that failed to load would vacuously pass)', () => {
    // Without this, an import cycle that left CAPABILITIES undefined-or-empty
    // — a real failure mode in this repo, see the SCHEDULED_CAPABILITIES note
    // in lib/capabilities/registry.ts — would turn the guard below into a test
    // that asserts nothing at all.
    expect(costly().length).toBeGreaterThanOrEqual(12);
  });

  it('none of them is missing one', () => {
    const missing = costly().filter((c) => typeof c.digest !== 'function').map((c) => `${c.gate}:${c.name}`);
    expect(missing).toEqual([]);
  });
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
