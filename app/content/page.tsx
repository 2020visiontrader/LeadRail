'use client';
import { useEffect, useState, useCallback } from 'react';
import Button from '@/components/Button';
import Modal from '@/components/Modal';
import Textarea from '@/components/Textarea';
import Input from '@/components/Input';
import Dropdown from '@/components/Dropdown';
import Drawer from '@/components/Drawer';
import Badge from '@/components/Badge';
import EmptyState from '@/components/EmptyState';
import LoadingSpinner from '@/components/LoadingSpinner';
import ContentCalendar from '@/components/ContentCalendar';
import ImportExport from '@/components/ImportExport';
import { useToast } from '@/components/ToastProvider';
import { apiGet, apiSend } from '@/lib/api';
import { ContentPost } from '@/lib/types';

const BRAND = 'rentahub';
const PLATFORMS = ['instagram', 'tiktok', 'linkedin', 'twitter', 'facebook', 'threads', 'reddit', 'youtube'];

export default function ContentPage() {
  const { notify } = useToast();
  const [posts, setPosts] = useState<ContentPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<ContentPost | null>(null);
  const [form, setForm] = useState({ platform: 'instagram', post_body: '', scheduled_for: '' });
  const [topic, setTopic] = useState('');
  const [generating, setGenerating] = useState(false);

  const generate = async () => {
    if (!topic.trim()) { notify('Enter a topic to generate', 'error'); return; }
    setGenerating(true);
    try {
      const r = await apiSend<{ post: { hook: string; post_body: string } }>('/api/generate/content', 'POST', {
        venture: { name: BRAND }, platform: form.platform, topic: topic.trim(),
      });
      const body = [r.post.hook, r.post.post_body].filter(Boolean).join('\n\n');
      setForm((f) => ({ ...f, post_body: body }));
      notify('Draft generated');
    } catch (e: any) {
      notify(e.message === 'not_configured' ? 'Connect Gemini to generate' : e.message || 'Generation failed', 'error');
    } finally { setGenerating(false); }
  };

  const load = useCallback(async () => {
    setLoading(true);
    const data = await apiGet<ContentPost[]>(`/api/content?brandId=${BRAND}`).catch(() => []);
    setPosts(Array.isArray(data) ? data : []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.post_body) { notify('Post body required', 'error'); return; }
    setSaving(true);
    try {
      await apiSend('/api/content', 'POST', { brand_id: BRAND, ...form, scheduled_for: form.scheduled_for || null });
      notify('Post scheduled');
      setOpen(false); setForm({ platform: 'instagram', post_body: '', scheduled_for: '' });
      load();
    } catch (e: any) { notify(e.message || 'Create failed', 'error'); }
    finally { setSaving(false); }
  };

  const remove = async (p: ContentPost) => {
    if (!confirm('Delete this post?')) return;
    try { await apiSend(`/api/content/${p.id}`, 'DELETE'); notify('Deleted'); setSelected(null); load(); }
    catch (e: any) { notify(e.message || 'Delete failed', 'error'); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Content</h1>
          <p className="text-sm text-slate-500">Social content calendar</p>
        </div>
        <div className="flex items-center gap-2">
          <ImportExport exportPath="/api/content/export" importPath="/api/content/import" brandId={BRAND} onImported={load} />
          <Button onClick={() => setOpen(true)}>+ New Post</Button>
        </div>
      </div>

      {loading ? <LoadingSpinner /> : posts.length === 0 ? (
        <EmptyState icon="📱" title="No content scheduled" hint="Schedule your first post. Publishing requires Postiz/Meta + Supabase connected." action={<Button onClick={() => setOpen(true)}>New Post</Button>} />
      ) : (
        <ContentCalendar posts={posts} onSelect={setSelected} />
      )}

      <Modal isOpen={open} title="Schedule Post" onClose={() => setOpen(false)} onSubmit={create} submitLabel="Schedule" loading={saving}>
        <div className="space-y-4">
          <Dropdown label="Platform" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}
            options={PLATFORMS.map((p) => ({ value: p, label: p }))} />
          <div className="flex items-end gap-2 rounded-lg border border-indigo-100 bg-indigo-50/50 p-3">
            <div className="flex-1"><Input label="AI topic" placeholder="e.g. weekend scooter deals" value={topic} onChange={(e) => setTopic(e.target.value)} /></div>
            <Button variant="secondary" loading={generating} onClick={generate}>✨ Generate</Button>
          </div>
          <Textarea label="Post body" rows={5} value={form.post_body} onChange={(e) => setForm({ ...form, post_body: e.target.value })} />
          <Input label="Schedule for" type="datetime-local" value={form.scheduled_for} onChange={(e) => setForm({ ...form, scheduled_for: e.target.value })} />
        </div>
      </Modal>

      <Drawer isOpen={!!selected} title="Post detail" onClose={() => setSelected(null)}>
        {selected && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Badge tone="indigo">{selected.platform}</Badge>
              <Badge tone={selected.status === 'published' ? 'green' : 'gray'}>{selected.status}</Badge>
            </div>
            <p className="text-sm text-slate-700">{selected.post_body}</p>
            <p className="text-xs text-slate-400">{selected.scheduled_for ? new Date(selected.scheduled_for).toLocaleString() : 'Unscheduled'}</p>
            <Button variant="danger" className="w-full" onClick={() => remove(selected)}>Delete Post</Button>
          </div>
        )}
      </Drawer>
    </div>
  );
}
