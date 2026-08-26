'use client';
import { useCallback, useEffect, useState } from 'react';
import Button from '@/components/Button';
import Badge from '@/components/Badge';
import Modal from '@/components/Modal';
import Input from '@/components/Input';
import EmptyState from '@/components/EmptyState';
import LoadingSpinner from '@/components/LoadingSpinner';
import { apiGet, apiSend } from '@/lib/api';

// CRM automations — standing rules that fire on a CRM event.
//
// These existed in the database, the API and the assistant's capability list,
// and had no screen at all. So a rule could be created by asking the assistant
// and then never seen again: you could not check what was running, what it had
// done, or switch it off without asking for it by name. A standing rule you
// cannot audit is the one kind you should least be allowed to forget about.
//
// TRIGGERS ARE ENUMERATED, NOT FREE TEXT, and the list is short for a real
// reason: evaluateAutomations is called from exactly two places in the
// codebase. A rule on any other trigger string would save fine, look correct
// here, and never once fire. Offering a picker of triggers that cannot happen
// would be the UI lying quietly.

interface Automation {
  id: string;
  name: string;
  trigger: { type?: string } | string;
  filter: { match?: string; conditions?: { field: string; op: string; value?: any }[] };
  action: { type?: string; config?: Record<string, any> };
  is_active: boolean;
  run_count: number;
  last_run_at: string | null;
}

const TRIGGERS: { id: string; label: string; blurb: string }[] = [
  { id: 'contact.created', label: 'A lead is added', blurb: 'Fires once, the moment a contact first lands in the CRM.' },
  { id: 'email.replied', label: 'A lead replies to an email', blurb: 'Fires when a reply is detected against an outreach sequence.' },
];

const ACTIONS: { id: string; label: string; blurb: string; needs?: string }[] = [
  { id: 'add_tag', label: 'Add a tag', blurb: 'Label the contact.', needs: 'tag' },
  { id: 'set_status', label: 'Set the status', blurb: 'Move it to a pipeline status.', needs: 'status' },
  { id: 'update_score', label: 'Change the lead score', blurb: 'Add to or subtract from the score.', needs: 'delta' },
  { id: 'enroll_sequence', label: 'Start an outreach sequence', blurb: 'Enrol the contact. This sends email.', needs: 'sequenceId' },
  { id: 'create_task', label: 'Create a task', blurb: 'Put a to-do on the board.', needs: 'title' },
  { id: 'suppress', label: 'Suppress the contact', blurb: 'Stop all outbound email to them.' },
  { id: 'send_webhook', label: 'Send a webhook', blurb: 'POST the event to a URL you control.', needs: 'url' },
];

const OPS = [
  { id: 'eq', label: 'is' }, { id: 'neq', label: 'is not' },
  { id: 'contains', label: 'contains' },
  { id: 'gt', label: 'is more than' }, { id: 'lt', label: 'is less than' },
  { id: 'exists', label: 'is set' }, { id: 'not_exists', label: 'is empty' },
];

const triggerId = (a: Automation) => (typeof a.trigger === 'string' ? a.trigger : a.trigger?.type) || '';
const labelFor = (list: { id: string; label: string }[], id: string) =>
  list.find((x) => x.id === id)?.label || id;

