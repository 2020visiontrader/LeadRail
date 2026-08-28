// Revert-check for the catalogLine() arg-type fix (lib/agent/tools.ts).
//
// The catalog used to render `name(arg1, arg2?)` — keys only, the schema's
// `type` discarded even though every property declares one. The model could
// not tell a `string` arg from an `array` arg and guessed, tripping runTool()'s
// zod validation. This test pins the typed rendering so a regression back to
// keys-only is caught immediately.
import { describe, it, expect } from 'vitest';
import { toolCatalogForPrompt } from '@/lib/agent/tools';

describe('catalog arg types', () => {
  const catalog = toolCatalogForPrompt();

  it('renders a required array argument as name:arr', () => {
    // enrollInSequence(sequenceId: string, contactIds: array) — both required.
    const line = catalog.split('\n').find((l) => l.startsWith('enrollInSequence('));
    expect(line).toBeDefined();
    expect(line).toContain('sequenceId:str');
    expect(line).toContain('contactIds:arr');
    // Neither arg is optional — must not carry a `?`.
    expect(line).not.toContain('sequenceId?');
    expect(line).not.toContain('contactIds?');
  });

  it('renders an optional string argument as name?:str', () => {
    // enrichLead's args are all optional identity hints.
    const line = catalog.split('\n').find((l) => l.startsWith('enrichLead('));
    expect(line).toBeDefined();
    expect(line).toContain('contactId?:str');
    expect(line).toContain('email?:str');
  });
});
