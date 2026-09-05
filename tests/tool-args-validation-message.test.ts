// THE PRODUCTION DEFECT this guards against (observed in a production
// screenshot): a tool-argument validation failure reached the user (and the
// model, which reads this same string to correct itself) as
//
//     ERROR: Invalid arguments: [{ "expected": "string", "code":
//     "invalid_type", "path": [ "messageId" ], "message": "Invalid input" }]
//
// — zod's ZodError.message IS a JSON-stringified array of its issues, so
// interpolating it straight into the error string (lib/agent/tools.ts:166)
// produced raw JSON verbatim. observation-display-guard.test.ts already
// proves capability *results* never leak raw JSON; this file is the same
// bar applied to the OTHER place raw JSON was reaching a person: a failed
// runTool() argument validation. describeZodIssues() is the fix — it turns
// zod's issues into one readable sentence naming the offending field(s).
//
// CLAUDE.md: "Results reaching a human are readable prose. Raw JSON in a
// user-facing message is a defect regardless of which tool produced it." The
// MODEL also reads this exact string to self-correct, so the field name must
// be precise, not just "invalid input" — asserted below by name, not only by
// absence of JSON markers.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { describeZodIssues, runTool } from '@/lib/agent/tools';

// The same raw-JSON fingerprints observation-display-guard.test.ts checks
// for — the literal signature of an un-rendered JSON.stringify(...) dump.
const RAW_JSON_MARKERS = ['{"', '":[', '":{'];
function findRawJsonMarker(text: string): string | undefined {
  return RAW_JSON_MARKERS.find((m) => text.includes(m));
}

describe('describeZodIssues — turns a ZodError into one readable sentence', () => {
  it('a missing required field names the field and says it is required', () => {
    const schema = z.object({ messageId: z.string() });
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    const msg = describeZodIssues(result.error!.issues);
    expect(msg).toContain('messageId');
    expect(msg.toLowerCase()).toContain('required');
    expect(findRawJsonMarker(msg)).toBeUndefined();
  });

  it('a wrong type names the field and the expected type', () => {
    const schema = z.object({ count: z.number() });
    const result = schema.safeParse({ count: 'five' });
    expect(result.success).toBe(false);
    const msg = describeZodIssues(result.error!.issues);
    expect(msg).toContain('count');
    expect(msg).toContain('number');
    expect(findRawJsonMarker(msg)).toBeUndefined();
  });

  it('a nested path is rendered readably (dotted), not as a raw path array', () => {
    const schema = z.object({ contact: z.object({ email: z.string() }) });
    const result = schema.safeParse({ contact: { email: 5 } });
    expect(result.success).toBe(false);
    const msg = describeZodIssues(result.error!.issues);
    expect(msg).toContain('contact.email');
    expect(msg).not.toContain('[');
    expect(msg).not.toContain(']');
    expect(findRawJsonMarker(msg)).toBeUndefined();
  });

  it('several issues at once are summarised, not dumped as a wall of text', () => {
    const schema = z.object({
      a: z.string(),
      b: z.string(),
      c: z.string(),
      d: z.string(),
      e: z.string(),
    });
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    expect(result.error!.issues.length).toBe(5);
    const msg = describeZodIssues(result.error!.issues);
    // Every field named directly, or accounted for by the "+N more" summary.
    expect(msg).toContain('a is required');
    expect(msg).toMatch(/\+2 more issues/);
    expect(findRawJsonMarker(msg)).toBeUndefined();
    // Not an unbounded wall of text.
    expect(msg.length).toBeLessThan(200);
  });
});

describe('runTool — the exact production case: getGmailMessage with no messageId', () => {
  it('names messageId, says it is required, and carries no raw JSON', async () => {
    const res = await runTool('getGmailMessage', 'acct-1', {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain('messageId');
    expect(res.error!.toLowerCase()).toContain('required');
    expect(findRawJsonMarker(res.error!)).toBeUndefined();
    // The old defect's literal fingerprint, named explicitly.
    expect(res.error).not.toContain('"code"');
    expect(res.error).not.toContain('"path"');
  });
});