export default function Automations() {
  const [rows, setRows] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState(TRIGGERS[0].id);
  const [action, setAction] = useState(ACTIONS[0].id);
  const [configValue, setConfigValue] = useState('');
  const [condField, setCondField] = useState('');
  const [condOp, setCondOp] = useState('eq');
  const [condValue, setCondValue] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows((await apiGet<Automation[]>('/api/automations')) || []);
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not load automations.' });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  function openCreate() {
    setName(''); setTrigger(TRIGGERS[0].id); setAction(ACTIONS[0].id);
    setConfigValue(''); setCondField(''); setCondOp('eq'); setCondValue('');
    setFormErr(null); setOpen(true);
  }

  const chosenAction = ACTIONS.find((a) => a.id === action)!;

  async function submit() {
    if (!name.trim()) { setFormErr('Give the rule a name you will recognise later.'); return; }
    if (chosenAction.needs && !configValue.trim()) {
      setFormErr(`"${chosenAction.label}" needs a value.`);
      return;
    }
    setSaving(true); setFormErr(null);
    try {
      const conditions = condField.trim()
        ? [{ field: condField.trim(), op: condOp, value: condValue || undefined }]
        : [];
      await apiSend('/api/automations', 'POST', {
        name: name.trim(),
        trigger: { type: trigger },
        filter: { match: 'all', conditions },
        action: { type: action, config: chosenAction.needs ? { [chosenAction.needs]: configValue.trim() } : {} },
        // Created switched OFF, always. Creating a rule that acts on your
        // behalf and arming it are two separate decisions.
        is_active: false,
      });
      setOpen(false);
      setMsg({ ok: true, text: 'Rule created — switched off. Turn it on when you are ready for it to act.' });
      void load();
    } catch (e: any) {
      setFormErr(e?.message || 'Could not create that rule.');
    } finally {
      setSaving(false);
    }
  }

  async function toggle(a: Automation) {
    try {
      await apiSend(`/api/automations/${a.id}`, 'PATCH', { is_active: !a.is_active });
      void load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not change that rule.' });
    }
  }

  async function remove(a: Automation) {
    try {
      await apiSend(`/api/automations/${a.id}`, 'DELETE');
      void load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not delete that rule.' });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-[var(--text-secondary)]">
          Standing rules that run on their own when something happens in the CRM. Every rule is created switched
          off — turning it on is a separate, deliberate step, because from then on it acts without asking.
        </p>
        <Button variant="secondary" className="shrink-0 text-xs" onClick={openCreate}>+ New rule</Button>
      </div>

      {msg && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${msg.ok ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="⚙"
          title="No CRM rules yet"
          hint="A rule can tag a new lead, change its status, start a sequence, or call a webhook — automatically."
        />
      ) : (
        <div className="space-y-2">
          {rows.map((a) => (
            <div key={a.id} className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{a.name}</span>
                    <Badge tone={a.is_active ? 'green' : 'gray'}>{a.is_active ? 'on' : 'off'}</Badge>
                  </div>
                  {/* The rule stated as a sentence. A row of raw JSON keys is
                      not something anyone can audit at a glance, and auditing
                      at a glance is the entire job of this screen. */}
                  <p className="mt-1 text-[13px] text-[var(--text-secondary)]">
                    When <strong>{labelFor(TRIGGERS, triggerId(a)).toLowerCase()}</strong>
                    {a.filter?.conditions?.length
                      ? <> and {a.filter.conditions.map((c, i) => (
                          <span key={i}>{i > 0 ? ' and ' : ''}<code className="font-mono text-[12px]">{c.field}</code> {labelFor(OPS, c.op)} {c.value !== undefined ? <code className="font-mono text-[12px]">{String(c.value)}</code> : ''}</span>
                        ))}</>
                      : null}
                    , {labelFor(ACTIONS, a.action?.type || '').toLowerCase()}.
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                    Run {a.run_count} time{a.run_count === 1 ? '' : 's'}
                    {a.last_run_at ? ` · last ${new Date(a.last_run_at).toLocaleString()}` : ' · never yet'}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="ghost" className="text-xs" onClick={() => toggle(a)}>
                    {a.is_active ? 'Switch off' : 'Switch on'}
                  </Button>
                  <Button variant="danger" className="text-xs" onClick={() => remove(a)}>Delete</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        isOpen={open}
        title="New CRM rule"
        onClose={() => setOpen(false)}
        onSubmit={submit}
        submitLabel="Create (switched off)"
        loading={saving}
        maxWidth="max-w-xl"
      >
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tag inbound demo requests" />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">When this happens</span>
            <select
              value={trigger}
              onChange={(e) => setTrigger(e.target.value)}
              className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-2 text-sm text-[var(--text-primary)]"
            >
              {TRIGGERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <span className="mt-1 block text-[11px] text-[var(--text-muted)]">
              {TRIGGERS.find((t) => t.id === trigger)?.blurb}
            </span>
          </label>

          <fieldset className="rounded-lg border border-[var(--border-default)] p-3">
            <legend className="px-1 text-xs font-medium text-[var(--text-secondary)]">Only if… (optional)</legend>
            <div className="flex flex-wrap gap-2">
              <Input value={condField} onChange={(e) => setCondField(e.target.value)} placeholder="contact.status" className="flex-1" />
              <select
                value={condOp}
                onChange={(e) => setCondOp(e.target.value)}
                className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] px-2 py-2 text-sm"
              >
                {OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              <Input value={condValue} onChange={(e) => setCondValue(e.target.value)} placeholder="value" className="flex-1" />
            </div>
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">
              Leave blank to run on every event. Fields are dotted paths into the event, like <code className="font-mono">contact.score</code>.
            </p>
          </fieldset>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">Then do this</span>
            <select
              value={action}
              onChange={(e) => { setAction(e.target.value); setConfigValue(''); }}
              className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-2 text-sm text-[var(--text-primary)]"
            >
              {ACTIONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
            <span className="mt-1 block text-[11px] text-[var(--text-muted)]">{chosenAction.blurb}</span>
          </label>

          {chosenAction.needs && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">{chosenAction.needs}</span>
              <Input value={configValue} onChange={(e) => setConfigValue(e.target.value)} placeholder={chosenAction.needs} />
            </label>
          )}

          {formErr && <p className="text-xs text-[var(--text-negative)]">{formErr}</p>}
          <p className="text-[11px] text-[var(--text-muted)]">
            The rule is created switched off and does nothing until you turn it on.
          </p>
        </div>
      </Modal>
    </div>
  );
}
