'use client';
import { useEffect, useState, useCallback } from 'react';
import Button from '@/components/Button';
import Input from '@/components/Input';
import Badge from '@/components/Badge';
import KPICard from '@/components/KPICard';
import LoadingSpinner from '@/components/LoadingSpinner';
import { apiGet, apiSend } from '@/lib/api';

interface Stats {
  code: { code: string; reward_type: string; reward_amount: number } | null;
  clicks: number; signups: number; qualified: number;
  rewards: { held: number; payable: number; paid: number };
}

export default function Referrals() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [desired, setDesired] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);
  const [origin, setOrigin] = useState('');

  useEffect(() => { setOrigin(window.location.origin); }, []);
  const load = useCallback(() => {
    setLoading(true);
    apiGet('/api/referrals/stats').then(setStats).catch(() => {}).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function createCode() {
    setBusy(true);
    try { await apiSend('/api/referrals/code', 'POST', desired ? { desired } : {}); load(); }
    catch (e: any) { alert(e?.message || 'Could not create code'); }
    finally { setBusy(false); }
  }

  function copy(text: string, which: 'link' | 'code') {
    navigator.clipboard.writeText(text).then(() => { setCopied(which); setTimeout(() => setCopied(null), 1500); });
  }

  const code = stats?.code?.code;
  const link = code ? `${origin}/r/${code}` : '';

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Ambassador program</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Share your link or code. You earn on every referral that converts; your friend gets a reward too.
        </p>
      </div>

      {loading ? <LoadingSpinner /> : !code ? (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-6">
          <h2 className="font-semibold">Create your ambassador code</h2>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Pick a memorable handle (letters/numbers). It becomes your link <code>/r/YOURCODE</code> and the code
            people can type at signup — for TikToks, podcasts, or anywhere a link can’t be clicked.
          </p>
          <div className="mt-4 flex items-end gap-2">
            <div className="flex-1">
              <Input label="Your code (optional)" placeholder="e.g. AISHA" value={desired}
                onChange={(e) => setDesired((e.target as HTMLInputElement).value.toUpperCase())} />
            </div>
            <Button onClick={createCode} loading={busy}>Create code</Button>
          </div>
        </div>
      ) : (
        <>
          {/* Link + code */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
              <div className="text-xs font-medium text-[var(--text-muted)]">YOUR LINK</div>
              <div className="mt-1 break-all font-mono text-sm">{link}</div>
              <Button variant="secondary" className="mt-3 text-xs" onClick={() => copy(link, 'link')}>
                {copied === 'link' ? 'Copied ✓' : 'Copy link'}
              </Button>
            </div>
            <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
              <div className="text-xs font-medium text-[var(--text-muted)]">YOUR CODE</div>
              <div className="mt-1 font-mono text-2xl font-bold tracking-wide">{code}</div>
              <Button variant="secondary" className="mt-3 text-xs" onClick={() => copy(code, 'code')}>
                {copied === 'code' ? 'Copied ✓' : 'Copy code'}
              </Button>
            </div>
          </div>

          {/* Funnel */}
          <div className="grid gap-4 sm:grid-cols-4">
            <KPICard label="Clicks" value={stats!.clicks} icon="👆" />
            <KPICard label="Signups" value={stats!.signups} icon="✍️" />
            <KPICard label="Qualified" value={stats!.qualified} icon="✅" />
            <KPICard label="Earned" value={`${stats!.rewards.held + stats!.rewards.payable + stats!.rewards.paid}`}
              sub={`${stats!.code?.reward_type || 'credit'}`} icon="💰" />
          </div>

          {/* Earnings breakdown */}
          <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
            <h2 className="font-semibold">Earnings</h2>
            <div className="mt-3 flex flex-wrap gap-6 text-sm">
              <div><span className="text-[var(--text-muted)]">On hold </span><Badge tone="amber">{stats!.rewards.held}</Badge>
                <span className="ml-1 text-xs text-[var(--text-muted)]">(clearing the fraud window)</span></div>
              <div><span className="text-[var(--text-muted)]">Payable </span><Badge tone="green">{stats!.rewards.payable}</Badge></div>
              <div><span className="text-[var(--text-muted)]">Paid </span><Badge tone="gray">{stats!.rewards.paid}</Badge></div>
            </div>
            <p className="mt-4 text-xs text-[var(--text-muted)]">
              You earn {stats!.code?.reward_amount} {stats!.code?.reward_type} per referral that reaches a qualifying
              event (verified signup / first payment). Rewards hold for a claw-back window, then become payable.
              Per FTC rules, disclose that you’re an ambassador when you share.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
