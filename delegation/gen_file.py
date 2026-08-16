#!/usr/bin/env python3
"""One-file-at-a-time delegation. Smaller units = reviewable diffs + no timeouts."""
import json, os, sys, time, urllib.request, pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
RUNS = REPO / "delegation" / "runs"
RUNS.mkdir(parents=True, exist_ok=True)

LADDER = [
    ("or", "nvidia/nemotron-3-ultra-550b-a55b:free"),
    ("or", "nvidia/nemotron-3-super-120b-a12b:free"),
    ("nim", "deepseek-ai/deepseek-v4-flash-0731"),
    ("or", "poolside/laguna-s-2.1:free"),
]
EP = {"nim": "https://integrate.api.nvidia.com/v1/chat/completions",
      "or": "https://openrouter.ai/api/v1/chat/completions"}
KEY = {"nim": os.environ.get("NVIDIA_API_KEY", ""),
       "or": os.environ.get("OPENROUTER_API_KEY", "")}

SYSTEM = (
    "You port TypeScript code exactly as specified. "
    "Output ONLY the complete file content. No markdown fences, no prose, "
    "no explanation before or after. Start at the first line of the file."
)


def call(provider, model, user, max_tokens=12000):
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": SYSTEM},
                     {"role": "user", "content": user}],
        "temperature": 0.0, "max_tokens": max_tokens,
    }).encode()
    req = urllib.request.Request(EP[provider], data=body, headers={
        "Authorization": f"Bearer {KEY[provider]}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        d = json.loads(r.read())
    m = d["choices"][0]["message"]
    return (m.get("content") or "").strip()


def strip_fence(s):
    if s.startswith("```"):
        parts = s.split("```")
        if len(parts) >= 2:
            s = parts[1]
            if s.startswith("typescript"):
                s = s[len("typescript"):]
            elif s.startswith("ts"):
                s = s[2:]
    return s.strip()


def main():
    task_file, out_path = sys.argv[1], sys.argv[2]
    user = pathlib.Path(task_file).read_text()
    stamp = time.strftime("%H%M%S")
    for provider, model in LADDER:
        print(f"→ {provider}:{model}", flush=True)
        try:
            raw = call(provider, model, user)
        except Exception as e:
            print(f"  FAILED: {e}", flush=True)
            continue
        (RUNS / f"{stamp}-{pathlib.Path(out_path).name}.raw").write_text(raw)
        code = strip_fence(raw)
        if len(code) < 120 or "export" not in code:
            print(f"  output too short/invalid ({len(code)}b), next model", flush=True)
            continue
        dest = REPO / out_path
        # SAFETY GUARD (added after a run truncated lib/agent/loop.ts 588 -> 114
        # lines and lib/agent/tools.ts 428 -> 70). Free-tier models silently
        # truncate long files. This harness may CREATE new files only; edits to
        # existing tracked files must be made by a tool that can diff, or by hand.
        if dest.exists():
            print(f"  REFUSED: {out_path} already exists. This harness never "
                  f"overwrites existing files. Edit it manually or via a diff-capable tool.")
            return 3
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(code + "\n")
        print(f"  WROTE {out_path} ({len(code)} bytes) via {provider}:{model}")
        return 0
    print("ALL MODELS FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
