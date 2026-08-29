#!/usr/bin/env node
// scripts/persona-harness.ts
// Deterministic harness to run ROLE_SIGNALS x persona matrix on sample requests.

const ROLE_SIGNALS = [
  { id: 1, match: /(\b(budget|spend|cpa|roas|bid|ad set|paid|campaign performance|cost)\b)/i, roles: /media|buyer|analyst/i },
  { id: 2, match: /(\b(number|metric|data|report|how many|conversion|pipeline|analytics)\b)/i, roles: /analyst/i },
  { id: 3, match: /(\b(copy|subject line|hook|headline|write|draft|messaging|tone)\b)/i, roles: /copywriter|creative/i },
  { id: 4, match: /(\b(position|brand|audience|differentiat|competitor|strategy|market)\b)/i, roles: /strategist|account/i },
  { id: 5, match: /(\b(email|sequence|nurture|onboarding|retention|lifecycle|drip)\b)/i, roles: /lifecycle|copywriter/i },
  { id: 6, match: /(\b(social|instagram|post|comment|dm|reel|linkedin|organic)\b)/i, roles: /social|creative/i },
  { id: 7, match: /(\b(review|quality|good enough|feedback|critique|approve)\b)/i, roles: /creative director|director/i },
  { id: 8, match: /(\b(goal|scope|timeline|commitment|deadline|priorit)\b)/i, roles: /account/i },
];

const { HARVESTED_PERSONA_TEMPLATES } = require('../lib/agent/harvested-personas');

function roleString(p) {
  return `${p.role || ''} ${p.name}`.trim();
}

function runMatrix(request, personas) {
  const fired = ROLE_SIGNALS.filter(s => s.match.test(request)).map(s => s.id);
  const personaMatches = personas.map(p => {
    const rs = roleString(p);
    const matches = ROLE_SIGNALS.map(s => ({ id: s.id, sigMatch: s.match.test(request), roleMatch: s.roles.test(rs) }));
    const score = matches.reduce((acc, m) => acc + (m.sigMatch && m.roleMatch ? 1 : 0), 0);
    return { slug: p.slug, name: p.name, role: p.role, domain: p.domain || 'general', roleString: rs, matches, score };
  });
  personaMatches.sort((a,b) => b.score - a.score || a.name.localeCompare(b.name));
  return { request, fired, personaMatches };
}

function printResult(res) {
  console.log('REQUEST: ' + res.request);
  console.log('FIRED SIGNAL IDS: ' + res.fired.join(', '));
  console.log('--- per-persona details ---');
  for (const p of res.personaMatches) {
    console.log(`- ${p.slug} (${p.domain})`);
    console.log(`  roleString: ${p.roleString}`);
    console.log(`  score: ${p.score}`);
    for (const m of p.matches) {
      if (m.sigMatch || m.roleMatch) {
        console.log(`    signal ${m.id}: sigMatch=${m.sigMatch} roleMatch=${m.roleMatch}`);
      }
    }
  }
  console.log('--- top picks ---');
  const top = res.personaMatches.filter(p => p.score > 0).slice(0,3);
  if (top.length === 0) console.log('(none)');
  for (const t of top) console.log(`* ${t.slug} (${t.name}) score=${t.score}`);
  console.log('\n\n');
}

const requests = [
  'Write a 3-email cold outreach sequence with subject lines and follow-up cadence.',
  'Draft a cold outreach email for VPs of product about our analytics tool.',
  'Create a 5-step follow-up sequence for a warm lead in SaaS.',
  // ambiguous example
  'Write follow-up email copy that references our Q3 positioning and includes a two-step nurture sequence.'
];

// Variant A: journey-orchestrator as outreach (as in templates)
console.log('=== VARIANT A: journey-orchestrator domain = outreach ===');
printAll(requests, HARVESTED_PERSONA_TEMPLATES);

// Variant B: journey-orchestrator treated as marketing (clone templates with override)
console.log('=== VARIANT B: journey-orchestrator domain = marketing ===');
const alt = HARVESTED_PERSONA_TEMPLATES.map(p => p.slug === 'journey-orchestrator' ? { ...p, domain: 'marketing' } : p);
printAll(requests, alt);

function printAll(reqs, personas) {
  for (const r of reqs) {
    const res = runMatrix(r, personas);
    printResult(res);
  }
}
