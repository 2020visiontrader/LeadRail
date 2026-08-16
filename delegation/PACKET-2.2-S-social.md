# PACKET 2.2-S — Social capabilities for the assistant

**Tier:** A (tenant scoping + outbound sends) · **Branch:** `feat/copilot-remediation`
**Depends on:** Packet 2.1 (Capability Registry core) merged.
**Parent plan:** `COPILOT_REMEDIATION_PLAN.md` — read §2 and §7 before starting.

---

## Executor preamble (obey exactly)

You are an executor. Implement EXACTLY this packet against the repo at `/Users/franckiemacair/Desktop/LeadRail`.

1. Touch ONLY the files under **Files**. If you believe another file must change, STOP and report why — do not change it.
2. Do not rename exported symbols, change existing function signatures, or alter DB column names unless told to.
3. Preserve the existing comment style: explain WHY, mark additive changes as additive.
4. After editing run `npx tsc --noEmit && npm run build`. Paste both outputs.
5. Output a unified diff of every file changed. No summary prose.
6. If any instruction is ambiguous, STOP and ask ONE question. Do not guess.

---

## Goal

The assistant can operate the account's connected social accounts across the **full Meta scope** — read and write, posting, comments, message responses, automations, and ads — **strictly within the authenticated account's scope**, with every outbound action gated behind human approval.

---

## CRITICAL: platform coverage is registry-driven, not hardcoded

`lib/social/providers.ts` is the single source of truth for which platforms exist and which are usable:

- `live: true` today — **facebook, instagram, threads** (OAuth connect + callback routes exist under `app/api/social/`)
- `live: false` today — **linkedin, tiktok, x** (registry rows only; no OAuth, no env keys, no client). Their OAuth ships in Packet 7.1.

**Therefore: never hardcode a platform list.** Derive every platform check from `LIVE_SOCIALS` / `SOCIAL_PROVIDERS`. When Packet 7.1 flips `live: true` for LinkedIn, TikTok, and X, these capabilities must pick them up with **zero changes to this file**.

Concretely:
```ts
import { LIVE_SOCIALS, type SocialKey } from '@/lib/social/providers';

const livePlatforms = () => LIVE_SOCIALS.map((p) => p.key);

// zod: validate against the LIVE registry at call time, not a frozen enum.
platform: z.string().refine((v) => livePlatforms().includes(v as SocialKey),
  { message: 'That platform is not connected yet.' })
```

