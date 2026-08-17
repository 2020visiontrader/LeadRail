# PACKET 11.1 — Legal entity, jurisdiction, and AI subprocessor disclosure

**Tier:** A (compliance-facing public documents) · **Branch:** `feat/copilot-remediation`
**Depends on:** nothing.

---

## ⚠ This packet prepares documents for a lawyer. It does not replace one.

The executor is drafting public legal text naming a **real company in a real
jurisdiction**. Nothing here is legal advice, and no one on this project is
qualified to give it. The output is a reviewable draft for Canadian counsel to
approve before it goes live. Say so in the PR description. Do not let anyone
treat "the packet passed review" as "the policy is compliant".

## The problem

`app/privacy/page.tsx` and `app/terms/page.tsx` are real documents (89 and 88
lines) and are correctly public via `PUBLIC_PAGES` in `middleware.ts`. Three
things are wrong or missing:

1. **No legal entity, no jurisdiction.** Neither document names a company or a
   governing law. The privacy contact is a personal Gmail address
   (`aifranckie101@gmail.com`). Terms with no jurisdiction clause are weak, and a
   personal address as contact-of-record fails enterprise diligence.
2. **AI subprocessors are not disclosed at all.** The policy covers connected
   platforms (Facebook, Instagram, email providers) and states that data is not
   sold. It says nothing about the fact that customer CRM content — lead names,
   emails, conversation text — is transmitted to third-party model providers on
   essentially every assistant turn. Packet 8.1's compose pass *increased* this:
   `OBSERVATION` lines carrying real lead data are now sent to whichever model
   serves the turn.
3. **The documents predate the company.** Both say "LeadRail" with no operator
   named behind it.

## The facts to encode

**Operating entity:** Excalix, Toronto, Ontario, Canada.

**Consequences the executor must handle, not gloss:**

- **PIPEDA** is the applicable federal privacy statute. The policy should be
  framed accordingly rather than assuming a US framework.
- **Governing law / jurisdiction:** Ontario, Canada. Terms need a clause.
- **CASL** governs commercial electronic messages sent from or to Canada, and
  this product's core function is outbound email and social outreach. It is
  materially stricter than CAN-SPAM. See the "CASL gap" section below — do NOT
  quietly write policy text that claims a consent posture the product does not
  implement.
- **GDPR / UK GDPR** still apply to EU/UK data subjects regardless of where
  Excalix sits; **Quebec Law 25** applies to Quebec residents. Whether to claim
  coverage is a decision for counsel — surface it, do not decide it.
- **Data residency:** the database is Supabase. Its region determines where
  personal data physically lives and whether a cross-border transfer disclosure
  is required. **Find the actual region before writing anything about it.** If
  it cannot be determined from the repo or env, say so in the report and leave a
  clearly-marked TODO rather than guessing.

## The subprocessor list (verified against the repo, 2026-08-16)

Do not copy this list blindly — re-verify each against the code, and drop any
that is configured-but-unused if you can establish that.

| Purpose | Processor | Where in the repo |
|---|---|---|
| Database, auth, storage | Supabase | `lib/db.ts` |
| LLM — primary | Zo Ask (`api.zo.computer`, BYOK subscription model) | `lib/ai/zoask.ts` |
| LLM — fallback | OpenCode Go (`opencode.ai`, DeepSeek V4 Pro) | `lib/ai/opencode.ts` |
| LLM — last resort | NVIDIA NIM (`integrate.api.nvidia.com`) | `lib/ai/nim.ts` |
| Image generation, embeddings | Google Gemini | `lib/ai/gemini.ts` |
| Transactional / outbound email | Resend, Brevo | `lib/integrations/resend.ts`, `brevo.ts` |
| Lead enrichment | Apollo | `lib/integrations/apollo.ts` |
| Knowledge connectors | Notion, Google Drive | `lib/integrations/notion.ts`, `gdrive.ts` |
| Social | Meta (Facebook/Instagram/Threads), Buffer, Postiz, GoHighLevel | `lib/social/*`, `lib/integrations/postiz.ts` |

**The nuance that must be disclosed, not hidden:** `lib/ai/providers.ts` lets an
account configure **its own** model providers (`openai-compatible`, `anthropic`,
custom endpoints). So the effective subprocessor list is partly customer-chosen.
The policy must say that clearly — a fixed list would be inaccurate the moment a
customer adds a provider. State the default chain, and state that
customer-configured providers are the customer's own processors.

## The CASL gap — report it, do not paper over it

Repo-wide search for consent tracking (`consent`, `opt_in`, `opted_in`,
`lawful_basis`) finds **only OAuth consent screens**. There is no record of a
recipient's consent to be contacted.

What DOES exist: `lib/suppressions.ts`, `app/api/unsubscribe/[token]`, and
retention/purge (`014_privacy_retention.sql`). So the unsubscribe half of CASL is
built; the consent half is not.

**Therefore: do not write policy or terms text asserting that consent is
obtained, recorded, or verified.** Write what is true — that the customer is
responsible for having a lawful basis to contact the people they load, and that
LeadRail provides unsubscribe and suppression. Then **report the gap** so it can
be specced as a product packet (a consent field on contacts, its provenance, and
a send-time check). A policy that overstates the product is worse than no policy.

## Files

**Modify:** `app/privacy/page.tsx`, `app/terms/page.tsx`
**Create:** nothing unless a shared constants module genuinely reduces duplication

Do not touch `middleware.ts` — these pages are already public and must stay so.
Do not change any product behaviour. This packet is text only.

## Steps

1. **Entity + contact.** Name Excalix, Toronto, Ontario, Canada as operator in
   both documents. Replace the personal Gmail with a role address
   (`privacy@…` / `legal@…`). **If no such address exists yet, leave a clearly
   marked TODO and say so in the report — do not invent an address that does not
   receive mail.** A privacy contact that bounces is a compliance failure.
2. **Governing law** clause in Terms: Ontario, Canada.
3. **Subprocessor section** in Privacy: purpose-grouped, naming the default chain,
   plus the customer-configured-provider caveat above. Say plainly that content
   the user submits to the assistant — including CRM records it reads — is sent
   to these providers to generate a response.
4. **PIPEDA framing**, including the access/correction rights it grants and how
   to exercise them. Note the existing retention/purge machinery
   (`014_privacy_retention.sql`, `purgeDueAccounts`) — describe what it actually
   does, not an idealised version.
5. **Update the "last updated" date.** Keep the existing visual structure and
   Tailwind classes; this is a content change, not a redesign.
6. Keep both pages server-rendered and dependency-free as they are now.

## Acceptance criteria

1. `./node_modules/.bin/tsc --noEmit` and `npm run build` pass.
2. Both pages remain publicly reachable (unchanged `PUBLIC_PAGES`).
3. No claim is made about consent capture that the product does not implement.
4. Every named subprocessor is traceable to real code in the repo.
5. No invented address, entity number, or registration detail. Unknowns are
   explicit TODOs, not plausible-looking filler.
6. Zero product-behaviour changes.

## Reviewer checklist (human + counsel — do not self-certify)

- [ ] **Canadian counsel has read both documents before deploy.**
- [ ] Every factual claim about data handling matches what the code does.
- [ ] The CASL consent gap is reported, not papered over.
- [ ] The privacy contact address actually receives mail.
- [ ] Supabase region confirmed, and any cross-border transfer stated correctly.
- [ ] The customer-configured-provider caveat is present and accurate.
