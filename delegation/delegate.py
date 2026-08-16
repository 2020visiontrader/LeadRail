#!/usr/bin/env python3
"""
delegate.py — LeadRail packet executor harness.

Sends a delegation packet + the repo files it needs to a free/cheap model,
writes the model's returned files to disk, and logs the raw response.

Opus does NOT write implementation code; this harness is the executor path.
Usage:
    python3 delegation/delegate.py <packet.md> [--tier a|b|c] [--dry]
"""
import json, os, sys, time, urllib.request, argparse, pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
RUNS = REPO / "delegation" / "runs"

NIM_KEY = os.environ.get("NVIDIA_API_KEY", "")
OR_KEY = os.environ.get("OPENROUTER_API_KEY", "")

# Ladder by tier. Each entry: (provider, model). Tried in order on failure.
LADDER = {
    "a": [
        ("or",  "nvidia/nemotron-3-ultra-550b-a55b:free"),
        ("nim", "nvidia/nemotron-3-ultra-550b-a55b"),
        ("nim", "deepseek-ai/deepseek-v4-flash-0731"),
        ("or",  "poolside/laguna-s-2.1:free"),
    ],
    "b": [
        ("nim", "deepseek-ai/deepseek-v4-flash-0731"),
        ("or",  "nvidia/nemotron-3-super-120b-a12b:free"),
        ("or",  "cohere/north-mini-code:free"),
    ],
    "c": [
        ("or",  "nvidia/nemotron-3-nano-30b-a3b:free"),
        ("nim", "nvidia/nemotron-3-nano-30b-a3b"),
    ],
}

ENDPOINTS = {
    "nim": ("https://integrate.api.nvidia.com/v1/chat/completions", lambda: NIM_KEY),
    "or":  ("https://openrouter.ai/api/v1/chat/completions", lambda: OR_KEY),
}

SYSTEM = """You are an executor implementing a specification packet for a Next.js/TypeScript repo.

HARD RULES:
1. Implement EXACTLY the packet. Touch ONLY files the packet lists.
2. Do not rename exported symbols or change existing signatures unless told to.
3. Do not "improve" descriptions, schemas, or bugs you notice. Report them instead.
4. Preserve the repo's comment style: explain WHY; mark additive changes as additive.

OUTPUT FORMAT — this is mandatory and parsed by a script.
Return ONE JSON object and nothing else. No prose, no markdown fences.
{
  "files": [ {"path": "lib/capabilities/types.ts", "content": "<full file content>"} ],
  "questions": ["<blocking ambiguity, if any>"],
  "notes": ["<things you noticed but did NOT change>"]
}
If the packet is ambiguous in a way that changes the output, return an empty
"files" array and put the single blocking question in "questions"."""


def call(provider, model, system, user, max_tokens=16000):
    url, keyfn = ENDPOINTS[provider]
    key = keyfn()
    if not key:
        raise RuntimeError(f"no key for {provider}")
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user}],
        "temperature": 0.1,
        "max_tokens": max_tokens,
    }).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=600) as r:
        d = json.loads(r.read())
    return d["choices"][0]["message"]["content"]


def extract_json(raw):
    s = raw.strip()
    if s.startswith("```"):
        s = s.split("```", 2)[1]
        if s.startswith("json"):
            s = s[4:]
    i, j = s.find("{"), s.rfind("}")
    if i == -1 or j == -1:
        return None
    try:
        return json.loads(s[i:j + 1])
    except json.JSONDecodeError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("packet")
    ap.add_argument("--tier", default="a", choices=["a", "b", "c"])
    ap.add_argument("--context", nargs="*", default=[],
                    help="repo files to include as read-only context")
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()

    packet = pathlib.Path(a.packet).read_text()
    ctx = ""
    for rel in a.context:
        p = REPO / rel
        if p.exists():
            ctx += f"\n\n=== EXISTING FILE: {rel} ===\n{p.read_text()}"
        else:
            ctx += f"\n\n=== EXISTING FILE: {rel} === (does not exist yet)"

    user = f"PACKET:\n{packet}\n\nREPO CONTEXT (read-only, for reference):{ctx}"
    RUNS.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = pathlib.Path(a.packet).stem

    for provider, model in LADDER[a.tier]:
        print(f"→ {provider}:{model}", flush=True)
        try:
            raw = call(provider, model, SYSTEM, user)
        except Exception as e:
            print(f"  FAILED: {e}", flush=True)
            continue
        (RUNS / f"{stamp}-{name}-raw.txt").write_text(raw)
        parsed = extract_json(raw)
        if not parsed:
            print("  unparseable output, trying next model", flush=True)
            continue
        if parsed.get("questions"):
            print("  MODEL BLOCKED:", parsed["questions"], flush=True)
            return 2
        files = parsed.get("files", [])
        if not files:
            print("  no files returned, trying next model", flush=True)
            continue
        print(f"  {len(files)} file(s) returned by {model}")
        for f in files:
            dest = REPO / f["path"]
            print(f"    {'DRY ' if a.dry else ''}write {f['path']} ({len(f['content'])} bytes)")
            if not a.dry:
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(f["content"])
        for n in parsed.get("notes", []):
            print("  NOTE:", n)
        (RUNS / f"{stamp}-{name}-result.json").write_text(json.dumps(parsed, indent=2))
        print(f"  model used: {provider}:{model}")
        return 0

    print("ALL MODELS FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
