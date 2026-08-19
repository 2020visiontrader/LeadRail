'use client';
import { useEffect, useState, useCallback } from 'react';
import Button from '@/components/Button';
import Input from '@/components/Input';
import Textarea from '@/components/Textarea';
import Dropdown from '@/components/Dropdown';
import Badge from '@/components/Badge';
import LoadingSpinner from '@/components/LoadingSpinner';
import { apiGet, apiSend } from '@/lib/api';
import { SKILLS, explainSkillSelection } from '@/lib/skills/registry';

// A venture's stored sender persona. Everything is optional — a venture with no
// persona still sends, using the platform defaults.
interface Venture {
  id: string;
  name: string;
  sender_name?: string | null;
  sender_role?: string | null;
  sender_email?: string | null;
  pitch?: string | null;
  tone?: string | null;
  signature?: string | null;
  default_cta?: string | null;
  skills?: string[] | null;
}

interface Draft {
  senderName: string;
  senderRole: string;
  senderEmail: string;
  pitch: string;
  tone: string;
  signature: string;
  defaultCta: string;
  skillMode: 'auto' | 'manual';
  skills: string[];
}

const TONE_OPTIONS = [
  { value: '', label: 'Default — direct, warm, professional' },
  { value: 'direct, warm, professional', label: 'Direct, warm, professional' },
  { value: 'friendly and conversational', label: 'Friendly & conversational' },
  { value: 'formal, concise, businesslike', label: 'Formal & concise' },
  { value: 'confident, bold, high-energy', label: 'Confident & bold' },
  { value: 'consultative, expert, measured', label: 'Consultative & expert' },
];

function toDraft(v: Venture): Draft {
  const skills = Array.isArray(v.skills) ? v.skills.filter((s) => s && s !== 'auto') : [];
  const isAuto = !Array.isArray(v.skills) || v.skills.length === 0 || v.skills.includes('auto');
  return {
    senderName: v.sender_name || '',
    senderRole: v.sender_role || '',
    senderEmail: v.sender_email || '',
    pitch: v.pitch || '',
    tone: v.tone || '',
    signature: v.signature || '',
    defaultCta: v.default_cta || '',
    skillMode: isAuto ? 'auto' : 'manual',
    skills,
  };
}

