'use client';
import { useEffect, useState } from 'react';
import AgentConsole from '@/components/AgentConsole';
import { apiGet } from '@/lib/api';

interface Venture { id: string; name: string }

export default function AssistantPage() {
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [brandId, setBrandId] = useState<string | undefined>(undefined);

  useEffect(() => {
    apiGet<{ ventures: Venture[] }>('/api/ventures')
      .then((d) => { const vs = d.ventures || []; setVentures(vs); setBrandId(vs[0]?.id); })
      .catch(() => setVentures([]));
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Assistant</h1>
          <p className="text-sm text-[var(--text-secondary)]">Plain-language commands, executed step by step — you approve anything that spends money.</p>
        </div>
        {ventures.length > 0 && (
          <select
            value={brandId}
            onChange={(e) => setBrandId(e.target.value)}
            className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)]"
          >
            {ventures.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        )}
      </div>
      <AgentConsole key={brandId} brandId={brandId} />
    </div>
  );
}
