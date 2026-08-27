// tests/schema-guard.test.ts
//
// The guard's REQUIRED registry drifted for eleven months: its last entry was
// migration 055, and every migration from 056 to 072 — including the one that
// added assistant_attachments.scope/.title (067) and agent_conversations.
// running_since (072) — was invisible to it. This asserts the registry was
// actually brought current, not just that the file compiles.
//
// Revert-check: comment out any one of the asserted entries below and this
// test goes red — see the task's revert-check note for confirmation this was
// actually run.

import { describe, it, expect } from 'vitest';
import { EXPECTATIONS } from '@/lib/db/schema-guard';

function entry(migration: string, table: string) {
  return EXPECTATIONS.find((e) => e.migration === migration && e.table === table);
}

describe('schema-guard REQUIRED registry (migrations 056-072)', () => {
  it('covers every migration through 072 that the app code depends on', () => {
    const migrations = new Set(EXPECTATIONS.map((e) => e.migration));
    // 065 (data backfill only), 070 (index only) and 071 (pg_cron schedule,
    // no app-facing column) deliberately introduce nothing for this registry
    // to check — see the task report for why.
    for (const m of ['056', '057', '058', '059', '061', '062', '063', '064', '066', '067', '068', '069', '072']) {
      expect(migrations.has(m), `migration ${m} has no REQUIRED entry`).toBe(true);
    }
  });

  it('registers the support ticket board (056)', () => {
    expect(entry('056', 'support_tickets')?.columns).toEqual(expect.arrayContaining(['status', 'fingerprint']));
    expect(entry('056', 'support_ticket_events')).toBeTruthy();
  });

  it('registers assistant_attachments and its later library columns (057, 067)', () => {
    expect(entry('057', 'assistant_attachments')?.columns).toEqual(
      expect.arrayContaining(['filename', 'storage_path', 'extracted_text']),
    );
    // 067's evidence from the task brief: scope and title were the two
    // concrete columns proven missing from the old registry.
    expect(entry('067', 'assistant_attachments')?.columns).toEqual(expect.arrayContaining(['scope', 'title']));
  });

  it('registers the model eligibility columns (058)', () => {
    expect(entry('058', 'ai_models')?.columns).toEqual(
      expect.arrayContaining(['context_window', 'cost_per_mtok_in', 'cost_per_mtok_out']),
    );
  });

  it('registers the conversation write guard (059)', () => {
    expect(entry('059', 'agent_conversations')?.columns).toEqual(['message_count']);
  });

  it('does NOT register ai_usage.parse_ok / conversation_id (060) — write-only, never read by app code', () => {
    expect(entry('060', 'ai_usage')).toBeUndefined();
  });

  it('registers the memory graph (061)', () => {
    expect(entry('061', 'memory_edges')?.columns).toEqual(
      expect.arrayContaining(['subject_type', 'subject_id', 'predicate', 'fact', 'tier']),
    );
    expect(entry('061', 'memory_subjects')?.columns).toEqual(expect.arrayContaining(['body', 'version']));
    expect(entry('061', 'agent_conversations')?.columns).toEqual(['memory_extracted_at']);
  });

  it('registers approval grants and their audit link (062)', () => {
    expect(entry('062', 'approval_grants')?.columns).toEqual(
      expect.arrayContaining(['conversation_id', 'tool', 'uses_remaining', 'expires_at']),
    );
    expect(entry('062', 'approvals')?.columns).toEqual(['grant_id']);
  });

  it('registers durable agent plans (063) but not the unused scheduled_tasks.active_plan_id', () => {
    expect(entry('063', 'agent_plans')?.columns).toEqual(expect.arrayContaining(['objective', 'status', 'max_steps']));
    expect(entry('063', 'agent_plan_steps')?.columns).toEqual(expect.arrayContaining(['seq', 'title', 'status']));
    const scheduledEntry = entry('063', 'scheduled_tasks');
    expect(scheduledEntry?.columns).toEqual(['conversation_id']);
    expect(scheduledEntry?.columns).not.toContain('active_plan_id');
  });

  it('registers video analysis storage (064)', () => {
    expect(entry('064', 'video_analyses')?.columns).toEqual(
      expect.arrayContaining(['attachment_id', 'duration_seconds', 'transcript']),
    );
  });

  it('registers plan-pinned skills and persona (066)', () => {
    expect(entry('066', 'agent_plans')?.columns).toEqual(expect.arrayContaining(['skills', 'persona_id']));
  });

  it('registers pattern-promotion provenance (068)', () => {
    expect(entry('068', 'memory_edges')?.columns).toEqual(expect.arrayContaining(['promoted_by', 'promoted_at']));
  });

  it('registers conversation soft-delete (069)', () => {
    expect(entry('069', 'agent_conversations')?.columns).toEqual(['deleted_at']);
  });

  it('registers the in-flight run signal (072)', () => {
    expect(entry('072', 'agent_conversations')?.columns).toEqual(['running_since']);
  });
});
