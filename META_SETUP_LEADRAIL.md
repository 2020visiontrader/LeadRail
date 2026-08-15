# LeadRail — Meta (Facebook/Instagram) Setup Tracker

Goal: users connect their own FB Page + IG Business account so LeadRail can **publish posts, read insights, manage comments**. Feature code is already built; this tracker covers the Meta-dashboard side only.

## Verified facts (2026-08-03)

| Item | Value |
|---|---|
| Live site | https://leadrail-crm-aifranckie.zocomputer.io |
| Privacy policy | https://leadrail-crm-aifranckie.zocomputer.io/privacy |
| Data deletion | https://leadrail-crm-aifranckie.zocomputer.io/data-deletion |
| **Valid OAuth Redirect URI** (paste into Meta) | https://leadrail-crm-aifranckie.zocomputer.io/api/social/meta/callback |
| Graph version in code | v18.0 (aging — plan bump to current, see Phase 5) |
| Scopes requested by code | pages_show_list, pages_read_engagement, pages_manage_posts, instagram_basic, instagram_content_publish |
| Env vars needed on the deployment | META_APP_ID, META_APP_SECRET (optional APP_BASE_URL override) |
| Code | lib/social/meta-oauth.ts · app/api/social/meta/{connect,callback,publish,insights,comment,comments} · app/api/webhooks/meta |

## Phase 1 — Account + App (no business docs needed)
- [ ] Personal FB account, real name, email+phone confirmed
- [ ] Enable 2FA (Accounts Center → Password & security)
- [ ] Register at developers.facebook.com
- [ ] Create Business Portfolio at business.facebook.com (name = future legal-verification anchor)
- [ ] Create App (My Apps → Create App) → type Business → link Business Portfolio → app stays in **Development mode**

## Phase 2 — Facebook Login for Business + credentials
- [ ] Add product: **Facebook Login for Business**
- [ ] Settings → register Valid OAuth Redirect URI (exact value above)
- [ ] App Settings → Basic: set Privacy Policy URL + Data Deletion URL (values above), App Domain = leadrail-crm-aifranckie.zocomputer.io
- [ ] Copy App ID + App Secret → set as `META_APP_ID` / `META_APP_SECRET` secrets on the LeadRail deployment
- [ ] Redeploy; confirm `metaEnabled()` true

## Phase 3 — Test in Dev Mode (works TODAY, no verification)
- [ ] Add yourself/teammates as App Roles (Admin/Tester)
- [ ] Run the connect flow end-to-end with a real Page + IG business account you control
- [ ] Verify publish + insights + comments succeed
- [ ] Screen-record each scope in use (required for review)

## Phase 4 — App Review + Business Verification (to let real users connect)
- [ ] Complete Business Verification (sole-proprietor or entity — see business-structure note)
- [ ] Request Advanced Access for: pages_show_list, pages_read_engagement, pages_manage_posts, instagram_basic, instagram_content_publish (+ likely business_management for Business-Portfolio-owned Pages)
- [ ] Submit screencasts + step-by-step reviewer instructions with test Page/IG
- [ ] Switch app to **Live mode** only after approval
- Note: 2026 review ~20 days; start verification early.

## Phase 5 — Hardening (post-launch)
- [ ] Bump Graph version from v18.0 to current in lib/social/meta-oauth.ts (v18.0 nearing deprecation)
- [ ] Add long-lived-token refresh + reconnection UX
- [ ] Webhook signature verification on app/api/webhooks/meta

## The one gotcha
Legal name must match EXACTLY across Business Portfolio, verification docs, and the site footer. Mismatch is the #1 review rejection.
