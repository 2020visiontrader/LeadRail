'use client';
import { useCallback, useRef, useState } from 'react';

// Documents dropped into the conversation for context.
//
// The upload is the easy half. The half that matters is telling someone their
// file went in but could NOT be read — a scanned PDF, an image, a corrupt
// export. Silently accepting those produces an answer confidently based on
// everything except the document they just attached, and nothing on screen
// suggests anything went wrong. So an unreadable file gets an amber chip and
// says why, rather than looking identical to one that worked.

export interface UploadedAttachment {
  id: string;
  filename: string;
  kind: string;
  bytes: number;
  chars: number;
  status: 'ready' | 'image' | 'unreadable';
  note?: string | null;
}

const ACCEPT = '.pdf,.docx,.pptx,.xlsx,.xls,.csv,.txt,.md,.json,.png,.jpg,.jpeg,.gif,.webp';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface Props {
  conversationId?: string;
  attachments: UploadedAttachment[];
  onChange: (next: UploadedAttachment[]) => void;
  disabled?: boolean;
}

export default function Attachments({ conversationId, attachments, onChange, disabled }: Props) {
  const [uploading, setUploading] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Drag events fire for every child element, so a boolean flag flickers.
  // Counting enter/leave is the only version that survives nested nodes.
  const dragDepth = useRef(0);

  const upload = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setError(null);
    setUploading((u) => [...u, ...files.map((f) => f.name)]);

    for (const file of files) {
      const form = new FormData();
      form.append('file', file);
      if (conversationId) form.append('conversationId', conversationId);
      try {
        const res = await fetch('/api/assistant/attachments', { method: 'POST', body: form });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.attachment) throw new Error(json?.error || `Could not upload ${file.name}.`);
        onChange([...attachments, json.attachment]);
      } catch (e: any) {
        setError(e?.message || `Could not upload ${file.name}.`);
      } finally {
        setUploading((u) => u.filter((n) => n !== file.name));
      }
    }
  }, [attachments, conversationId, onChange]);

  async function remove(id: string) {
    onChange(attachments.filter((a) => a.id !== id));
    await fetch(`/api/assistant/attachments/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  return (
    <div
      onDragEnter={(e) => { e.preventDefault(); dragDepth.current++; setDragging(true); }}
      onDragLeave={(e) => { e.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (!disabled) void upload(Array.from(e.dataTransfer.files || []));
      }}
      className={dragging ? 'rounded-lg outline-dashed outline-2 outline-offset-2 outline-[var(--brand)]' : ''}
    >
      {dragging && (
        <p className="px-3 pb-1 text-[11px] font-medium text-[var(--brand)]">
          Drop to attach — the assistant will read it as context for this conversation.
        </p>
      )}

      {(attachments.length > 0 || uploading.length > 0 || error) && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2">
          {attachments.map((a) => {
            const bad = a.status === 'unreadable';
            const image = a.status === 'image';
            return (
              <span
                key={a.id}
                title={a.note || `${humanSize(a.bytes)} · ${a.chars.toLocaleString()} characters read`}
                className={`flex max-w-[260px] items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${
                  bad
                    ? 'border-[var(--text-warning)]/40 bg-[var(--text-warning)]/10 text-[var(--text-warning)]'
                    : 'border-[var(--border-default)] bg-[var(--bg-raised)] text-[var(--text-secondary)]'
                }`}
              >
                <span aria-hidden>{bad ? '!' : image ? '▣' : '▤'}</span>
                <span className="truncate">{a.filename}</span>
                {/* The count is the proof it was actually read. "Attached" alone
                    is a claim; "8,412 characters" is evidence. */}
                <span className="shrink-0 opacity-70">
                  {bad ? 'unreadable' : image ? 'image' : `${a.chars.toLocaleString()} chars`}
                </span>
                <button
                  type="button"
                  onClick={() => remove(a.id)}
                  aria-label={`Remove ${a.filename}`}
                  className="shrink-0 opacity-60 hover:opacity-100"
                >
                  ×
                </button>
              </span>
            );
          })}
          {uploading.map((name) => (
            <span key={name} className="flex items-center gap-1.5 rounded-md border border-[var(--border-default)] px-2 py-1 text-[11px] text-[var(--text-muted)]">
              <span className="truncate">{name}</span><span>reading…</span>
            </span>
          ))}
          {error && <span className="w-full text-[11px] text-[var(--text-negative)]">{error}</span>}
        </div>
      )}

      {/* An unreadable file gets one plain sentence about what to do instead.
          The chip alone says something is wrong without saying what to do. */}
      {attachments.some((a) => a.status === 'unreadable') && (
        <p className="px-3 pb-2 text-[11px] text-[var(--text-warning)]">
          {attachments.find((a) => a.status === 'unreadable')?.note}
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => { void upload(Array.from(e.target.files || [])); e.target.value = ''; }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        aria-label="Attach a document"
        title="Attach a document for context"
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] transition hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)] disabled:opacity-40"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>
    </div>
  );
}
