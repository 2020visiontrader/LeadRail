import { NextRequest, NextResponse } from 'next/server';
import { getVenture, updateVenture, assertBrandOwned, dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { extractDeckText, isSupportedDeck } from '@/lib/ai/deck';
import { profileVentureFromDeck } from '@/lib/ai/generation';
import { opencodeConfigured } from '@/lib/ai/opencode';
import { DECK_BUCKET, DECK_URL_TTL, putPrivate, signUrl } from '@/lib/storage';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 25 * 1024 * 1024; // 25MB — decks can be image-heavy

// POST /api/ventures/:id/deck  (multipart: file)
// Uploads the deck to durable storage, extracts its text, has the venture
// profiler (OpenCode Go) distil a summary + ICP, and stores everything on the
// brand. Returns the deck URL + the derived profile so the wizard can show it.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not configured');
  if (!(await assertBrandOwned(params.id, session.accountId))) return badRequest('unknown venture');

  let file: File | null = null;
  try {
    const form = await request.formData();
    file = form.get('file') as File | null;
  } catch { return badRequest('expected multipart form data with a file'); }
  if (!file) return badRequest('file is required');
  if (file.size > MAX_BYTES) return badRequest('file too large (max 25MB)');
  if (!isSupportedDeck(file.name || '')) {
    return badRequest('unsupported file type — use PDF, PPTX, DOCX, XLSX, or TXT');
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const safeName = (file.name || 'deck').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 90);
  const path = `${session.accountId}/${params.id}/${Date.now()}-${safeName}`;

  // 1) Store the file in the PRIVATE deck bucket (never public). We persist the
  //    storage path; reads are served via short-lived signed URLs on demand.
  const put = await putPrivate(DECK_BUCKET, path, buf, file.type);
  if (put.error) return errorResponse(put.error, 502, 'upload failed — is Supabase Storage enabled?');
  const signed = await signUrl(DECK_BUCKET, path, DECK_URL_TTL);

  // 2) Extract text (guarded — never throws).
  const extracted = await extractDeckText(file.name || safeName, buf);

  // 3) Profile the venture from deck + its stored goal/sectors. If OpenCode is
  //    down or text extraction failed, still save the file + a clear note.
  const venture = await getVenture(params.id);
  let profile: Awaited<ReturnType<typeof profileVentureFromDeck>> | null = null;
  let profileNote: string | undefined = extracted.ok ? undefined : extracted.note;
  if (opencodeConfigured()) {
    try {
      profile = await profileVentureFromDeck({
        ventureName: venture?.name || params.id,
        description: venture?.description || undefined,
        leadGoal: venture?.lead_goal || undefined,
        sectors: Array.isArray(venture?.sectors) ? venture.sectors : [],
        deckText: extracted.text,
      });
    } catch (e: any) {
      profileNote = `deck stored, but profiling failed: ${e?.message || 'AI error'}`;
    }
  } else {
    profileNote = 'deck stored — connect OpenCode to auto-profile it';
  }

  // 4) Persist onto the brand.
  // Persist the storage PATH (opaque ref), not a public URL.
  const patch: Record<string, any> = { deck_url: path, deck_name: file.name || safeName };
  if (profile) {
    patch.deck_summary = profile.summary;
    patch.icp_profile = profile.icp;
  }
  const saved = await updateVenture(params.id, session.accountId, patch);

  return NextResponse.json({
    deck_url: signed, // short-lived signed URL for immediate preview/download
    deck_name: file.name || safeName,
    extracted_chars: extracted.chars,
    profile,
    note: profileNote,
    venture: saved,
  });
}

// GET /api/ventures/:id/deck — 302 to a fresh signed URL for the stored deck.
// The bucket is private, so this is the only way to download it; account-scoped.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!(await assertBrandOwned(params.id, session.accountId))) return badRequest('unknown venture');
  const venture = await getVenture(params.id);
  const path = venture?.deck_url;
  if (!path) return badRequest('no deck on file');
  const signed = await signUrl(DECK_BUCKET, path, DECK_URL_TTL);
  if (!signed) return errorResponse('sign failed', 502, 'could not sign deck url');
  return NextResponse.redirect(signed);
}
