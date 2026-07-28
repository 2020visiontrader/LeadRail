export default function EmailPreview({ subject, html }: { subject: string; html: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-700">
        Subject: {subject || '(no subject)'}
      </div>
      <div className="prose prose-sm max-w-none p-4" dangerouslySetInnerHTML={{ __html: html || '<p class="text-slate-400">Nothing to preview</p>' }} />
    </div>
  );
}
