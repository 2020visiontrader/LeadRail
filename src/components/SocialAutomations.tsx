'use client';
import { useCallback, useEffect, useState } from 'react';
import Button from '@/components/Button';
import Badge from '@/components/Badge';
import Modal from '@/components/Modal';
import Input from '@/components/Input';
import Textarea from '@/components/Textarea';
import EmptyState from '@/components/EmptyState';
import LoadingSpinner from '@/components/LoadingSpinner';
import { apiGet, apiSend } from '@/lib/api';

// Rules that reply, hide or flag on connected social accounts.
//
// These are the highest-consequence standing rules in the product: a rule that
// replies is a rule that posts PUBLICLY, under the brand's name, without anyone
// reading it first. So this screen is built around three things the database
// already enforces, made visible rather than hidden:
//
//   1. Every rule is created SWITCHED OFF. Creating and arming are separate
//      decisions, and the create endpoint ignores any attempt to arm.
//   2. Every rule has a DAILY CAP, capped at 200 by a database constraint. It
//      is shown on the card, not buried in an edit form, because "how much
//      damage can this do in a day" is the question a reader actually has.
//   3. Behaviour cannot be edited while armed. Changing what a rule does would
//      let something approved as "notify me" quietly become "reply publicly",
//      so editing means delete and recreate — landing back at switched off.

interface Rule {
  id: string;
  platform: string;
  external_id: string;
  trigger: string;
  match: { keywords?: string[]; regex?: string };
  action: string;
  template: string | null;
  daily_cap: number;
  sends_today: number;
  enabled: boolean;
}

const TRIGGERS = [
  { id: 'comment_received', label: 'Someone comments' },
  { id: 'dm_received', label: 'Someone sends a direct message' },
  { id: 'mention', label: 'The account is mentioned' },
];

const ACTIONS = [
  { id: 'notify', label: 'Notify me', blurb: 'Nothing is posted. The safest rule to start with.', public: false },
  { id: 'tag_lead', label: 'Tag them as a lead', blurb: 'Adds them to the CRM. Nothing is posted.', public: false },
  { id: 'hide', label: 'Hide the comment', blurb: 'Hides it from the public. Visible to you and to them.', public: true },
  { id: 'reply', label: 'Reply publicly', blurb: 'Posts a public reply as the brand, with nobody reading it first.', public: true },
];

const labelOf = (list: { id: string; label: string }[], id: string) =>
  list.find((x) => x.id === id)?.label || id;

