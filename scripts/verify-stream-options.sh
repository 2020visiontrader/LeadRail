#!/usr/bin/env bash
#
# verify-stream-options.sh
#
# Confirms whether `stream_options: { include_usage: true }` — sent on the
# streaming chat path for opencode, nim, huggingface and openrouter (see
# lib/ai/opencode.ts, lib/ai/nim.ts, lib/ai/huggingface.ts,
# lib/ai/openrouter.ts) — actually causes a real endpoint to return a usage
# block. This has never been exercised against live providers: the dev
# sandbox has no provider keys and its egress proxy blocks all five provider
# hosts (BACKLOG.md §4). This script closes that gap from anywhere with real
# keys and live egress.
#
# zoask (lib/ai/zoask.ts) is intentionally reported as SKIPPED, not tested:
# it calls a single non-streaming `/zo/ask` endpoint and never sends
# `stream` or `stream_options` in this codebase at all, so there is nothing
# to verify for it — it is listed only so its absence from the summary is
# explained rather than silent.
#
# USAGE
#   Export whichever provider keys you actually have real values for (any
#   subset — missing keys are skipped cleanly, not treated as failures), then
#   run this script directly. Nothing here writes to your shell history by
#   itself, but exporting secrets on a command line is generally visible to
#   anyone with `ps` access on the same machine — prefer a real env/secrets
#   file if that matters in your environment.
#
#     export ZO_API_KEY=...            # or ZO_Api_Key / ZO_CLIENT_IDENTITY_TOKEN
#     export OPENCODE_API_KEY=...      # or OpenCode_Api_Key / OPENCODE_GO_API_KEY
#     export NVIDIA_API_KEY=...        # or NIM_API_KEY
#     export HUGGINGFACE_API_KEY=...   # or HF_TOKEN
#     export OPENROUTER_API_KEY=...
#
#     bash scripts/verify-stream-options.sh
#
#   Each provider issues exactly ONE minimal streaming chat request (max 16
#   output tokens) using the same endpoint, auth header and request shape as
#   the matching lib/ai/*.ts client — read those files if you need to see
#   the exact source this was transcribed from. Optional overrides
#   (OPENCODE_MODEL / NIM_MODEL / HF_MODEL / OPENROUTER_MODEL /
#   OPENCODE_BASE_URL) are honoured the same way the app honours them.
#
# OUTPUT
#   One line per provider: SKIP (no key), SKIP (not applicable), REQUEST
#   FAILED (transport error or non-2xx), USAGE ABSENT (2xx, stream completed,
#   no usage object seen), or USAGE PRESENT (2xx, a non-null "usage" object
#   was found in the SSE stream). A summary line follows. No key material is
#   ever printed — only whether one was found.
#
# This script makes real, billable (where applicable) API calls. Run it only
# when you intend to spend the one small request per configured provider.

set -uo pipefail
# Deliberately NOT -e: one provider failing must not stop the others from
# being checked, and the final summary needs every provider's result.

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/verify-stream-options.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

RESULTS=()

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

# True if the response body contains a non-null "usage" object. The
# OpenAI-compatible SSE dialect these four providers all speak sends this as
# the LAST frame of the stream, and only when stream_options.include_usage
# was honoured — see the "noteUsage" comment in lib/ai/opencode.ts for why
# every earlier attempt to capture this from a stream came back empty.
has_usage_block() {
  local body_file="$1"
  grep -Eq '"usage"[[:space:]]*:[[:space:]]*\{' "$body_file" 2>/dev/null
}