function VentureCard({ venture, onSaved }: { venture: Venture; onSaved: (v: Venture) => void }) {
  const [d, setD] = useState<Draft>(() => toDraft(venture));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const set = (patch: Partial<Draft>) => { setD((prev) => ({ ...prev, ...patch })); setMsg(null); };
  const toggleSkill = (id: string) =>
    setD((prev) => ({ ...prev, skills: prev.skills.includes(id) ? prev.skills.filter((s) => s !== id) : [...prev.skills, id] }));

  const configured = !!(venture.sender_name || venture.sender_email || venture.pitch);

  // Live preview of which skills the AI-goal box will attach in Auto mode. Uses
  // the same selector the generator runs, so it never misrepresents behavior.
  const autoPreview = explainSkillSelection('book a 15-minute intro call', d.skillMode === 'auto' ? ['auto'] : d.skills);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const skills = d.skillMode === 'auto' ? ['auto'] : (d.skills.length ? d.skills : ['auto']);
      const r = await apiSend<{ venture: Venture }>(`/api/ventures/${venture.id}`, 'PATCH', {
        senderName: d.senderName.trim(),
        senderRole: d.senderRole.trim(),
        senderEmail: d.senderEmail.trim(),
        pitch: d.pitch.trim(),
        tone: d.tone,
        signature: d.signature,
        defaultCta: d.defaultCta.trim(),
        skills,
      });
      onSaved(r.venture);
      setMsg({ ok: true, text: 'Saved' });
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not save' });
    } finally { setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4">
      <button className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setOpen((o) => !o)}>
        <div>
          <div className="font-semibold">{venture.name}</div>
          <div className="text-xs text-[var(--text-muted)]">
            {venture.sender_name ? `Sends as ${venture.sender_name}${venture.sender_email ? ` <${venture.sender_email}>` : ''}` : 'No sender profile yet'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={configured ? 'green' : 'gray'}>{configured ? 'configured' : 'not set'}</Badge>
          <span className="text-[var(--text-muted)]">{open ? '▲' : '▼'}</span>
        </div>
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Your name" placeholder="e.g. Franck Fon" value={d.senderName} onChange={(e) => set({ senderName: e.target.value })} />
            <Input label="Your role at this brand" placeholder="e.g. Co-founder" value={d.senderRole} onChange={(e) => set({ senderRole: e.target.value })} />
          </div>
          <Input label="Sender / reply-to email" type="email" placeholder="you@yourbrand.com" value={d.senderEmail} onChange={(e) => set({ senderEmail: e.target.value })} />
          <Textarea label="One-line pitch (what the AI grounds on)" rows={2} placeholder="For [audience] who [need], [brand] is a [category] that [benefit]." value={d.pitch} onChange={(e) => set({ pitch: e.target.value })} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Dropdown label="Default tone" options={TONE_OPTIONS} value={d.tone} onChange={(e) => set({ tone: e.target.value })} />
            <Input label="Default ask (CTA)" placeholder="e.g. a 15-min intro call" value={d.defaultCta} onChange={(e) => set({ defaultCta: e.target.value })} />
          </div>
          <Textarea label="Signature block" rows={3} placeholder={`${d.senderName || 'Your name'}\n${d.senderRole || 'Role'}, ${venture.name}`} value={d.signature} onChange={(e) => set({ signature: e.target.value })} />

          <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-muted,transparent)] p-3">
            <div className="mb-2 text-sm font-medium text-[var(--text-secondary)]">Skills</div>
            <div className="flex gap-2">
              <button
                onClick={() => set({ skillMode: 'auto' })}
                className={`rounded-md border px-3 py-1.5 text-xs ${d.skillMode === 'auto' ? 'border-[var(--brand)] bg-[var(--brand)]/10 font-medium text-[var(--brand)]' : 'border-[var(--border-strong)] text-[var(--text-secondary)]'}`}
              >Auto (goal-driven) — recommended</button>
              <button
                onClick={() => set({ skillMode: 'manual' })}
                className={`rounded-md border px-3 py-1.5 text-xs ${d.skillMode === 'manual' ? 'border-[var(--brand)] bg-[var(--brand)]/10 font-medium text-[var(--brand)]' : 'border-[var(--border-strong)] text-[var(--text-secondary)]'}`}
              >Choose skills</button>
            </div>

            {d.skillMode === 'auto' ? (
              <p className="mt-2 text-xs text-[var(--text-muted)]">
                The AI-goal box picks the skills per email. A goal like “book a call” → {autoPreview.map((s) => s.name).join(', ')}.
              </p>
            ) : (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {SKILLS.map((s) => (
                  <label key={s.id} className="flex items-start gap-2 text-xs text-[var(--text-secondary)]">
                    <input type="checkbox" checked={d.skills.includes(s.id)} onChange={() => toggleSkill(s.id)} className="mt-0.5" />
                    <span><span className="font-medium">{s.name}</span> — {s.when}</span>
                  </label>
                ))}
                <p className="text-[11px] text-[var(--text-muted)] sm:col-span-2">Grounding + humanizer are always applied on send, even if unchecked.</p>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={save} loading={busy} className="text-xs">Save profile</Button>
            {msg && <span className={`text-xs ${msg.ok ? 'text-green-600' : 'text-red-600'}`}>{msg.text}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SenderProfiles() {
  const [ventures, setVentures] = useState<Venture[] | null>(null);

  const load = useCallback(() => {
    apiGet<{ ventures: Venture[] }>('/api/ventures')
      .then((d) => setVentures(d.ventures || []))
      .catch(() => setVentures([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const onSaved = (v: Venture) => setVentures((prev) => (prev || []).map((x) => (x.id === v.id ? { ...x, ...v } : x)));

  return (
    <div className="space-y-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
      <div>
        <h2 className="text-lg font-semibold">Sender profiles</h2>
        <p className="text-sm text-[var(--text-secondary)]">
          One persona per venture — who you are, how you sound, and what the AI grounds on. Each venture emails as itself, and the AI-goal box picks the right skills at generation time.
        </p>
      </div>
      {ventures === null ? (
        <LoadingSpinner />
      ) : ventures.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No brands yet. Create a brand first, then set its sender profile here.</p>
      ) : (
        <div className="space-y-3">
          {ventures.map((v) => <VentureCard key={v.id} venture={v} onSaved={onSaved} />)}
        </div>
      )}
    </div>
  );
}
