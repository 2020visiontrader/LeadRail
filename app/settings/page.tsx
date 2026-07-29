'use client';
import { useEffect, useState } from 'react';
import Badge from '@/components/Badge';
import LoadingSpinner from '@/components/LoadingSpinner';
import { apiGet } from '@/lib/api';

const META: Record<string, { label: string; desc: string }> = {
  supabase: { label: 'Supabase', desc: 'Database & auth' },
  apollo: { label: 'Apollo', desc: 'Lead sourcing & enrichment' },
  gemini: { label: 'Gemini (Nano Banana)', desc: 'AI text + static image generation' },
  brevo: { label: 'Brevo', desc: 'Email delivery' },
  resend: { label: 'Resend', desc: 'Email delivery (alt)' },
  postiz: { label: 'Postiz', desc: 'Social scheduling (8 platforms)' },
  meta: { label: 'Meta', desc: 'Instagram / Facebook ads' },
  google_ads: { label: 'Google Ads', desc: 'Search & display campaigns' },
  nim: { label: 'NVIDIA NIM', desc: 'AI generation (alt)' },
};

export default function Settings() {
  const [status, setStatus] = useState<Record<string, boolean> | null>(null);
  const [dbReady, setDbReady] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    apiGet('/api/integrations').then((r) => { setStatus(r.integrations); setDbReady(r.db_ready); }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-slate-500">Integration hub — live connection status</p>
      </div>

      {loading ? <LoadingSpinner /> : (
        <>
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
            Database: {dbReady ? <Badge tone="green">connected</Badge> : <Badge tone="amber">not configured</Badge>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {Object.entries(META).map(([key, m]) => {
              const on = status?.[key];
              return (
                <div key={key} className="flex items-start justify-between rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div>
                    <h3 className="font-semibold">{m.label}</h3>
                    <p className="text-sm text-slate-500">{m.desc}</p>
                  </div>
                  <Badge tone={on ? 'green' : 'gray'}>{on ? 'connected' : 'off'}</Badge>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-slate-400">
            Set API keys as environment variables (see <code>.env.local.example</code>). Connection reflects which keys are present.
          </p>
        </>
      )}
    </div>
  );
}
