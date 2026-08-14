'use client';
import { useEffect, useState, useCallback } from 'react';
import Button from '@/components/Button';
import Input from '@/components/Input';
import Checkbox from '@/components/Checkbox';
import LoadingSpinner from '@/components/LoadingSpinner';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';

// Settings -> Budgets. Optional monthly credit spend cap per account
// (migration 033_budgets.sql). `spent` is always computed live from
// credit_transactions — see lib/budgets/store.ts. With enabled=false
// (the default), nothing here changes existing spend behavior.

interface BudgetConfig {
  monthly_limit_credits: number | null;
  alert_threshold_pct: number;
  hard_stop: boolean;
  enabled: boolean;
}

interface BudgetStatus {
  enabled: boolean;
  limit: number | null;
  spent: number;
  remaining: number | null;
  pct: number;
  alert: boolean;
  overLimit: boolean;
}

const EMPTY_CONFIG: BudgetConfig = {
  monthly_limit_credits: null,
  alert_threshold_pct: 80,
  hard_stop: false,
  enabled: false,
};

export default function Budgets() {
  const { notify } = useToast();
  const [config, setConfig] = useState<BudgetConfig>(EMPTY_CONFIG);
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGet<{ config: BudgetConfig | null; status: BudgetStatus }>('/api/budgets');
      setConfig(res.config ? {
        monthly_limit_credits: res.config.monthly_limit_credits,
        alert_threshold_pct: res.config.alert_threshold_pct,
        hard_stop: res.config.hard_stop,
        enabled: res.config.enabled,
      } : EMPTY_CONFIG);
      setStatus(res.status);
    } catch (e: any) {
      notify(e?.message || 'Failed to load budget', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  async function save() {
    setSaving(true);
    try {
      const res = await apiSend<{ config: BudgetConfig; status: BudgetStatus }>('/api/budgets', 'PUT', config);
      setConfig(res.config);
      setStatus(res.status);
      notify('Budget saved', 'success');
    } catch (e: any) {
      notify(e?.message || 'Failed to save budget', 'error');
    } finally {
      setSaving(false);
    }
  }

  const state: 'ok' | 'alert' | 'over' = status?.overLimit ? 'over' : status?.alert ? 'alert' : 'ok';
  const stateColor = state === 'over' ? 'var(--status-negative)' : state === 'alert' ? '#D97706' : 'var(--status-positive)';
  const barPct = status ? Math.min(100, Math.max(0, status.pct)) : 0;

  return (
    <div className="space-y-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
      <div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Spend budget</h2>
        <p className="text-sm text-[var(--text-secondary)]">
          Optional monthly credit cap for this account. Set an alert threshold to get warned as spend approaches the
          limit, or turn on hard-stop to block further spend once the limit is reached.
        </p>
      </div>

      {loading ? (
        <LoadingSpinner />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-4">
            <Checkbox
              label="Enable spend budget"
              checked={config.enabled}
              onChange={(e) => setConfig((c) => ({ ...c, enabled: (e.target as HTMLInputElement).checked }))}
            />
            <Checkbox
              label="Hard-stop spend when over limit"
              checked={config.hard_stop}
              onChange={(e) => setConfig((c) => ({ ...c, hard_stop: (e.target as HTMLInputElement).checked }))}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Monthly limit (credits)"
              type="number"
              min={0}
              placeholder="e.g. 10000"
              value={config.monthly_limit_credits ?? ''}
              onChange={(e) => {
                const v = (e.target as HTMLInputElement).value;
                setConfig((c) => ({ ...c, monthly_limit_credits: v === '' ? null : Number(v) }));
              }}
            />
            <Input
              label="Alert threshold (%)"
              type="number"
              min={1}
              max={100}
              value={config.alert_threshold_pct}
              onChange={(e) => setConfig((c) => ({ ...c, alert_threshold_pct: Number((e.target as HTMLInputElement).value) }))}
            />
          </div>

          {status && (
            <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-[var(--text-primary)]">
                  {status.spent.toLocaleString()} spent
                  {status.limit != null ? ` / ${status.limit.toLocaleString()} credits` : ' this month (no limit set)'}
                </span>
                <span className="font-medium" style={{ color: stateColor }}>
                  {state === 'over' ? 'Over limit' : state === 'alert' ? 'Approaching limit' : 'OK'}
                  {status.remaining != null ? ` · ${Math.max(0, status.remaining).toLocaleString()} remaining` : ''}
                </span>
              </div>
              {status.limit != null && (
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[var(--bg-canvas)]">
                  <div
                    className="h-full rounded-full transition-[width]"
                    style={{ width: `${barPct}%`, background: stateColor }}
                  />
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end">
            <Button onClick={save} loading={saving}>{saving ? 'Saving…' : 'Save budget'}</Button>
          </div>
        </>
      )}
    </div>
  );
}
