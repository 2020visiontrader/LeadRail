# Marketing Agency OS — Platform Spec (v1)

Source of truth for the multi-venture lead + outreach + content + ads platform.
Design/visual polish is deliberately **out of scope** here — this doc defines data model,
back-end logic, API surface, and front-end wiring only.

## 1. Tenancy model

```
account (tenant)              -- e.g. "BDB Productions" (our team, enterprise, seeded)
  └─ account_members          -- user ↔ account, role (owner/admin/member)
  └─ ventures (= brands)      -- FilmOps, RetentionRail, Rentahub (seeded for our team)
       └─ leads (contacts)    -- venture-scoped
       └─ sequences, content, campaigns, templates ...
  └─ integration_connections  -- per-account creds: apollo, brevo, meta, google, social, email
```

- **Our team** is seeded as one `account` (BDB Productions, plan=enterprise) with our real ventures.
  Our real Apollo leads are pulled in via the Apollo connector once Apollo is authorized — **not**
  fabricated in seed.
- **Any outside user** signs up → creates their own `account` → creates their own ventures →
  connects their own Apollo/Brevo/Meta/etc. Nothing of ours is visible to them (RLS by `account_id`).
- Every data table carries `account_id` (tenant boundary) and, where relevant, `venture_id`.

## 2. Modules → data / logic / API / front-end

| Module | Data | Back-end logic | API | Front-end logic |
|--------|------|----------------|-----|-----------------|
| **Dashboard / Overview** | reads across venture | aggregate counts/KPIs per active venture | `GET /api/overview?venture=` | venture switcher sets active venture; KPIs refetch |
| **Leads** | `contacts` (+ enrichment cols), `apollo_searches` | Apollo connector: describe ICP (industry, title, size, geo) → Apollo API → import as leads | `POST /api/leads/apollo/search`, `GET/POST /api/leads` | search form (industry/title/etc.) → results → "import selected" |
| **Enrichment** | `contacts.enriched` jsonb, `enrichment_status` | for a selected list, fetch deeper profile (who they are, fit score, worth-it verdict) | `POST /api/leads/enrich` (batch by ids) | pick list → "Enrich" → per-lead enrichment panel + fit verdict |
| **Sequences** | `sequences`, `sequence_steps`, `sequence_enrollments` | AI-generate outreach emails; enroll leads; send via Brevo/Resend; track open/read/reply | `GET/POST /api/sequences`, `POST /api/sequences/:id/enroll`, `POST /api/sequences/:id/generate` | build steps, generate copy, enroll leads, live status (opened/replied) |
| **Templates** | `message_templates` | reusable subject+body by category; insert into a sequence step | `GET/POST /api/templates` | pick template → add to sequence |
| **Inbox** | `email_accounts`, `inbox_messages` | connected mailbox sync (IMAP/OAuth); all sent + replies land here per account | `GET /api/inbox`, `POST /api/inbox/accounts` | unified thread list; reply |
| **Content** | `content_posts` (white-label) | AI content-calendar gen for the venture's niche; schedule → post to each social platform. **Never** surfaces the underlying scheduler/source name — posts as the user's own | `GET/POST /api/content`, `POST /api/content/generate`, `POST /api/content/:id/schedule` | calendar; generate captions (hooks/CTA); upload own media; pick platforms |
| **Campaigns** | `ad_campaigns`, `campaign_assets` | connect Meta / Google Ads; pull analytics; asset library (static images **and** video); AI runs auto-post/schedule + analyzes/cleans assets | `GET/POST /api/campaigns`, `GET /api/campaigns/:id/analytics`, `POST/GET /api/campaigns/:id/assets` | campaign builder; analytics; asset grid; "let AI run it" toggle |
| **Settings** | `integration_connections`, `email_accounts` | connect/disconnect social accounts, Apollo, Brevo, Meta, Google; bring-your-own Apollo key | `GET/POST/DELETE /api/integrations` | connection cards with real status |

## 3. Credential map (what unblocks each module)

| Provider | Secret / auth | Unblocks | Status |
|----------|---------------|----------|--------|
| Apollo.io | `APOLLO_API_KEY` (Zo secret) or authorize Apollo MCP connector | Leads search + import, enrichment | **needs auth** |
| Brevo **or** Resend | `BREVO_API_KEY` / `RESEND_API_KEY` | Sequences send + open/reply tracking | needs key |
| Meta (FB/IG) | `META_ACCESS_TOKEN` + ad account id | Campaigns (Meta), IG posting | needs key |
| Google Ads | OAuth + `GOOGLE_ADS_*` | Campaigns (Google) analytics | needs key |
| Social scheduler | per-platform OAuth | Content posting to platforms | needs OAuth |
| Email (inbox) | IMAP or Gmail/Outlook OAuth | Inbox sync | needs OAuth |

Until a provider is connected, its module renders real UI + a "Connect {provider}" state.
No fabricated "live" data.

## 4. Build sequence

1. **Foundation (this turn):** `004_multitenant.sql` (accounts, members, integration_connections,
   enrichment cols, sequences/steps/enrollments, templates, email_accounts, inbox_messages,
   campaign_assets, RLS, seed BDB account + ventures) + reconciled `types.ts`.
2. Data layer + auth context (`account_id`/`venture_id` scoping) + integrations CRUD route.
3. Apollo connector + `/api/leads/apollo/search` + enrichment route.
4. Sequences engine (generate + enroll + send + tracking).
5. Templates + Inbox.
6. Content (generate + white-label schedule).
7. Campaigns + assets + analytics + AI-run.
8. Front-end logic wiring per module (venture switcher, forms, actions, live status). Design pass last.

## 5. Verification gate

Every step: `tsc --noEmit` + `next build` green. Runtime DB behavior verified only after
Supabase migrations are applied (`001→002→003→004`).
