# Marketing OS — SEED Build Spec (Wiring Everything)

**Seeded:** 2026-07-31 · **Owner:** LeadRail → Marketing OS (multi-product)
**Source of truth for:** AI routing ladder, social lock-in, Charlie-skill integration order.
**Status legend:** ✅ live · 🟡 coded, unconfigured (needs key) · 🔴 not built yet

---

## 0. Secret inventory (grounded in live service env `leadrail-crm`)

| Secret | State | Powers |
|---|---|---|
| `ZO_Api_Key`, `ZO_CLIENT_IDENTITY_TOKEN` | ✅ present | Ask Zo (BYOK Haiku primary) |
| `NVIDIA_API_KEY` | ✅ present | NIM (last-resort tier) |
| `Gemini_api_key` | ✅ present | Images (Nano Banana) |
| `BUFFER_API_KEY` | ✅ present | Buffer social |
| `RESEND_API_KEY` (domain `filmopsai.com` verified) | ✅ present | Email primary |
| `BREVO_API_KEY` | ✅ present | Email fallback |
| `Apollo_Api_Key` | ✅ present | Lead sourcing |
| `OPENCODE_API_KEY` | 🟡 MISSING | Tier-2 model (OpenCode Go) |
| `POSTIZ_API_KEY` | 🟡 MISSING | Postiz social |
| `META_APP_SECRET` + `META_VERIFY_TOKEN` | 🟡 MISSING | Meta social + webhooks |
| `RESEND_SENDER_EMAIL` | 🟡 MISSING | Email from-address (else sandbox 403) |

**Action for user:** add the 4 missing secrets in Zo → Settings → Advanced. Everything else is ready.

---

## 1. AI Routing Ladder (Hermes-orchestrated)

Hermes is the decision layer: given a task (copy, classify, extract, image, long-run), it picks the route. Default text ladder, in order, with automatic failover on error/timeout/credits:

```
              ┌─────────────── HERMES (orchestrator) ───────────────┐
              │ decides: which tier, which agent, image vs text     │
              └──────────────────────┬──────────────────────────────┘
   TEXT ladder (failover on error)   │            IMAGE
   1. Ask Zo → BYOK Claude Haiku  ◀──┤            Gemini (Nano Banana)
      byok:d49f5f12-5edf-4121-8079-a34a9077ae77
   2. OpenCode Go (deepseek-v4-pro)  │
   3. NVIDIA NIM (meta/llama, deepseek-r1)  ── last resort
```

### Build tasks
- 🔴 **New:** `lib/ai/zoask.ts` — Zo Ask client. `POST https://api.zo.computer/zo/ask`, `Authorization: Bearer $ZO_Api_Key` (or `ZO_CLIENT_IDENTITY_TOKEN`), body `{ input, model_name: "byok:d49f5f12-…", output_format? }`. Exposes `zoAskText()` / `zoAskChat()` mirroring the `opencode.ts` signature so it's a drop-in.
- 🔴 **New:** `lib/ai/router.ts` — `generateTextRouted(msgs, opts)` tries Haiku → OpenCode → NIM in order, catching each tier's error and falling through. Emits which tier served (for telemetry).
- 🔴 **New:** `lib/ai/nim.ts` — NIM client (`$NVIDIA_API_KEY`, base `https://integrate.api.nvidia.com/v1`, model `meta/llama-3.1-8b-instruct` default, `deepseek-ai/deepseek-r1` for reasoning).
- 🟡 **Rewire:** `lib/ai/generation.ts` + `lib/ai/hermes.ts` to call `generateTextRouted` instead of OpenCode directly.
- ✅ **Keep:** `lib/ai/gemini.ts` for all image generation.

---

## 2. Social Lock-In (3 channels)

| Channel | Code | Key | To do |
|---|---|---|---|
| Buffer | `lib/social/buffer.ts` ✅ | ✅ | Verify profile IDs, expose in Settings, smoke-post |
| Postiz | `lib/integrations/postiz.ts` ✅ | ❌ | Add `POSTIZ_API_KEY`, set webhook secret, smoke-post |
| Meta | `lib/integrations/meta.ts`, `lib/social/meta-*` ✅ | ❌ | Add `META_APP_SECRET`+`META_VERIFY_TOKEN`, connect page, verify webhook HMAC |

A single `lib/social/index.ts` dispatcher already exists — confirm it fans a post out to all 3 connected channels and records status per channel.

---

## 3. Charlie Skills Integration Order

Source: `Datasets/marketing-os-arsenal` (46 catalogued, 24 cloned). Wire the 🟢 clean-ports first; they need no desktop/Chrome deps and run on our Zo + NIM routing.

**Wave 1 (🟢 clean, high value):**
- Go Viral Bro — trend→hook research (CONTENT)
- Nano Banana — already our image path (CONTENT)
- SEED → PAUL → CARL → SkillSmith — orchestration/build loop (ORCHESTRATION)
- Graphify — memory graph (BRAIN)
- Cold Outbound — leadgen (LEADGEN, needs Smartlead/Prospeo keys later)
- UI-UX-Pro-Max / Open Design — design (DESIGN)

**Wave 2 (🟡 needs MCP/API rewire):** Advertising Ops, UGC Factory, Carousel Builder (Higgsfield + Canva MCP), Claude Skill Social Post.

**Deferred (🔴 hard dep):** LinkedIn Automation (Chrome ext), ACE-Step (local GPU). Do not attempt on Zo.

Other APIs (Smartlead, Prospeo, Higgsfield, Canva MCP) — sorted out when their wave lands, not blocking now.

---

## 4. Build Phases (delegated execution per routing rule)

1. **P1 — AI ladder:** zoask.ts + nim.ts + router.ts, rewire generation/hermes. Verify: force each tier's failure, confirm failover. *(unblocks nothing external — build now)*
2. **P2 — Email:** set `RESEND_SENDER_EMAIL`, restart, live send to a real address.
3. **P3 — Social:** add Postiz + Meta keys, smoke-post to all 3.
4. **P4 — Charlie Wave 1:** register skills in `lib/skills/registry.ts`, expose via Hermes.
5. **P5 — Charlie Wave 2** + later APIs.

Each phase: build-verify (`tsc` + `next build`) → smoke test → commit on `feat/crm-dashboard-and-pipeline-fixes`.