Publishing dispatch must be a **lookup keyed by platform**, not an if/else chain, so adding a platform is adding one map entry:
```ts
const PUBLISHERS: Partial<Record<SocialKey, Publisher>> = {
  facebook: (accountId, a) => publishToFacebookPage(accountId, {...}, a.accountExternalId),
  instagram: (accountId, a) => publishToInstagramForAccount(accountId, {...}, a.accountExternalId),
  // threads / linkedin / tiktok / x added here as their publishers land.
};
const pub = PUBLISHERS[a.platform];
if (!pub) throw new Error(`Publishing to ${a.platform} isn't available yet.`);
```
If a platform is `live: true` but has no `PUBLISHERS` entry, the error above is the correct, honest behaviour — the model then tells the user rather than silently doing nothing.

---

## Context (already true in the repo — do not re-derive)

**Connected accounts** live in `integration_connections` (migration `020_multi_social_connections.sql`), keyed `(account_id, provider, external_id)` with `display_name` and `username`. Genuinely multi-account: one row per connected Page / IG Business account / Threads profile. Read via `getConnections(accountId)` and `getConnection(accountId, provider, externalId?)` from `@/lib/db`.

**Existing account-scoped service functions — use these, do not write new Graph API calls:**
- `lib/integrations/meta.ts` — `publishToInstagramForAccount`, `publishToFacebookPage`, `getInstagramInsights`, `getMetaCreds`
- `lib/social/meta-engagement.ts` — `getComments`, `replyToComment`, `hideComment`, `deleteComment`, `sendInstagramMessage` (all take `accountId` first)
- `lib/social/meta-ads.ts` — `listAdAccounts`, `getInsights`, `getInsightsByLevel`, `updateStatus`, `createCampaign`, `createAdSet`, `createAdCreative`, `createAd`, `uploadAdImage`, `uploadAdVideo`
- `lib/social/index.ts` — `getIntegrations(accountId)`
- `lib/ai/generation.ts` — `generateContentPost`

**Ads are largely already covered** by existing capabilities ported in Packet 2.1 (`listCampaigns`, `getCampaign`, `listAdSets`, `listAds`, `listAssets`, `importAsset`, `createCampaign`, `launchCampaign`, `pauseCampaign`, `syncCampaign`, `analyzeCampaign`, `getInsights`, `listAdAccounts`). **Do not duplicate them.** Only add the two gaps listed in Step 1c.

---

## ⚠ Known defect — do NOT paper over it

`lib/social/buffer.ts` and `lib/social/ghl.ts` authenticate from **global env vars** (`BUFFER_API_KEY`, `GOHIGHLEVEL_ACCESS_TOKEN`). They are not account-scoped: `getChannels(orgId?)` and `getSocialAccounts(locationId)` return the SAME data for every tenant.

**Required handling** — guard every Buffer/GHL capability:

```ts
// Buffer/GHL are single-tenant today (global env credentials — see lib/social/buffer.ts).
// Exposing them to the agent unscoped would leak one account's channels to another,
// so a capability only runs when THIS account has its own connection row.
const conn = await getConnection(accountId, 'buffer');
if (!conn) throw new Error('Buffer is not connected for this account.');
```

Do **not** "fix" `buffer.ts`/`ghl.ts` here — per-account credential storage is Packet 7.2. Refuse safely and leave the comment. If you believe the guard is impossible, STOP and report.

---

## Files

**Create:** `lib/capabilities/social.ts`, `lib/capabilities/social-automations.ts`, `migrations/042_social_automations.sql`

**Modify:**
- `lib/capabilities/types.ts` — add the `standing_rule` gate class (Step 2)
- `lib/capabilities/registry.ts` — register both arrays
- `src/components/AgentConsole.tsx` — `TOOL_VERB` entries
- `lib/agent/context.ts` — connected-social grounding (Step 4)

Do **not** touch `lib/social/*`, `lib/integrations/meta.ts`, or any route under `app/api/social/`.

---

## Step 1 — `lib/capabilities/social.ts`

Export `export const SOCIAL_CAPABILITIES: Capability[]`, following `lib/capabilities/types.ts` exactly. Every `run(accountId, args)` MUST pass `accountId` to its backing function.

### 1a. Accounts, reading, drafting

| name | gate | args | backing call |
|---|---|---|---|
| `listSocialAccounts` | `read` | `platform?` | `getConnections(accountId)`, filtered `status==='connected'` + live providers |
| `getSocialStatus` | `read` | — | `getIntegrations(accountId)` |
| `listSocialComments` | `read` | `postId`, `platform` | `getComments(accountId, …)` |
| `getSocialInsights` | `read` | `mediaId` | `getInstagramInsights(…)` with account creds |
| `draftSocialPost` | `read` | `platform`, `topic`, `brandId?`, `hook?`, `cta?` | `generateContentPost(…)` — returns copy, publishes nothing |

### 1b. Outbound — every one of these is `external_send`

| name | args | backing call |
|---|---|---|
| `publishSocialPost` | `platform`, `accountExternalId?`, `message?`, `imageUrl?`, `videoUrl?`, `link?` | `PUBLISHERS[platform]` dispatch map |
| `replyToSocialComment` | `commentId`, `message` | `replyToComment(accountId, …)` |
| `hideSocialComment` | `commentId`, `hide?` | `hideComment(accountId, …)` |
| `deleteSocialComment` | `commentId` | `deleteComment(accountId, …)` — gate `destructive` |
| `sendSocialMessage` | `platform`, `recipientId`, `text` | `sendInstagramMessage(accountId, …)`; dispatch map like publishers |
| `scheduleSocialPost` | `platform`, `text`, `dueAt`, `channelId` | Buffer — behind the guard above |
| `listScheduledSocialPosts` | `status?`, `limit?` | Buffer — behind the guard (gate `read`) |

### 1c. Ads — ONLY these two gaps (everything else already exists)

| name | gate | args | backing call |
|---|---|---|---|
| `getAdBreakdown` | `read` | `metaObjectId`, `level` (`campaign`\|`adset`\|`ad`) | `getInsightsByLevel(…)` |
| `setAdStatus` | `external_send` | `metaObjectId`, `status` (`ACTIVE`\|`PAUSED`) | `updateStatus(…)` |

`setAdStatus` with `ACTIVE` resumes spend — it is `external_send`, not `internal_write`. Say so in the `summarize`.

### Rules — non-negotiable

- **Anything reaching a real audience is `external_send`.** Publish, reply, hide, DM, schedule, resume-ads. A scheduled post is still a real send — do not downgrade it because it is deferred.
- `draftSocialPost` produces copy only and is `read`. It must never publish.
- **Multi-account:** `publishSocialPost` and `sendSocialMessage` take `accountExternalId` (the `integration_connections.external_id`). Never default to "the first connected account." If omitted and >1 connection exists for that platform, throw `Error('Multiple <platform> accounts are connected — specify which one.')` so the model asks the user. If exactly one exists, use it.
- **Instagram constraint:** IG requires `imageUrl` or `videoUrl`. Validate in `zod`, matching the existing check in `app/api/social/meta/publish/route.ts`.
- **Descriptions are written for a model, not a developer** — plain language, when to use it, no internal vendor or function names.
- **Every `external_send` and `destructive` capability needs a `summarize`** so the approval card reads well, e.g. `` (a) => `Publish this post to ${a.platform} (${a.accountExternalId}). It goes live immediately.` ``

---

## Step 2 — New gate class: `standing_rule`

Automations are a different risk class from a single send. Approving "publish this post" authorises one action. Approving "auto-reply to every comment matching X" authorises an unbounded number of future sends with no further human in the loop — and the existing gates cannot express that.

Add to `lib/capabilities/types.ts`:

```ts
export type GateClass =
  | 'read'
  | 'internal_write'
  | 'spend'
  | 'external_send'
  | 'destructive'
  | 'standing_rule';   // creates/enables a rule that will send on its own, repeatedly, without further approval

export const SENSITIVE_GATES: GateClass[] =
  ['spend', 'external_send', 'destructive', 'standing_rule'];
```

`standing_rule` is sensitive like the others (so `isSensitive` and the approval gate work unchanged), but its `summarize` MUST state the ongoing nature and the caps. This is additive — no existing capability uses it.

---

## Step 3 — `lib/capabilities/social-automations.ts` + migration 042

**Migration `042_social_automations.sql`** — idempotent, matching the style of `028_approvals.sql`:

```
social_automations
  id UUID PK DEFAULT gen_random_uuid()
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE
  platform TEXT NOT NULL              -- validated against SOCIAL_PROVIDERS in code
  external_id TEXT NOT NULL           -- which connected account this rule runs for
  trigger TEXT NOT NULL               -- 'comment_received' | 'dm_received' | 'mention'
  match JSONB NOT NULL DEFAULT '{}'   -- {keywords:[], regex?}
  action TEXT NOT NULL                -- 'reply' | 'hide' | 'notify' | 'tag_lead'
  template TEXT                       -- reply body, when action='reply'
  daily_cap INT NOT NULL DEFAULT 25   -- HARD upper bound on sends per day
  sends_today INT NOT NULL DEFAULT 0
  last_reset_at DATE
  enabled BOOLEAN NOT NULL DEFAULT false   -- created DISABLED; enabling is its own approval
  created_at / updated_at TIMESTAMPTZ
  CONSTRAINT social_automations_cap_check CHECK (daily_cap > 0 AND daily_cap <= 200)
```
RLS enabled, no anon policies (service-role bypass, app scopes by `account_id` in code) — same convention as 028.

**Capabilities** (`SOCIAL_AUTOMATION_CAPABILITIES`):

| name | gate | notes |
|---|---|---|
| `listSocialAutomations` | `read` | account-scoped list |
| `createSocialAutomation` | `standing_rule` | **always inserts `enabled: false`** |
| `enableSocialAutomation` | `standing_rule` | the real gate — flipping it on is a separate approval |
| `disableSocialAutomation` | `internal_write` | turning something OFF is always safe and never needs approval |
| `deleteSocialAutomation` | `destructive` | |

**Mandatory safety properties:**
1. A rule is **created disabled.** Creation and activation are two separate approvals. A single approval must never result in a live auto-sender.
2. `daily_cap` is enforced **at send time**, not just stored. The runner increments `sends_today`, resets on date change, and stops at the cap.
3. `summarize` for `enableSocialAutomation` must read like: `` `Turn ON an automatic rule: reply to ${trigger} matching "${keywords}" on ${platform}. Once on, this sends without asking you again, up to ${daily_cap} times a day.` ``
4. **Do not build the runner in this packet.** These capabilities manage rule *records* only. The execution runner (webhook-driven, honouring the cap) is Packet 7.3. A rule that exists but never fires is safe; a rule that fires without a cap is not.

---

## Step 4 — Grounding

In `lib/agent/context.ts`, inside `loadAgentContext`, add a section after ACCOUNT SNAPSHOT. Follow the existing pattern — wrap in `try { } catch { /* section omitted */ }` so a failure never breaks a turn.

```
CONNECTED SOCIAL ACCOUNTS:
- Instagram: @<username> (id: <external_id>)
- Facebook Page: <display_name> (id: <external_id>)
Active automations: 2 (see listSocialAutomations)
```

Cap at 15 lines. Omit the whole section when nothing is connected — do not emit an empty header. Read via `getConnections(accountId)`, filtered to `status === 'connected'` and live providers. **Never include tokens or `secret_ref` values.**

## Step 5 — `TOOL_VERB`

Add a present-tense plain-language verb per new name in `src/components/AgentConsole.tsx`, matching the existing style. E.g. `listSocialAccounts: 'Checking your connected social accounts'`, `publishSocialPost: 'Preparing to publish your post'`, `enableSocialAutomation: 'Preparing to switch on an automatic rule'`.

---

## Acceptance criteria

1. `npx tsc --noEmit` and `npm run build` both pass.
2. No platform string is hardcoded outside the `PUBLISHERS` / dispatch maps — platform validity is read from `LIVE_SOCIALS` at call time. Flipping `linkedin` to `live: true` in `providers.ts` must require **zero edits** to `social.ts` for it to be accepted as a platform argument.
3. Every `external_send`, `destructive`, and `standing_rule` capability yields `sensitive: true` in the derived `TOOLS` map. Assert `TOOLS.publishSocialPost.sensitive === true` and `TOOLS.enableSocialAutomation.sensitive === true`.
4. `createSocialAutomation` cannot produce an enabled rule — grep the insert for `enabled: false`.
5. `disableSocialAutomation` is NOT sensitive.
6. No capability calls a Graph API endpoint directly.
7. Zero `supabase.from(` calls in the new files lacking `.eq('account_id', accountId)`.
8. Buffer/GHL capabilities refuse cleanly with no per-account connection row.
9. `publishSocialPost` with an ambiguous account throws rather than picking one.
10. Ads capabilities beyond `getAdBreakdown` and `setAdStatus` were NOT re-added.

## Reviewer checklist (human/architect — do not self-certify)

- [ ] Each sensitive capability cannot execute without `consumeApprovalForExecution` (Packet 0.1).
- [ ] No `catch {}` swallows an authorization failure — silent-catch is for best-effort writes only, never a gate.
- [ ] Platform handling is registry-driven; adding LinkedIn later touches `providers.ts` + one map entry, nothing else.
- [ ] Automation creation and activation are genuinely two approvals.
- [ ] `daily_cap` has a DB-level CHECK, not just app validation.
- [ ] Multi-account disambiguation throws rather than defaulting.
- [ ] Nothing under `lib/social/` or `app/api/social/` was modified.
- [ ] Grounding degrades silently and leaks no credentials.
