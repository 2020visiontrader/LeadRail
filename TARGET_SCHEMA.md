# Target CRM Schema — Source of Truth

Multi-tenant marketing CRM. Everything scoped `account_id` (tenant) + `brand_id` (venture).
Admin/account-scoped, RLS on every table, server uses the service-role key.
BDB Productions (`00000000-0000-0000-0000-0000000000b1`) is the seeded enterprise account.

Model translated from the Salesforce 30-object standard, trimmed to what an
outbound-marketing + content + campaigns CRM actually uses. Products/CPQ omitted.

## Status legend
- ✅ live — in migrations 001–004, applied to Supabase
- 🆕 005 — Wave 1, migration `005_crm_objects.sql`
- 🔭 Wave 2 — specced here, NOT migrated until a feature uses it

---

## System / Tenancy
| Table | Purpose | Status |
|---|---|---|
| `accounts` | Tenant | ✅ |
| `account_members` | Tenant membership | ✅ |
| `users` | Auth users | ✅ |
| `brands` | Ventures | ✅ |
| `integration_connections` | Connected APIs per account | ✅ |

## Core: People & Organizations
| Table | Purpose | Status |
|---|---|---|
| `companies` | Organization (SF Account) | 🆕 005 |
| `contacts` (+ `company_id`) | People, linked to a company | ✅ + 🆕 column |
| `contact_company_roles` | Contact ↔ many companies w/ role | 🔭 Wave 2 |

## Sales Pipeline
| Table | Purpose | Status |
|---|---|---|
| `pipeline_stages` | Per-account/venture stage config | 🆕 005 (seeded: New→Outreaching→Replied→Qualified→Won→Lost) |
| `deals` | Opportunity / revenue pursuit | 🆕 005 |
| `deal_contact_roles` | Contacts on a deal | 🆕 005 |

## Activities
| Table | Purpose | Status |
|---|---|---|
| `activities` | Polymorphic task/call/meeting/email/event | 🆕 005 (retires thin `contact_events`) |
| `notes` | Freeform notes on any record | 🆕 005 |
| `attachments` | Files on any record | 🆕 005 |

## Marketing
| Table | Purpose | Status |
|---|---|---|
| `ad_campaigns` | Campaign (paid + organic) | ✅ |
| `campaign_members` | Contacts in a campaign | 🆕 005 |

## Territory & Team
| Table | Purpose | Status |
|---|---|---|
| `territories` | Region/segment assignment | 🆕 005 |
| `partners` | Channel/partner relationships | 🔭 Wave 2 |

## Service & Support
| Table | Purpose | Status |
|---|---|---|
| `cases` | Support tickets | 🔭 Wave 2 |
| `knowledge_articles` | Reusable answers | 🔭 Wave 2 |
| `entitlements` | SLA per company | 🔭 Wave 2 |

## Data Governance
| Table | Purpose | Status |
|---|---|---|
| `audit_log` | Every import/enrich/merge/edit | 🆕 005 |
| `contact_merges` | Dedup with merge lineage | 🆕 005 |
| `contact_aliases` | Alternate identities kept | 🆕 005 |

## Marketing engine (already ahead of vanilla CRM)
`sequences` · `sequence_steps` · `sequence_enrollments` · `message_templates` ·
`email_accounts` · `inbox_messages` · `content_calendar` · `campaign_assets` · `apollo_searches` — all ✅

---

## Wave 2 trigger conditions
Migrate the 🔭 tables only when the paired feature is built:
- `cases` / `knowledge_articles` / `entitlements` → when a support-desk workflow exists
- `partners` → when a channel/partner program exists
- `contact_company_roles` → when a contact needs multiple company affiliations (B2B multi-org)

## Next after 005 lands
Data-layer helpers + routes for companies, deals/pipeline, activities/notes — then wire into the frontend (design untouched until unlocked).
