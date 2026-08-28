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
//
// WHY THE UPLOAD IS A HOOK AND NOT JUST A COMPONENT. Drag-and-drop used to live
// on this component's own wrapper — which renders NOTHING until there is an
// attachment or a drag in progress. A div with no children has no height and no
// hit area, so on an empty composer there was, quite literally, nowhere to drop
// a file. Dragging one in did nothing at all and the only route left was the
// paperclip, which is exactly what it looked like from the outside.
//
// The drop target has to be the whole console, which is a different component.
// Rather than pass callbacks down and drag state up, the upload itself is a
// hook: the chip list and the console-wide drop and paste handlers all run the
// same code, so a file cannot arrive by one route and be handled differently
// from another.

export interface UploadedAttachment {
  id: string;
  filename: string;
  kind: string;
  bytes: number;
  chars: number;
  status: 'ready' | 'image' | 'video' | 'unreadable';
  note?: string | null;
  /** Set when this chip came from the library picker rather than an upload —
   *  see the picker below for why `remove()` treats the two differently. */
  fromLibrary?: boolean;
  title?: string | null;
}

/** The shape `GET /api/assistant/attachments?all=1` returns — the account-wide
 *  list, not the per-conversation one. See listAllAttachments. */
interface LibraryDoc {
  id: string;
  filename: string;
  title: string | null;
  scope: string;
  bytes: number;
  status: string;
  chars?: number;
}

// Video is here now that the assistant can read one (lib/video). It is decoded
// in the browser before anything is sent, so the size of the file on disk is
// not the size of the upload.
const ACCEPT = '.pdf,.docx,.pptx,.xlsx,.xls,.csv,.txt,.md,.json,.png,.jpg,.jpeg,.gif,.webp,.mp4,.mov,.webm,.m4v';

/** A conversation can carry at most this many documents at once. Not a
 *  server constraint — a composer one, so it is enforced and shown here
 *  rather than discovered as a rejected request after the fact. */
export const MAX_ATTACHMENTS = 10;

/** Folds a batch of upload results onto the attachment list in call order.
 *
 *  Exists because the naive loop this replaced — `onChange([...attachments,
 *  result])` once per file, inside a `for` loop — closed over `attachments`
 *  as it was BEFORE the loop started. Selecting three files at once silently
 *  kept only the last one: each iteration's onChange overwrote the one
 *  before it instead of building on it. The hook now accumulates locally and
 *  folds through this function instead of re-reading that stale closure. */
export function appendAttachments(
  current: UploadedAttachment[],
  incoming: UploadedAttachment[]
): UploadedAttachment[] {
  return [...current, ...incoming];
}

/** How many of an incoming file selection fit under MAX_ATTACHMENTS, given
 *  how many slots are already spoken for (attached + currently uploading). */
export function clampForUpload(
  inFlightCount: number,
  incomingCount: number,
  max: number = MAX_ATTACHMENTS
): { acceptCount: number; rejectCount: number } {
  const room = Math.max(0, max - inFlightCount);
  const acceptCount = Math.min(room, incomingCount);
  return { acceptCount, rejectCount: incomingCount - acceptCount };
}

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
  /** Supplied by the console so a drop and the paperclip share one in-flight
   *  list. Omitted, this component makes its own. */
  uploader?: AttachmentUploader;
}

export interface AttachmentUploader {
  upload: (files: File[]) => Promise<void>;
  uploading: string[];
  error: string | null;
}

/** The one upload path. Everything that can receive a file — the paperclip, a
 *  drop anywhere on the console, a paste — goes through this. */
export function useAttachmentUpload({ conversationId, attachments, onChange }: {
  conversationId?: string;
  attachments: UploadedAttachment[];
  onChange: (next: UploadedAttachment[]) => void;
}): AttachmentUploader {
  const [uploading, setUploading] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setError(null);

    const { acceptCount, rejectCount } = clampForUpload(attachments.length + uploading.length, files.length);
    const accepted = files.slice(0, acceptCount);
    if (rejectCount > 0) {
      setError(
        accepted.length
          ? `Only ${accepted.length} of ${files.length} files were attached — the ${MAX_ATTACHMENTS}-document limit was reached.`
          : `Already at the ${MAX_ATTACHMENTS}-document limit — remove one before attaching another.`
      );
    }
    if (!accepted.length) return;

    setUploading((u) => [...u, ...accepted.map((f) => f.name)]);

    // Accumulated locally, then folded through appendAttachments — see its
    // comment for why reading `attachments` fresh each iteration is wrong.
    let acc = attachments;
    for (const file of accepted) {
      const form = new FormData();
      form.append('file', file);
      if (conversationId) form.append('conversationId', conversationId);
      try {
        const res = await fetch('/api/assistant/attachments', { method: 'POST', body: form });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.attachment) throw new Error(json?.error || `Could not upload ${file.name}.`);
        acc = appendAttachments(acc, [json.attachment]);
        onChange(acc);
      } catch (e: any) {
        setError(e?.message || `Could not upload ${file.name}.`);
      } finally {
        setUploading((u) => u.filter((n) => n !== file.name));
      }
    }
  }, [attachments, uploading, conversationId, onChange]);

  return { upload, uploading, error };
}