# Reports one provider's verdict given the HTTP status curl saw and the
# response body it wrote to disk. Shared by every provider below so the
# verdict logic (and its wording) can't drift between them.
report_result() {
  local name="$1" http_code="$2" body_file="$3"

  if [ "$http_code" = "curl_error" ] || [ -z "$http_code" ]; then
    echo "[$name] REQUEST FAILED — curl could not complete the request (network error, DNS, or timeout)"
    RESULTS+=("$name: REQUEST FAILED (transport error)")
    return
  fi

  if [[ ! "$http_code" =~ ^2[0-9][0-9]$ ]]; then
    local snippet
    snippet="$(head -c 300 "$body_file" 2>/dev/null | tr -d '\r' | tr '\n' ' ')"
    echo "[$name] REQUEST FAILED — HTTP $http_code: ${snippet}"
    RESULTS+=("$name: REQUEST FAILED (HTTP $http_code)")
    return
  fi

  if has_usage_block "$body_file"; then
    echo "[$name] USAGE PRESENT — HTTP $http_code, a non-null \"usage\" object was found in the stream"
    RESULTS+=("$name: USAGE PRESENT")
  else
    echo "[$name] USAGE ABSENT — HTTP $http_code, stream completed but no \"usage\" object was found"
    RESULTS+=("$name: USAGE ABSENT")
  fi
}

skip() {
  local name="$1" reason="$2"
  echo "[$name] SKIP — $reason"
  RESULTS+=("$name: SKIP ($reason)")
}

# ---------------------------------------------------------------------------
# zoask — lib/ai/zoask.ts. Non-streaming /zo/ask endpoint, never sends
# `stream` or `stream_options`. Nothing to verify; always skipped.
# ---------------------------------------------------------------------------
verify_zoask() {
  local name="zoask"
  local key="${ZO_API_KEY:-${ZO_Api_Key:-${ZO_CLIENT_IDENTITY_TOKEN:-}}}"
  local key_note="no key found"
  [ -n "$key" ] && key_note="key found, but irrelevant here"
  skip "$name" "lib/ai/zoask.ts has no streaming path and never sends stream_options ($key_note)"
}

# ---------------------------------------------------------------------------
# opencode — lib/ai/opencode.ts completeStream(). OpenAI-compatible.
# ---------------------------------------------------------------------------
verify_opencode() {
  local name="opencode"
  local key="${OPENCODE_API_KEY:-${OpenCode_Api_Key:-${OPENCODE_GO_API_KEY:-}}}"
  if [ -z "$key" ]; then
    skip "$name" "no key found (checked OPENCODE_API_KEY, OpenCode_Api_Key, OPENCODE_GO_API_KEY)"
    return
  fi

  local base="${OPENCODE_BASE_URL:-https://opencode.ai/zen/go/v1}"
  base="${base%/}"
  local model="${OPENCODE_MODEL:-deepseek-v4-pro}"

  local extra_field=""
  if [[ "$model" =~ [Dd][Ee][Ee][Pp][Ss][Ee][Ee][Kk] ]]; then
    # Same DeepSeek-only rule as completeStream(): thinking ON burns the
    # whole budget on hidden reasoning_content and returns nothing usable.
    extra_field=',"thinking":{"type":"disabled"}'
  fi

  local payload
  payload=$(printf '{"model":"%s","messages":[{"role":"user","content":"Reply with just the word OK."}],"temperature":0.6,"max_tokens":16,"stream":true,"stream_options":{"include_usage":true}%s}' \
    "$model" "$extra_field")

  local body_file="$TMP_DIR/opencode.body"
  local http_code
  http_code=$(curl -sS -o "$body_file" -w '%{http_code}' --max-time 30 \
    -X POST "$base/chat/completions" \
    -H "Authorization: Bearer $key" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>"$TMP_DIR/opencode.err") || http_code="curl_error"

  report_result "$name" "$http_code" "$body_file"
}

# ---------------------------------------------------------------------------
# nim — lib/ai/nim.ts completeStreamWith(). OpenAI-compatible. Uses the
# chain's first model (or NIM_MODEL override), matching the client's own
# fallback-chain behavior when NIM_MODEL is set.
# ---------------------------------------------------------------------------
verify_nim() {
  local name="nim"
  local key="${NVIDIA_API_KEY:-${NIM_API_KEY:-}}"
  if [ -z "$key" ]; then
    skip "$name" "no key found (checked NVIDIA_API_KEY, NIM_API_KEY)"
    return
  fi

  local model="${NIM_MODEL:-mistralai/mistral-nemotron}"
  local payload
  payload=$(printf '{"model":"%s","messages":[{"role":"user","content":"Reply with just the word OK."}],"temperature":0.6,"max_tokens":16,"stream":true,"stream_options":{"include_usage":true}}' \
    "$model")

  local body_file="$TMP_DIR/nim.body"
  local http_code
  http_code=$(curl -sS -o "$body_file" -w '%{http_code}' --max-time 30 \
    -X POST "https://integrate.api.nvidia.com/v1/chat/completions" \
    -H "Authorization: Bearer $key" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>"$TMP_DIR/nim.err") || http_code="curl_error"

  report_result "$name" "$http_code" "$body_file"
}

