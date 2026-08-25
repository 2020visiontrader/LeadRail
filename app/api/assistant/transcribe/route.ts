import { withApi, requireSession, errorResponse, badRequest } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { transcribeAudio, transcribeConfigured, MAX_AUDIO_BYTES } from '@/lib/ai/transcribe';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// POST /api/assistant/transcribe — a voice note becomes text in the composer.
//
// The audio is NOT stored. It is transcribed and dropped: a recording of
// someone's voice is more sensitive than the sentence it contains, and keeping
// it would mean holding biometric-adjacent data to no purpose the product has.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!transcribeConfigured()) {
    return NextResponse.json(
      { error: 'Voice input is not set up on this deployment.' },
      { status: 503 },
    );
  }
  try {
    const form = await request.formData();
    const file = form.get('audio');
    if (!(file instanceof File)) return badRequest('no audio was uploaded');

    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length > MAX_AUDIO_BYTES) return badRequest('that recording is too long');

    const result = await transcribeAudio({
      bytes,
      filename: file.name || 'audio.webm',
      mimeType: file.type || undefined,
      language: (form.get('language') as string) || undefined,
      // Domain vocabulary as a prior — see transcribe.ts. Passed from the
      // client because it knows which venture names are on screen.
      prompt: (form.get('vocabulary') as string) || undefined,
    });
    return NextResponse.json(result);
  } catch (e: any) {
    // These messages are written for the person who just spoke, so they are
    // passed through rather than flattened to "internal error".
    return NextResponse.json({ error: e?.message || 'Could not transcribe that.' }, { status: 400 });
  }
}

export const POST = withApi(POST__impl as any, { route: '/api/assistant/transcribe', method: 'POST' });
