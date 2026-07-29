'use client';
import { useRef, useState } from 'react';
import Button from '@/components/Button';
import { useToast } from '@/components/ToastProvider';

// Reusable CSV/Excel export + import toolbar. Export streams a file download;
// import uploads to `${importPath}` as multipart with brand_id/account_id.
export default function ImportExport({
  exportPath, importPath, brandId, accountId, onImported,
}: {
  exportPath: string; importPath: string; brandId?: string; accountId?: string; onImported?: () => void;
}) {
  const { notify } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const download = (fmt: 'csv' | 'xlsx') => {
    if (!brandId) { notify('Pick a venture first', 'error'); return; }
    window.open(`${exportPath}?brandId=${encodeURIComponent(brandId)}&format=${fmt}`, '_blank');
  };

  const upload = async (file: File) => {
    if (!brandId) { notify('Pick a venture first', 'error'); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('brand_id', brandId);
      if (accountId) fd.append('account_id', accountId);
      const res = await fetch(importPath, { method: 'POST', body: fd, headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Import failed');
      notify(`Imported ${data.inserted} · skipped ${data.skipped}`);
      onImported?.();
    } catch (e: any) { notify(e.message || 'Import failed', 'error'); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  return (
    <div className="flex items-center gap-2">
      <Button variant="secondary" onClick={() => download('csv')}>Export CSV</Button>
      <Button variant="secondary" onClick={() => download('xlsx')}>Export Excel</Button>
      <Button variant="secondary" loading={busy} onClick={() => fileRef.current?.click()}>Import</Button>
      <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
    </div>
  );
}
