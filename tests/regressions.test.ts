// tests/regressions.test.ts — Packet D3: regression guards.
//
// Two structural assertions that cannot be checked by the parity suite alone:
//
// 1. SENSITIVE BASELINE: parity proves API and MCP surfaces agree, but it
//    structurally cannot catch a capability's gate being downgraded. Flipping
//    sendEmail from 'external_send' to 'read' would remove the approval card,
//    the audit row, and the MCP `allow_sensitive` requirement in one line with
//    nothing objecting. This test maintains a frozen baseline of every capability
//    currently marked sensitive, so a downgrade becomes an explicit, reviewable
//    edit to the baseline.
//
// 2. TOOL_VERB COVERAGE: a capability landing without a verb degrades silently
//    to its title. This test asserts every registered capability has a TOOL_VERB
//    entry, and every TOOL_VERB key is a real capability (no dead keys).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Capability } from '@/lib/capabilities/types';
import * as fs from 'fs';

// C6 (2026-09-03): the staged catalog is now the DEFAULT, and the escape
// hatch that restores the old full-catalog-only shape is AGENT_FULL_CATALOG,
// not AGENT_STAGED_CATALOG=0 — the registry no longer reads
// AGENT_STAGED_CATALOG from the environment at all (it's derived as
// `!AGENT_FULL_CATALOG`). "off"/"staged: false" below means "full catalog",
// produced by setting AGENT_FULL_CATALOG=1, matching the pre-flip shape.
const ENV_KEY = 'AGENT_FULL_CATALOG';
const ORIGINAL_FLAG = process.env[ENV_KEY];

interface RegressionSurfaces {
  capabilities: Capability[];
  capabilityNames: Set<string>;
  sensitiveNames: string[];
  isSensitive: (c: Capability) => boolean;
}

async function loadRegressionSurfaces(staged: boolean): Promise<RegressionSurfaces> {
  vi.resetModules();
  if (staged) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = '1';

  const registry = await import('@/lib/capabilities/registry');
  const types = await import('@/lib/capabilities/types');

  const capabilities = registry.CAPABILITIES;
  const sensitiveNames = capabilities
    .filter((c) => types.isSensitive(c))
    .map((c) => c.name)
    .sort();

  return {
    capabilities,
    capabilityNames: new Set(capabilities.map((c) => c.name)),
    sensitiveNames,
    isSensitive: types.isSensitive,
  };
}

/** Extract TOOL_VERB keys from src/components/AgentConsole.tsx using regex. */
function extractToolVerbKeys(): string[] {
  const source = fs.readFileSync('./src/components/AgentConsole.tsx', 'utf-8');
  const match = source.match(/const TOOL_VERB: Record<string, string> = \{([\s\S]*?)\};/);
  if (!match) throw new Error('Could not find TOOL_VERB definition in AgentConsole.tsx');

  const verbBlock = match[1];
  const keys: string[] = [];
  const lines = verbBlock.split('\n');
  for (const line of lines) {
    // Match lines like "  toolName: 'description'," or "  toolName: 'description',"
    // Skip comment-only lines and empty lines
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    const keyMatch = /^(\w+):/.exec(trimmed);
    if (keyMatch) {
      keys.push(keyMatch[1]);
    }
  }
  return keys.sort();
}

afterAll(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_FLAG;
});

// --- GUARD 1: SENSITIVE BASELINE -----------------------------------------------

