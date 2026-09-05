'use client';
import { useEffect, useState, useCallback } from 'react';
import Badge from '@/components/Badge';
import Button from '@/components/Button';
import Modal from '@/components/Modal';
import Textarea from '@/components/Textarea';
import Dropdown from '@/components/Dropdown';
import EmptyState from '@/components/EmptyState';
import LoadingSpinner from '@/components/LoadingSpinner';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';

// Mirrors lib/generations/store.ts's GenerationRow, plus the display URL the
// list route mints server-side at read time (never a raw storage_path).
export interface GenerationRecord {
  id: string;
  brand_id: string | null;
  kind: 'image' | 'video';
  source_tool: string;
  prompt: string | null;
  model: string | null;
  storage_path: string | null;
  external_url: string | null;
  review_state: 'PENDING' | 'APPROVED' | 'REJECTED';
  review_note: string | null;
  content_item_id: string | null;
  published_at: string | null;
  purged_at: string | null;
  channel_url: string | null;
  created_at: string;
  url: string | null;
}

const REVIEW_TONE: Record<GenerationRecord['review_state'], 'amber' | 'green' | 'red'> = {
  PENDING: 'amber',
  APPROVED: 'green',
  REJECTED: 'red',
};
const REVIEW_LABEL: Record<GenerationRecord['review_state'], string> = {
  PENDING: 'Awaiting review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0);
}

/**
 * One generation card. Exported on its own (matching the MessageActions
 * pattern in AgentConsole.tsx) so the two easy-to-get-wrong render states —
 * purged-and-published, and published-with-no-channel-link — can be driven
 * directly in a DOM test without standing up the whole board's data fetch.
 */
export function GenerationCard({
  generation, onApprove, onReject, onPromote, busy,
}: {
  generation: GenerationRecord;
  onApprove: (g: GenerationRecord) => void;
  onReject: (g: GenerationRecord) => void;
  onPromote: (g: GenerationRecord) => void;
  busy?: boolean;
}) {
  const g = generation;
  // A PUBLISHED generation whose bytes we've purged (storage_path is null,
  // purged_at is set) has channel_url guaranteed non-null by the store's own
  // invariant (markGenerationPublished requires one before it can ever be
  // purged) — but render defensively on the actual data, not the invariant,
  // since a bug elsewhere setting purged_at without a link must never render
  // as a broken image either.
  const isPurgedOnChannel = !!g.purged_at && !!g.channel_url;
  // A row can be marked published without a channel link today for
  // Facebook/Instagram/Threads (a gap another packet is closing) — it must
  // not claim to be downloadable, but it also hasn't been purged, so its
  // bytes are still here. Render it as ordinary stored media, not a link.
  const isPublishedNoLink = !!g.published_at && !g.channel_url && !isPurgedOnChannel;

  return (
    <div
      data-testid="generation-card"
      data-review-state={g.review_state}
      className="flex flex-col gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <Badge tone={REVIEW_TONE[g.review_state]}>{REVIEW_LABEL[g.review_state]}</Badge>
        <Badge tone="gray">{g.kind}</Badge>
      </div>

      {isPurgedOnChannel ? (
        <div
          data-testid="generation-media-on-channel"
          className="flex aspect-video flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--bg-raised)] p-4 text-center"
        >
          <span aria-hidden className="text-2xl opacity-60">🔗</span>
          <p className="text-[13px] font-medium text-[var(--text-primary)]">Now on the channel</p>
          <p className="text-[12px] text-[var(--text-muted)]">
            The file was published and is no longer stored here — get it from the live post.
          </p>
          <a
            href={g.channel_url!}
            target="_blank"
            rel="noreferrer"
            className="text-[13px] font-medium underline"
            style={{ color: 'var(--brand)' }}
          >
            View the published post
          </a>
        </div>
      ) : g.url ? (
        g.kind === 'video' || g.external_url ? (
          <div
            data-testid="generation-media-video"
            className="flex aspect-video flex-col items-center justify-center gap-2 rounded-lg bg-[var(--bg-raised)] p-4 text-center"
          >
            <span aria-hidden className="text-2xl opacity-60">🎬</span>
            <a href={g.url} target="_blank" rel="noreferrer" className="text-[13px] font-medium underline" style={{ color: 'var(--brand)' }}>
              {g.external_url ? 'Open the video' : 'Preview the video'}
            </a>
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img data-testid="generation-media-image" src={g.url} alt={g.prompt || 'Generated image'} className="aspect-video w-full rounded-lg object-cover" />
        )
      ) : (
        <div data-testid="generation-media-unavailable" className="flex aspect-video items-center justify-center rounded-lg bg-[var(--bg-raised)] text-[12px] text-[var(--text-muted)]">
          Asset unavailable
        </div>
      )}

      {isPublishedNoLink && (
        <p data-testid="generation-still-stored-note" className="text-[12px] text-[var(--text-muted)]">
          Published — still stored here for now.
        </p>
      )}

      {g.prompt && <p className="line-clamp-2 text-[13px] text-[var(--text-secondary)]">{g.prompt}</p>}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
        <span>{g.source_tool}</span>
        <span>{new Date(g.created_at).toLocaleDateString()}</span>
      </div>

      {g.review_note && g.review_state === 'REJECTED' && (
        <p className="text-[12px] italic text-[var(--text-muted)]">Reason: {g.review_note}</p>
      )}

      <div className="flex gap-2 pt-1">
        {g.review_state === 'PENDING' && (
          <>
            <Button className="flex-1" onClick={() => onApprove(g)} disabled={busy}>Approve</Button>
            <Button variant="secondary" className="flex-1" onClick={() => onReject(g)} disabled={busy}>Reject</Button>
          </>
        )}
        {g.review_state === 'APPROVED' && !g.content_item_id && (
          <Button className="flex-1" onClick={() => onPromote(g)} disabled={busy}>Promote to content</Button>
        )}
        {g.review_state === 'APPROVED' && g.content_item_id && (
          <p className="flex-1 text-[12px] text-[var(--text-muted)]">Already on the content board.</p>
        )}
        {g.review_state === 'REJECTED' && (
          <Button variant="secondary" className="flex-1" onClick={() => onApprove(g)} disabled={busy}>Approve anyway</Button>
        )}
      </div>
    </div>
  );
}