export default function Attachments({ conversationId, attachments, onChange, disabled, uploader }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  // The console owns the uploader when it has one, so a drop and a paperclip
  // click share the same in-flight list — two independent uploaders would show
  // a file as "reading…" in one place and finished in the other.
  const own = useAttachmentUpload({ conversationId, attachments, onChange });
  const { upload, uploading, error } = uploader ?? own;

  const [pickerOpen, setPickerOpen] = useState(false);
  const [libraryDocs, setLibraryDocs] = useState<LibraryDoc[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);

  async function remove(id: string) {
    const removed = attachments.find((a) => a.id === id);
    onChange(attachments.filter((a) => a.id !== id));
    // A library document is shared across every chat — deleting the row here
    // would remove it from every OTHER conversation and every scheduled run
    // that reads it too, when all the person meant was "not in THIS message".
    // Only an ordinary upload, which exists solely because it was dropped into
    // this chat, gets deleted when its chip goes away.
    if (removed?.fromLibrary) return;
    await fetch(`/api/assistant/attachments/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  async function openPicker() {
    setPickerOpen((open) => !open);
    if (pickerOpen || libraryDocs.length || libraryLoading) return;
    setLibraryLoading(true);
    setLibraryError(null);
    try {
      const res = await fetch('/api/assistant/attachments?all=1');
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || 'Could not load the document library.');
      const docs: LibraryDoc[] = (json?.attachments || []).filter((d: LibraryDoc) => d.scope === 'library');
      setLibraryDocs(docs);
    } catch (e: any) {
      setLibraryError(e?.message || 'Could not load the document library.');
    } finally {
      setLibraryLoading(false);
    }
  }

  function attachFromLibrary(doc: LibraryDoc) {
    if (attachments.some((a) => a.id === doc.id)) { setPickerOpen(false); return; }
    if (attachments.length >= MAX_ATTACHMENTS) { setPickerOpen(false); return; }
    onChange([...attachments, {
      id: doc.id,
      filename: doc.filename,
      title: doc.title,
      kind: 'library',
      bytes: doc.bytes,
      chars: doc.chars ?? 0,
      // A library doc's own status ('ready' | 'image' | 'video' | 'unreadable')
      // maps directly onto the chip states this component already renders.
      status: (['ready', 'image', 'video', 'unreadable'].includes(doc.status) ? doc.status : 'ready') as UploadedAttachment['status'],
      fromLibrary: true,
    }]);
    setPickerOpen(false);
  }

  const atLimit = attachments.length >= MAX_ATTACHMENTS;

  return (
    <div>
      {(attachments.length > 0 || uploading.length > 0 || error) && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2">
          {attachments.map((a) => {
            const bad = a.status === 'unreadable';
            const image = a.status === 'image';
            const video = a.status === 'video';
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
                <span aria-hidden>{a.fromLibrary ? '★' : bad ? '!' : video ? '▶' : image ? '▣' : '▤'}</span>
                <span className="truncate">{a.title || a.filename}</span>
                {/* The count is the proof it was actually read. "Attached" alone
                    is a claim; "8,412 characters" is evidence. */}
                <span className="shrink-0 opacity-70">
                  {bad ? 'unreadable' : video ? 'video' : image ? 'image' : `${a.chars.toLocaleString()} chars`}
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
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={disabled || atLimit}
          onClick={() => inputRef.current?.click()}
          aria-label="Attach a document"
          title={atLimit ? `${MAX_ATTACHMENTS}-document limit reached — remove one to attach another` : `Attach a document for context (up to ${MAX_ATTACHMENTS})`}
          className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-secondary)] transition hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:pointer-events-none disabled:opacity-40"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>

        {/* Pulls a document already saved to the account library into THIS
            chat, rather than requiring it be re-uploaded — see Settings ->
            Workspace -> Documents, the only place that saves one to the
            library in the first place. */}
        <div className="relative">
          <button
            type="button"
            disabled={disabled || atLimit}
            onClick={openPicker}
            aria-label="Attach a saved document from your library"
            title={atLimit ? `${MAX_ATTACHMENTS}-document limit reached — remove one to attach another` : 'Attach from your document library'}
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-secondary)] transition hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:pointer-events-none disabled:opacity-40"
          >
            <span aria-hidden className="text-[13px] leading-none">★</span>
          </button>

          {pickerOpen && (
            <div className="absolute bottom-full right-0 z-10 mb-2 max-h-64 w-64 overflow-y-auto rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-1.5 shadow-lg">
              {libraryLoading && <div className="p-2 text-[11px] text-[var(--text-muted)]">Loading…</div>}
              {libraryError && <div className="p-2 text-[11px] text-[var(--text-negative)]">{libraryError}</div>}
              {!libraryLoading && !libraryError && libraryDocs.length === 0 && (
                <div className="p-2 text-[11px] text-[var(--text-muted)]">
                  No library documents yet — save one from Settings → Workspace → Documents.
                </div>
              )}
              {libraryDocs.map((doc) => {
                const already = attachments.some((a) => a.id === doc.id);
                return (
                  <button
                    key={doc.id}
                    type="button"
                    disabled={already}
                    onClick={() => attachFromLibrary(doc)}
                    className="flex w-full items-center gap-1.5 truncate rounded-md px-2 py-1.5 text-left text-[12px] text-[var(--text-primary)] transition hover:bg-[var(--bg-raised)] disabled:opacity-40"
                  >
                    <span aria-hidden>★</span>
                    <span className="truncate">{doc.title || doc.filename}</span>
                    {already && <span className="ml-auto shrink-0 text-[10px] text-[var(--text-muted)]">added</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Only shown once it's relevant — an empty composer doesn't need to
            be told about a limit it isn't near. */}
        {attachments.length > 0 && (
          <span
            className={`ml-0.5 shrink-0 text-[11px] tabular-nums ${atLimit ? 'text-[var(--text-warning)]' : 'text-[var(--text-muted)]'}`}
            title={atLimit ? `${MAX_ATTACHMENTS}-document limit reached` : `${MAX_ATTACHMENTS - attachments.length} more can be attached`}
          >
            {attachments.length}/{MAX_ATTACHMENTS}
          </span>
        )}
      </div>
    </div>
  );
}
