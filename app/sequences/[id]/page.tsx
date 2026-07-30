'use client';
import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Button from '@/components/Button';
import Input from '@/components/Input';
import Textarea from '@/components/Textarea';
import Badge from '@/components/Badge';
import LoadingSpinner from '@/components/LoadingSpinner';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';

interface Step { id?: string; step_order: number; delay_hours: number; subject: string; body: string; type?: string }
interface Seq { id: string; brand_id: string; name: string; channel: string; is_active: boolean; sequence_steps?: any[] }
interface Enrollment { id: string; status: string; current_step: number; next_run_at?: string; name: string; email: string; contact_id: string }
interface LeadRow { id: string; name: string; email: string }

const enrollTone = (s: string) => (s === 'active' ? 'green' : s === 'replied' ? 'blue' : s === 'completed' ? 'gray' : s === 'paused' ? 'amber' : s === 'bounced' ? 'red' : 'gray');

export default function SequenceDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { notify } = useToast();

  const [seq, setSeq] = useState<Seq | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [enroll, setEnroll] = useState<{ enrollments: Enrollment[]; summary: Record<string, number>; total: number }>({ enrollments: [], summary: {}, total: 0 });
  const [loading, setLoading] = useState(true);
  const [savingSteps, setSavingSteps] = useState(false);
  const [toggling, setToggling] = useState(false);

  // enroll picker
  const [pickerSearch, setPickerSearch] = useState('');
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [enrolling, setEnrolling] = useState(false);

  const loadSeq = useCallback(async () => {
    try {
      const s = await apiGet<Seq>(`/api/sequences/${id}`);
      setSeq(s);
      const st = (s.sequence_steps || []).slice().sort((a: any, b: any) => a.step_order - b.step_order)
        .map((x: any, i: number) => ({ id: x.id, step_order: i, delay_hours: x.delay_hours || 0, subject: x.subject || '', body: x.body || '', type: x.type || 'email' }));
      setSteps(st);
    } catch (e: any) { notify(e.message || 'Sequence not found', 'error'); }
  }, [id, notify]);

  const loadEnrollments = useCallback(async () => {
    try { setEnroll(await apiGet(`/api/sequences/${id}/enrollments`)); } catch { /* keep */ }
  }, [id]);

  useEffect(() => { Promise.all([loadSeq(), loadEnrollments()]).finally(() => setLoading(false)); }, [loadSeq, loadEnrollments]);

  // Load candidate leads for the enroll picker (brand-scoped, server search).
  useEffect(() => {
    if (!seq?.brand_id) return;
    const t = setTimeout(() => {
      const p = new URLSearchParams({ brandId: seq.brand_id, limit: '50' });
      if (pickerSearch.trim()) p.set('q', pickerSearch.trim());
      apiGet<LeadRow[]>(`/api/leads?${p.toString()}`).then((d) => setLeads(Array.isArray(d) ? d : [])).catch(() => setLeads([]));
    }, 250);
    return () => clearTimeout(t);
  }, [seq?.brand_id, pickerSearch]);

  const toggleActive = async () => {
    if (!seq) return;
    setToggling(true);
    try {
      await apiSend(`/api/sequences/${id}`, 'PATCH', { is_active: !seq.is_active });
      setSeq({ ...seq, is_active: !seq.is_active });
      notify(!seq.is_active ? 'Sequence activated — enrolled contacts will send' : 'Sequence paused');
    } catch (e: any) { notify(e.message || 'Failed', 'error'); }
    finally { setToggling(false); }
  };

  const saveSteps = async () => {
    setSavingSteps(true);
    try {
      const payload = steps.map((s, i) => ({ step_order: i, delay_hours: s.delay_hours || 0, subject: s.subject, body: s.body, type: 'email' }));
      await apiSend(`/api/sequences/${id}`, 'PATCH', { steps: payload });
      notify('Steps saved');
      loadSeq();
    } catch (e: any) { notify(e.message || 'Save failed', 'error'); }
    finally { setSavingSteps(false); }
  };

  const setStep = (i: number, patch: Partial<Step>) => setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const addStep = () => setSteps((prev) => [...prev, { step_order: prev.length, delay_hours: prev.length === 0 ? 0 : 72, subject: '', body: '' }]);
  const removeStep = (i: number) => setSteps((prev) => prev.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => setSteps((prev) => {
    const j = i + dir; if (j < 0 || j >= prev.length) return prev;
    const next = [...prev]; [next[i], next[j]] = [next[j], next[i]]; return next;
  });

  const pickedIds = Object.keys(picked).filter((k) => picked[k]);
  const doEnroll = async () => {
    if (!pickedIds.length) { notify('Select at least one lead', 'error'); return; }
    setEnrolling(true);
    try {
      const r = await apiSend<{ enrolled: number }>(`/api/sequences/${id}/enroll`, 'POST', { contactIds: pickedIds });
      notify(`Enrolled ${r.enrolled} contact${r.enrolled === 1 ? '' : 's'}${seq?.is_active ? '' : ' — activate the sequence to start sending'}`);
      setPicked({});
      loadEnrollments();
    } catch (e: any) { notify(e.message || 'Enroll failed', 'error'); }
    finally { setEnrolling(false); }
  };

  const remove = async () => {
    if (!confirm('Delete this sequence? Enrollments are removed too.')) return;
    try { await apiSend(`/api/sequences/${id}`, 'DELETE'); notify('Deleted'); router.push('/sequences'); }
    catch (e: any) { notify(e.message || 'Delete failed', 'error'); }
  };

  if (loading) return <LoadingSpinner label="Loading sequence…" />;
  if (!seq) return <div className="p-8 text-center text-sm text-slate-500">Sequence not found. <Link href="/sequences" className="text-indigo-600 underline">Back</Link></div>;

  const alreadyEnrolled = new Set(enroll.enrollments.map((e) => e.contact_id));

  return (
    <div className="space-y-6">
      <div>
        <Link href="/sequences" className="text-sm text-indigo-600 hover:underline">← All sequences</Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{seq.name}</h1>
            <Badge tone={seq.is_active ? 'green' : 'gray'}>{seq.is_active ? 'active' : 'paused'}</Badge>
          </div>
          <div className="flex gap-2">
            <Button variant={seq.is_active ? 'secondary' : 'primary'} loading={toggling} onClick={toggleActive}>
              {seq.is_active ? '⏸ Pause' : '▶ Activate'}
            </Button>
            <Button variant="danger" onClick={remove}>Delete</Button>
          </div>
        </div>
        {!seq.is_active && <p className="mt-1 text-xs text-amber-600">Paused sequences do not send. Activate to start the cadence for enrolled contacts.</p>}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Steps editor */}
        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Cadence steps</h2>
            <Button variant="secondary" onClick={addStep}>+ Add step</Button>
          </div>
          {steps.length === 0 && <p className="text-sm text-slate-500">No steps yet. Add the first one (delay 0 = sends on enroll).</p>}
          {steps.map((s, i) => (
            <div key={i} className="rounded-lg border border-slate-200 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500">Step {i + 1}</span>
                <div className="flex items-center gap-1 text-xs">
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="px-1 text-slate-400 disabled:opacity-30 hover:text-slate-700">↑</button>
                  <button onClick={() => move(i, 1)} disabled={i === steps.length - 1} className="px-1 text-slate-400 disabled:opacity-30 hover:text-slate-700">↓</button>
                  <button onClick={() => removeStep(i)} className="ml-1 text-red-500 hover:text-red-700">✕</button>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Wait</span>
                <input type="number" min={0} value={Math.round((s.delay_hours || 0) / 24)}
                  onChange={(e) => setStep(i, { delay_hours: Math.max(0, Number(e.target.value)) * 24 })}
                  className="w-16 rounded border border-slate-300 px-2 py-1 text-sm" />
                <span className="text-xs text-slate-500">days, then email</span>
              </div>
              <Input placeholder="Subject" value={s.subject} onChange={(e) => setStep(i, { subject: e.target.value })} />
              <Textarea rows={3} placeholder="Body — use {{name}}, {{company}}" value={s.body} onChange={(e) => setStep(i, { body: e.target.value })} />
            </div>
          ))}
          <Button onClick={saveSteps} loading={savingSteps} disabled={!steps.length}>Save steps</Button>
        </div>

        {/* Enroll + enrollments */}
        <div className="space-y-4">
          <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="font-semibold">Enroll leads</h2>
            <Input placeholder="Search this venture's leads by name/email/company…" value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)} />
            <div className="max-h-56 overflow-auto rounded border border-slate-200 divide-y divide-slate-100">
              {leads.length === 0 && <div className="p-3 text-sm text-slate-500">No leads found.</div>}
              {leads.map((l) => {
                const enrolled = alreadyEnrolled.has(l.id);
                return (
                  <label key={l.id} className={`flex items-center gap-2 p-2 text-sm ${enrolled ? 'opacity-50' : 'cursor-pointer hover:bg-slate-50'}`}>
                    <input type="checkbox" disabled={enrolled} checked={!!picked[l.id]} onChange={(e) => setPicked((p) => ({ ...p, [l.id]: e.target.checked }))} />
                    <span className="flex-1"><span className="font-medium">{l.name}</span> <span className="text-slate-500">{l.email}</span></span>
                    {enrolled && <span className="text-xs text-slate-400">enrolled</span>}
                  </label>
                );
              })}
            </div>
            <Button onClick={doEnroll} loading={enrolling} disabled={!pickedIds.length}>
              Enroll {pickedIds.length || ''} {pickedIds.length === 1 ? 'contact' : 'contacts'}
            </Button>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold">Enrolled ({enroll.total})</h2>
              <div className="flex flex-wrap gap-1">
                {Object.entries(enroll.summary).map(([st, n]) => <Badge key={st} tone={enrollTone(st)}>{st} {n}</Badge>)}
              </div>
            </div>
            <div className="max-h-72 overflow-auto divide-y divide-slate-100">
              {enroll.enrollments.length === 0 && <p className="p-2 text-sm text-slate-500">No one enrolled yet. Use the picker above.</p>}
              {enroll.enrollments.map((e) => (
                <div key={e.id} className="flex items-center justify-between p-2 text-sm">
                  <span className="flex-1"><span className="font-medium">{e.name}</span> <span className="text-slate-500">{e.email}</span></span>
                  <span className="text-xs text-slate-400">step {(e.current_step ?? 0) + 1}</span>
                  <Badge tone={enrollTone(e.status)}>{e.status}</Badge>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