export default function SocialAutomations() {
  const [rows, setRows] = useState<Rule[]>([]);
  const [accounts, setAccounts] = useState<{ provider: string; external_id: string; label?: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [account, setAccount] = useState('');
  const [trigger, setTrigger] = useState(TRIGGERS[0].id);
  const [action, setAction] = useState('notify');
  const [keywords, setKeywords] = useState('');
  const [template, setTemplate] = useState('');
  const [cap, setCap] = useState(25);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiGet<{ automations: Rule[] }>('/api/social-automations');
      setRows(r.automations || []);
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not load social rules.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    apiGet<{ connections: any[] }>('/api/integrations/connections')
      .then((d) => setAccounts((d.connections || []).filter((c: any) => c.external_id)))
      .catch(() => setAccounts([]));
  }, [load]);

  const chosen = ACTIONS.find((a) => a.id === action)!;

  async function submit() {
    if (!account) { setFormErr('Choose which connected account this runs for.'); return; }
    if (action === 'reply' && !template.trim()) { setFormErr('A public reply needs a message.'); return; }
    setSaving(true); setFormErr(null);
    try {
      const [platform, externalId] = account.split('::');
      await apiSend('/api/social-automations', 'POST', {
        platform, externalId, trigger, action,
        keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean),
        template: template.trim() || undefined,
        dailyCap: cap,
      });
      setOpen(false);
      setMsg({ ok: true, text: 'Rule created — switched off. It does nothing until you turn it on.' });
      void load();
    } catch (e: any) {
      setFormErr(e?.message || 'Could not create that rule.');
    } finally {
      setSaving(false);
    }
  }

  async function toggle(r: Rule) {
    // Arming a rule that posts publicly is the one action here worth a pause.
    if (!r.enabled && (r.action === 'reply' || r.action === 'hide')) {
      const ok = window.confirm(
        `This will let LeadRail ${r.action === 'reply' ? 'post public replies' : 'hide comments'} on your ${r.platform} account automatically, up to ${r.daily_cap} times a day, without showing them to you first.\n\nSwitch it on?`,
      );
      if (!ok) return;
    }
    try {
      await apiSend(`/api/social-automations/${r.id}`, 'PATCH', { enabled: !r.enabled });
      void load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not change that rule.' });
    }
  }

  async function remove(r: Rule) {
    try {
      await apiSend(`/api/social-automations/${r.id}`, 'DELETE');
      void load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not delete that rule.' });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-[var(--text-secondary)]">
          Rules that act on comments, direct messages and mentions for a connected account. Every rule is created
          switched off, and every one has a hard daily limit — a rule that replies posts publicly as your brand
          with nobody reading it first.
        </p>
        <Button variant="secondary" className="shrink-0 text-xs" onClick={() => { setFormErr(null); setOpen(true); }}>
          + New rule
        </Button>
      </div>

      {msg && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${msg.ok ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState icon="↻" title="No social rules yet" hint="A rule can flag a comment, tag the person as a lead, hide it, or reply automatically." />
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const isPublic = r.action === 'reply' || r.action === 'hide';
            return (
              <div key={r.id} className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{labelOf(TRIGGERS, r.trigger)} → {labelOf(ACTIONS, r.action)}</span>
                      <Badge tone={r.enabled ? 'green' : 'gray'}>{r.enabled ? 'on' : 'off'}</Badge>
                      <Badge tone="gray">{r.platform}</Badge>
                      {/* Named on the card, not hidden behind an edit form:
                          whether a rule can speak in public is the single most
                          important thing about it. */}
                      {isPublic && <Badge tone="amber">acts publicly</Badge>}
                    </div>
                    <p className="mt-1 text-[13px] text-[var(--text-secondary)]">
                      {r.match?.keywords?.length
                        ? <>Only when it contains: {r.match.keywords.join(', ')}.</>
                        : <>On every match — no keyword filter.</>}
                      {r.template ? <> Replies with: “{r.template.slice(0, 90)}{r.template.length > 90 ? '…' : ''}”</> : null}
                    </p>
                    <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                      {r.sends_today} of {r.daily_cap} used today · resets daily
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button variant="ghost" className="text-xs" onClick={() => toggle(r)}>
                      {r.enabled ? 'Switch off' : 'Switch on'}
                    </Button>
                    <Button variant="danger" className="text-xs" onClick={() => remove(r)}>Delete</Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        isOpen={open}
        title="New social rule"
        onClose={() => setOpen(false)}
        onSubmit={submit}
        submitLabel="Create (switched off)"
        loading={saving}
        maxWidth="max-w-xl"
      >
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">Connected account</span>
            <select
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-2 text-sm text-[var(--text-primary)]"
            >
              <option value="">Choose an account…</option>
              {accounts.map((c) => (
                <option key={`${c.provider}::${c.external_id}`} value={`${c.provider}::${c.external_id}`}>
                  {c.label || c.external_id} ({c.provider})
                </option>
              ))}
            </select>
            {!accounts.length && (
              <span className="mt-1 block text-[11px] text-[var(--text-warning)]">
                No social accounts are connected yet — connect one under Connections first.
              </span>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">When this happens</span>
            <select value={trigger} onChange={(e) => setTrigger(e.target.value)}
              className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-2 text-sm text-[var(--text-primary)]">
              {TRIGGERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">Only if it contains (optional)</span>
            <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="pricing, demo, how much" />
            <span className="mt-1 block text-[11px] text-[var(--text-muted)]">
              Comma-separated. Leave blank and the rule acts on everything — rarely what you want for a public reply.
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">Then do this</span>
            <select value={action} onChange={(e) => setAction(e.target.value)}
              className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-2 text-sm text-[var(--text-primary)]">
              {ACTIONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
            <span className={`mt-1 block text-[11px] ${chosen.public ? 'text-[var(--text-warning)]' : 'text-[var(--text-muted)]'}`}>
              {chosen.blurb}
            </span>
          </label>

          {action === 'reply' && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">Reply message</span>
              <Textarea rows={3} value={template} onChange={(e) => setTemplate(e.target.value)}
                placeholder="Thanks for asking — sending you a DM with details." />
            </label>
          )}

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">Daily limit</span>
            <Input type="number" min={1} max={200} value={cap} onChange={(e) => setCap(Number(e.target.value))} />
            <span className="mt-1 block text-[11px] text-[var(--text-muted)]">
              The most times this rule may act in one day. It stops there, whatever else arrives.
            </span>
          </label>

          {formErr && <p className="text-xs text-[var(--text-negative)]">{formErr}</p>}
        </div>
      </Modal>
    </div>
  );
}
