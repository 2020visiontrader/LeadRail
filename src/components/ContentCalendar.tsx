import Badge from '@/components/Badge';
import { ContentPost } from '@/lib/types';

const platformTone: Record<string, any> = {
  instagram: 'indigo', tiktok: 'gray', linkedin: 'blue', twitter: 'blue',
  facebook: 'blue', threads: 'gray', reddit: 'amber', youtube: 'red',
};

export default function ContentCalendar({ posts, onSelect }: { posts: ContentPost[]; onSelect?: (p: ContentPost) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {posts.map((p) => (
        <button key={p.id} onClick={() => onSelect?.(p)} className="rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:shadow-md">
          <div className="flex items-center justify-between">
            <Badge tone={platformTone[p.platform] || 'gray'}>{p.platform}</Badge>
            <Badge tone={p.status === 'published' ? 'green' : p.status === 'scheduled' ? 'blue' : 'gray'}>{p.status}</Badge>
          </div>
          <p className="mt-3 line-clamp-3 text-sm text-slate-700">{p.post_body}</p>
          <p className="mt-3 text-xs text-slate-400">{p.scheduled_for ? new Date(p.scheduled_for).toLocaleString() : 'Unscheduled'}</p>
        </button>
      ))}
    </div>
  );
}