# ---------------------------------------------------------------------------
# huggingface — lib/ai/huggingface.ts callHF(). OpenAI-compatible via HF's
# Inference Providers router. Uses the chain's first model (or HF_MODEL
# override).
# ---------------------------------------------------------------------------
verify_huggingface() {
  local name="huggingface"
  local key="${HUGGINGFACE_API_KEY:-${HF_TOKEN:-}}"
  if [ -z "$key" ]; then
    skip "$name" "no key found (checked HUGGINGFACE_API_KEY, HF_TOKEN)"
    return
  fi

  local model="${HF_MODEL:-meta-llama/Llama-3.3-70B-Instruct}"
  local payload
  payload=$(printf '{"model":"%s","messages":[{"role":"user","content":"Reply with just the word OK."}],"temperature":0.4,"max_tokens":16,"stream":true,"stream_options":{"include_usage":true}}' \
    "$model")

  local body_file="$TMP_DIR/huggingface.body"
  local http_code
  http_code=$(curl -sS -o "$body_file" -w '%{http_code}' --max-time 30 \
    -X POST "https://router.huggingface.co/v1/chat/completions" \
    -H "Authorization: Bearer $key" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>"$TMP_DIR/huggingface.err") || http_code="curl_error"

  report_result "$name" "$http_code" "$body_file"
}

# ---------------------------------------------------------------------------
# openrouter — lib/ai/openrouter.ts completeStreamWith(). OpenAI-compatible.
# Sends the same HTTP-Referer / X-Title headers the app sends, and uses the
# chain's first model (or OPENROUTER_MODEL override).
# ---------------------------------------------------------------------------
verify_openrouter() {
  local name="openrouter"
  local key="${OPENROUTER_API_KEY:-}"
  if [ -z "$key" ]; then
    skip "$name" "no key found (checked OPENROUTER_API_KEY)"
    return
  fi

  local model="${OPENROUTER_MODEL:-nvidia/nemotron-3.5-lightning:free}"
  local payload
  payload=$(printf '{"model":"%s","messages":[{"role":"user","content":"Reply with just the word OK."}],"temperature":0.6,"max_tokens":16,"stream":true,"stream_options":{"include_usage":true}}' \
    "$model")

  local body_file="$TMP_DIR/openrouter.body"
  local http_code
  http_code=$(curl -sS -o "$body_file" -w '%{http_code}' --max-time 30 \
    -X POST "https://openrouter.ai/api/v1/chat/completions" \
    -H "Authorization: Bearer $key" \
    -H "Content-Type: application/json" \
    -H "HTTP-Referer: https://app.leadrail.xyz" \
    -H "X-Title: LeadRail" \
    -d "$payload" 2>"$TMP_DIR/openrouter.err") || http_code="curl_error"

  report_result "$name" "$http_code" "$body_file"
}

# ---------------------------------------------------------------------------
# Run all five, in the router's tier order (see DEFAULT_TIER_ORDER in
# lib/ai/router.ts), then summarize.
# ---------------------------------------------------------------------------

echo "Checking stream_options.include_usage against live provider endpoints..."
echo

verify_zoask
verify_opencode
verify_nim
verify_huggingface
verify_openrouter

echo
echo "── Summary ──────────────────────────────────────────────"
failures=0
for line in "${RESULTS[@]}"; do
  echo "  $line"
  case "$line" in
    *"REQUEST FAILED"*|*"USAGE ABSENT"*) failures=$((failures + 1)) ;;
  esac
done
echo "────────────────────────────────────────────────────────"

if [ "$failures" -gt 0 ]; then
  echo "$failures provider(s) did not confirm usage present. See lines above for detail."
  exit 1
fi

exit 0
