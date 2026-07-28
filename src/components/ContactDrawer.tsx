import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Contact, CONTACT_STATUSES } from '@/lib/types';
import Badge, { statusTone } from '@/components/Badge';
import Button from '@/components/Button';

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
  useEffect(() => { setDraft(contact); setEditing(false); }, [contact]);

  if (!isOpen || !contact || !draft) return null;

  const save = () => { onUpdate?.(draft); setEditing(false); };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <h2 className="text-lg font-semibold">{contact.name}</h2>
          <button onClick={onClose} className="text-xl text-slate-400 hover:text-slate-600">✕</button>
        </div>

        <div className="space-y-5 px-6 py-5">
          <div className="flex items-center gap-2">
            <Badge tone="indigo">{contact.segment}</Badge>
            <Badge tone={statusTone(contact.status)}>{contact.status}</Badge>
            <span className="ml-auto text-lg font-bold text-green-600">{contact.score}</span>
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
              <div className="flex gap-2 pt-1">
                <Button onClick={() => setEditing(true)}>Edit</Button>
                {onEnrich && <Button variant="secondary" onClick={() => onEnrich(contact)}>Enrich</Button>}
                <Link href={`/leads/${contact.id}`}><Button variant="secondary">Open full page</Button></Link>
              </div>
            </dl>
          )}

          <div className="border-t border-slate-200 pt-4">
            <h3 className="mb-2 text-sm font-semibold">Engagement Timeline</h3>
            <div className="space-y-1.5 text-sm text-slate-500">
              <p>📧 Email opened — 2 days ago</p>
              <p>🔗 Link clicked — 3 days ago</p>
              <p>📧 Email sent — 4 days ago</p>
            </div>
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