describe('Regression Guard 1: Sensitive Baseline', () => {
  let S: RegressionSurfaces;

  beforeAll(async () => {
    S = await loadRegressionSurfaces(false);
  }, 30000);

  // This frozen baseline is derived from the current registry state (Packet D3).
  // When a capability's gate changes, the test fails and you have two choices:
  // 1. It was intentional: update this baseline (explicit diff in review).
  // 2. It was a mistake: restore the gate value.
  // Derived from CAPABILITIES where isSensitive(c) is true. Sensitivity means
  // gate is one of: 'spend', 'external_send', 'destructive', 'standing_rule'.
  // Currently 19 sensitive capabilities (as of Packet 7.3).
  const SENSITIVE_BASELINE = [
    // CRM automations engine (migration 012), exposed to the assistant for the
    // first time. Same risk class as its social twin and gated identically: a
    // rule is created switched OFF ('standing_rule'), arming it is
    // enableAutomation's own approval, and one of its actions
    // (enroll_sequence) sends real email with no further human in the loop.
    // disableAutomation is deliberately NOT here — stopping a rule only ever
    // reduces unattended sending, mirroring disableSocialAutomation's omission.
    'createAutomation',
    // Packet D2 added this deliberately. A scheduled task runs an agent
    // unattended and REPEATEDLY with no further human in the loop, which is
    // exactly what 'standing_rule' means (packet 2.2-S). This guard caught it
    // as unbaselined on the first run — that is the intended workflow: a new
    // sensitive capability must be an explicit, reviewable line here.
    'createScheduledTask',
    'createSocialAutomation',
    'deleteAutomation',
    // Content engine. Both destroy work a person may have written or approved,
    // and neither is recoverable — the board offers ARCHIVED for the reversible
    // case, which is why the capability descriptions push toward it.
    'deleteContentItem',
    'deleteContentPillar',
    'deleteDeal',
    'deleteSocialAutomation',
    'deleteSocialComment',
    'enableAutomation',
    'enableSocialAutomation',
    'enrichLead',
    'enrollInSequence',
    'hideSocialComment',
    'launchCampaign',
    // Promoting an observed pattern to an operational one. 'standing_rule' is
    // the correct class and the reason is the sharpest on this list: what it
    // creates is a belief the system then acts on in EVERY future campaign
    // without being asked again. A wrong tier-1 fact about one contact costs
    // one relationship; a wrongly-promoted pattern about "what works" steers
    // budget and creative until somebody notices.
    //
    // Its twin, demoteObservation, is deliberately NOT here — withdrawing the
    // system's permission to act must never queue behind an approval, the same
    // reasoning that keeps disableAutomation off this list.
    'promoteObservation',
    'publishSocialPost',
    'replyToSocialComment',
    'replyToThread',
    // Packet 7.3: turning the account-level automation kill switch back ON
    // restores unattended sending capacity (though no single rule is
    // re-armed by it alone) — same risk class as enableSocialAutomation, so
    // it is 'standing_rule' too. pauseAllSocialAutomations is deliberately
    // NOT here: pausing only ever reduces unattended sending (gate:
    // 'internal_write'), mirroring disableSocialAutomation's omission above.
    'resumeAllSocialAutomations',
    'scheduleSocialPost',
    'sendEmail',
    // Gmail domain (2026-09-03): sends a real email from the connected Gmail
    // mailbox to a real person, gated exactly like sendEmail above — same
    // risk class, same approval flow.
    'sendGmailEmail',
    'sendSocialMessage',
    'setAdStatus',
    'sourceLeads',
  ];

  it('freezes the baseline: sensitive names match exactly', () => {
    expect(S.sensitiveNames).toEqual(SENSITIVE_BASELINE);
  });

  it('no sensitive capability was silently downgraded to read', () => {
    const drift: string[] = [];
    for (const c of S.capabilities) {
      if (SENSITIVE_BASELINE.includes(c.name)) {
        if (!S.isSensitive(c)) {
          drift.push(`${c.name}: was sensitive (gate=${c.gate}) but is NOT sensitive now`);
        }
      }
    }
    if (drift.length) {
      throw new Error(
        `Sensitive baseline regression:\n${drift.join('\n')}\n\nTo fix: restore the gate value, or update SENSITIVE_BASELINE in tests/regressions.test.ts (deliberate change).`,
      );
    }
    expect(drift).toEqual([]);
  });

  it('no new capability was added as sensitive without updating the baseline', () => {
    const unnoticed: string[] = [];
    for (const c of S.capabilities) {
      if (S.isSensitive(c) && !SENSITIVE_BASELINE.includes(c.name)) {
        unnoticed.push(`${c.name} (gate=${c.gate})`);
      }
    }
    if (unnoticed.length) {
      throw new Error(
        `New sensitive capabilities not in baseline: ${unnoticed.join(', ')}\n\nTo fix: add them to SENSITIVE_BASELINE in tests/regressions.test.ts`,
      );
    }
    expect(unnoticed).toEqual([]);
  });
});

// --- GUARD 2: TOOL_VERB COVERAGE -----------------------------------------------

describe('Regression Guard 2: TOOL_VERB Coverage', () => {
  // The TOOL_VERB map must cover every capability in BOTH registry modes
  // (staging on and off). Capabilities that only exist in one mode (describeTools
  // is staged-only) must still be in TOOL_VERB — it runs in both modes and
  // toolCatalogForPrompt() renders capabilities whenever they're registered.
  let offMode: RegressionSurfaces;
  let onMode: RegressionSurfaces;
  let verbKeys: Set<string>;

  beforeAll(async () => {
    offMode = await loadRegressionSurfaces(false);
    onMode = await loadRegressionSurfaces(true);
    verbKeys = new Set(extractToolVerbKeys());
  }, 30000);

  it('every capability in both registry modes has a TOOL_VERB entry', () => {
    const missing: string[] = [];
    const allCapNames = new Set<string>();

    for (const c of offMode.capabilities) allCapNames.add(c.name);
    for (const c of onMode.capabilities) allCapNames.add(c.name);

    for (const name of allCapNames) {
      if (!verbKeys.has(name)) {
        missing.push(name);
      }
    }
    if (missing.length) {
      throw new Error(
        `Missing TOOL_VERB entries: ${missing.join(', ')}\n\nTo fix: add entries to TOOL_VERB in src/components/AgentConsole.tsx (lines 22–126)`,
      );
    }
    expect(missing).toEqual([]);
  });

  it('no TOOL_VERB key is a dead/unknown capability in either registry mode', () => {
    const allCapNames = new Set<string>();
    for (const c of offMode.capabilities) allCapNames.add(c.name);
    for (const c of onMode.capabilities) allCapNames.add(c.name);

    const dead: string[] = [];
    for (const key of verbKeys) {
      if (!allCapNames.has(key)) {
        dead.push(key);
      }
    }
    if (dead.length) {
      throw new Error(
        `Dead TOOL_VERB keys (capability no longer exists in either mode): ${dead.join(', ')}\n\nTo fix: remove them from TOOL_VERB in src/components/AgentConsole.tsx`,
      );
    }
    expect(dead).toEqual([]);
  });

  it('TOOL_VERB keys cover all capabilities in both registry modes (no duplicates, complete coverage)', () => {
    const offNames = offMode.capabilities.map((c) => c.name).sort();
    const onNames = onMode.capabilities.map((c) => c.name).sort();
    const allNames = new Set([...offNames, ...onNames]);

    expect(Array.from(verbKeys).sort()).toEqual(Array.from(allNames).sort());
  });
});
