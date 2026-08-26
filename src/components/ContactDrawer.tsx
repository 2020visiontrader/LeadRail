import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Contact, CONTACT_STATUSES } from '@/lib/types';
import Badge, { statusTone } from '@/components/Badge';
import Button from '@/components/Button';
import { apiGet, apiSend } from '@/lib/api';

interface SeqLite { id: string; name: string; is_active: boolean }
interface TimelineItem { id: string; kind: string; title?: string | null; body?: string | null; at: string }
const TL_ICON: Record<string, string> = {
  email_open: '📧', email_click: '🔗', email_sent: '✉️', note: '📝',
  status_change: '🔀', enrich: '✨', activity: '📌', deal: '💼',
};
const timeAgo = (iso: string) => {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};

interface Props {
  contact: Contact | null;
  isOpen: boolean;
  onClose: () => void;
  onUpdate?: (contact: Contact) => void;
  onDelete?: (contact: Contact) => void;
  onEnrich?: (contact: Contact) => void;
}

export default function ContactDrawer({ contact, isOpen, onClose, onUpdate, onDelete, onEnrich }: Props) {
  const [draft, setDraft] = useState<Contact | null>(contact);
  const [editing, setEditing] = useState(false);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [tlLoading, setTlLoading] = useState(false);
  const [sequences, setSequences] = useState<SeqLite[]>([]);
  const [seqId, setSeqId] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  useEffect(() => { setDraft(contact); setEditing(false); }, [contact]);

  useEffect(() => {
    if (!isOpen || !contact?.brand_id) { setSequences([]); return; }
    setSeqId('');
    apiGet<SeqLite[]>(`/api/sequences?brandId=${contact.brand_id}`)
      .then((d) => setSequences(Array.isArray(d) ? d : []))
      .catch(() => setSequences([]));
  }, [isOpen, contact?.brand_id]);

  const enrollInSequence = async () => {
    if (!seqId || !contact) return;
    setEnrolling(true);
    try {
      await apiSend(`/api/sequences/${seqId}/enroll`, 'POST', { contactIds: [contact.id] });
      const s = sequences.find((x) => x.id === seqId);
      alert(`Added ${contact.name} to “${s?.name}”.${s && !s.is_active ? ' Activate the sequence to start sending.' : ''}`);
      setSeqId('');
    } catch (e: any) { alert(e?.message || 'Enroll failed'); }
    finally { setEnrolling(false); }
  };

  useEffect(() => {
    if (!isOpen || !contact?.id) return;
    setTlLoading(true); setTimeline([]);
    apiGet<{ timeline: TimelineItem[] }>(`/api/contacts/${contact.id}/timeline?limit=50`)
      .then((d) => setTimeline(Array.isArray(d.timeline) ? d.timeline : []))
      .catch(() => setTimeline([]))
      .finally(() => setTlLoading(false));
  }, [isOpen, contact?.id]);

  if (!isOpen || !contact || !draft) return null;

  const save = () => { onUpdate?.(draft); setEditing(false); };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <h2 className="text-lg font-semibold">{contact.name}</h2>
          <button onClick={onClose} aria-label="Close" title="Close" className="text-xl text-slate-400 hover:text-slate-600"><span aria-hidden>✕</span></button>
        </div>

        <div className="space-y-5 px-6 py-5">
          <div className="flex items-center gap-2">
            <Badge tone="indigo">{contact.segment}</Badge>
            <Badge tone={statusTone(contact.status)}>{contact.status}</Badge>
            <span className="ml-auto text-lg font-bold text-[var(--text-positive)]">{contact.score}</span>
          </div>

          {editing ? (
            <div className="space-y-3">
              {(['name', 'email', 'company', 'title'] as const).map((f) => (
                <label key={f} className="block">
                  <span className="mb-1 block text-xs font-medium uppercase text-slate-500">{f}</span>
                  <input
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                    value={(draft[f] as string) || ''}
                    onChange={(e) => setDraft({ ...draft, [f]: e.target.value })}
                  />
                </label>
              ))}
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase text-slate-500">status</span>
                <select className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value={draft.status}
                  onChange={(e) => setDraft({ ...draft, status: e.target.value as Contact['status'] })}>
                  {CONTACT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <div className="flex gap-2 pt-1">
                <Button onClick={save}>Save</Button>
                <Button variant="secondary" onClick={() => { setDraft(contact); setEditing(false); }}>Cancel</Button>
              </div>
            </div>
          ) : (
            <dl className="space-y-3 text-sm">
              <Row label="Email" value={contact.email} />
              <Row label="Company" value={contact.company || '—'} />
              <Row label="Title" value={contact.title || '—'} />
              {contact.fit_verdict && (
                <Row label="Fit" value={`${contact.fit_verdict}${contact.enrichment_status ? ` · ${contact.enrichment_status}` : ''}`} />
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button onClick={() => setEditing(true)}>Edit</Button>
                {onEnrich && <Button variant="secondary" onClick={() => onEnrich(contact)}>Enrich</Button>}
                <Link href={`/outreach?contactId=${contact.id}&brandId=${contact.brand_id}`}><Button>✉️ Outreach</Button></Link>
                <Link href={`/leads/${contact.id}`}><Button variant="secondary">Open full page</Button></Link>
              </div>
            </dl>
          )}

          <div className="border-t border-slate-200 pt-4">
            <h3 className="mb-2 text-sm font-semibold">Add to sequence</h3>
            {sequences.length === 0 ? (
              <p className="text-sm text-slate-400">No sequences for this brand yet. <Link href="/sequences" className="text-indigo-600 underline">Create one</Link>.</p>
            ) : (
              <div className="flex items-center gap-2">
                <select value={seqId} onChange={(e) => setSeqId(e.target.value)}
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm">
                  <option value="">Select a sequence…</option>
                  {sequences.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_active ? '' : ' (paused)'}</option>)}
                </select>
                <Button loading={enrolling} disabled={!seqId} onClick={enrollInSequence}>Enroll</Button>
              </div>
            )}
          </div>

          <div className="border-t border-slate-200 pt-4">
            <h3 className="mb-2 text-sm font-semibold">Engagement Timeline</h3>
            {tlLoading ? (
              <p className="text-sm text-slate-400">Loading activity…</p>
            ) : timeline.length === 0 ? (
              <p className="text-sm text-slate-400">No activity yet. Opens, clicks, notes and status changes will appear here.</p>
            ) : (
              <div className="space-y-1.5 text-sm text-slate-600">
                {timeline.map((t) => (
                  <div key={t.id} className="flex items-start gap-2">
                    <span aria-hidden>{TL_ICON[t.kind] || '•'}</span>
                    <span className="flex-1">
                      {t.title || t.kind.replace(/_/g, ' ')}
                      {t.body ? <span className="text-slate-400"> — {t.body}</span> : null}
                    </span>
                    <span className="whitespace-nowrap text-xs text-slate-400">{timeAgo(t.at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <Button variant="danger" className="w-full" onClick={() => onDelete?.(contact)}>Delete Contact</Button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase text-slate-400">{label}</dt>
      <dd className="text-slate-800">{value}</dd>
    </div>
  );
}