interface QuotaInfo { usedBytes: number; limitBytes: number }

export default function GenerationsBoard({ brandId }: { brandId?: string | null }) {
  const { notify } = useToast();
  const [generations, setGenerations] = useState<GenerationRecord[]>([]);
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'' | 'PENDING' | 'APPROVED' | 'REJECTED'>('');
  const [busyId, setBusyId] = useState<string>('');
  const [rejecting, setRejecting] = useState<GenerationRecord | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (brandId) params.set('brandId', brandId);
      if (filter) params.set('reviewState', filter);
      const data = await apiGet<{ generations: GenerationRecord[]; quota: QuotaInfo }>(`/api/generations?${params.toString()}`);
      setGenerations(data.generations || []);
      setQuota(data.quota || null);
    } catch {
      setGenerations([]);
      setQuota(null);
    } finally { setLoading(false); }
  }, [brandId, filter]);

  useEffect(() => { load(); }, [load]);

  const approve = async (g: GenerationRecord) => {
    setBusyId(g.id);
    try {
      await apiSend(`/api/generations/${g.id}/review`, 'POST', { state: 'APPROVED' });
      notify('Generation approved');
      load();
    } catch (e: any) { notify(e.message || 'Could not approve this generation', 'error'); }
    finally { setBusyId(''); }
  };

  const reject = async () => {
    if (!rejecting) return;
    setBusyId(rejecting.id);
    try {
      await apiSend(`/api/generations/${rejecting.id}/review`, 'POST', { state: 'REJECTED', note: reason.trim() || undefined });
      notify('Generation rejected');
      setRejecting(null); setReason('');
      load();
    } catch (e: any) { notify(e.message || 'Could not reject this generation', 'error'); }
    finally { setBusyId(''); }
  };

  const promote = async (g: GenerationRecord) => {
    setBusyId(g.id);
    try {
      await apiSend(`/api/generations/${g.id}/promote`, 'POST', {});
      notify('Added to the content board');
      load();
    } catch (e: any) { notify(e.message || 'Could not promote this generation', 'error'); }
    finally { setBusyId(''); }
  };

  const quotaPct = quota && quota.limitBytes > 0 ? Math.min(100, (quota.usedBytes / quota.limitBytes) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Dropdown
          value={filter}
          onChange={(e) => setFilter(e.target.value as any)}
          options={[
            { value: '', label: 'All generations' },
            { value: 'PENDING', label: 'Awaiting review' },
            { value: 'APPROVED', label: 'Approved' },
            { value: 'REJECTED', label: 'Rejected' },
          ]}
        />
        {quota && (
          <div data-testid="generations-quota" className="flex min-w-[220px] flex-col gap-1 text-[12px] text-[var(--text-muted)]">
            <span>{formatMb(quota.usedBytes)} MB of {formatMb(quota.limitBytes)} MB used</span>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-raised)]">
              <div
                className="h-full rounded-full"
                style={{ width: `${quotaPct}%`, background: quotaPct > 90 ? 'var(--status-negative)' : 'var(--ink)' }}
              />
            </div>
          </div>
        )}
      </div>

      {loading ? <LoadingSpinner /> : generations.length === 0 ? (
        <EmptyState icon="🖼️" title="No generations yet" hint="Generated images and videos will show up here for review." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {generations.map((g) => (
            <GenerationCard key={g.id} generation={g} onApprove={approve} onReject={(gen) => { setRejecting(gen); setReason(''); }} onPromote={promote} busy={busyId === g.id} />
          ))}
        </div>
      )}

      <Modal
        isOpen={!!rejecting}
        title="Reject generation"
        onClose={() => setRejecting(null)}
        onSubmit={reject}
        submitLabel="Reject"
        loading={busyId === rejecting?.id}
      >
        <Textarea label="Reason (optional)" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this being rejected?" />
      </Modal>
    </div>
  );
}
