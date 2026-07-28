'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import Badge from '@/components/Badge';
import EmailPreview from '@/components/EmailPreview';
import LoadingSpinner from '@/components/LoadingSpinner';
import { apiGet } from '@/lib/api';

interface Template { id: string; segment: string; name: string; subject: string; body: string; }

export default function Templates() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [active, setActive] = useState<Template | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { apiGet<Template[]>('/api/outreach/templates').then((t) => { setTemplates(t); setActive(t[0] || null); }).catch(() => {}).finally(() => setLoading(false)); }, []);

  if (loading) return <LoadingSpinner />;
  return (
    <div className="space-y-6">
      <div>
        <Link href="/outreach" className="text-sm text-indigo-600 hover:underline">← Back to outreach</Link>
        <h1 className="mt-2 text-2xl font-bold">Templates</h1>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <ul className="space-y-2">
          {templates.map((t) => (
            <li key={t.id}>
              <button onClick={() => setActive(t)} className={`w-full rounded-lg border p-3 text-left text-sm ${active?.id === t.id ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                <div className="flex items-center justify-between"><span className="font-medium">{t.name}</span><Badge tone="indigo">{t.segment}</Badge></div>
              </button>
            </li>
          ))}
        </ul>
        <div className="lg:col-span-2">
          {active && <EmailPreview subject={active.subject} html={active.body} />}
        </div>
      </div>
    </div>
  );
}
