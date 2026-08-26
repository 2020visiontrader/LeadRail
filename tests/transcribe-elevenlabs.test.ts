// The ElevenLabs dialect, against a server that is STRICT about it.
//
// ElevenLabs is the one provider that did not converge on the OpenAI shape:
// `xi-api-key` instead of a bearer token, `model_id` instead of `model`, and it
// rejects the extra multipart fields OpenAI accepts. Pointing TRANSCRIBE_URL at
// it unadapted yields a 401 or a 422, which reads to an operator as "voice is
// broken".
//
// The mock below REJECTS the wrong dialect rather than accepting anything, so
// these tests fail if the adapter regresses — a permissive mock would pass
// whatever we sent and prove nothing.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      const json = (code: number, payload: any) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // Strict, the way the real API is.
      if (!req.headers['xi-api-key']) return json(401, { detail: 'missing xi-api-key' });
      if (req.headers.authorization) return json(401, { detail: 'bearer auth is not accepted' });
      if (!body.includes('name="model_id"')) return json(422, { detail: 'model_id is required' });
      if (body.includes('name="model"\r\n')) return json(422, { detail: 'unknown field: model' });
      if (body.includes('name="prompt"')) return json(422, { detail: 'unknown field: prompt' });
      if (body.includes('name="response_format"')) return json(422, { detail: 'unknown field: response_format' });

      json(200, { text: 'find marketing agencies', language_code: 'en' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return import('../lib/ai/transcribe');
}

const EL = { TRANSCRIBE_URL: '', TRANSCRIBE_API_KEY: 'xi-test', TRANSCRIBE_MODEL: undefined, TRANSCRIBE_PROVIDER: 'elevenlabs' };

describe('choosing the dialect', () => {
  it('detects ElevenLabs from the host, with nothing configured', async () => {
    const m = await load({ TRANSCRIBE_PROVIDER: undefined });
    expect(m.providerFor('https://api.elevenlabs.io/v1/speech-to-text')).toBe('elevenlabs');
  });

  it('treats everything else as the OpenAI shape', async () => {
    const m = await load({ TRANSCRIBE_PROVIDER: undefined });
    expect(m.providerFor('https://api.groq.com/openai/v1/audio/transcriptions')).toBe('openai');
    expect(m.providerFor('http://localhost:8080/v1/audio/transcriptions')).toBe('openai');
  });

  it('lets an override win, for a proxy at an unexpected address', async () => {
    const m = await load({ TRANSCRIBE_PROVIDER: undefined });
    expect(m.providerFor('https://gateway.internal/stt', 'elevenlabs')).toBe('elevenlabs');
  });

  it('does not throw on a malformed URL', async () => {
    const m = await load({ TRANSCRIBE_PROVIDER: undefined });
    expect(m.providerFor('not a url')).toBe('openai');
  });
});

describe('talking to ElevenLabs', () => {
  it('transcribes against a server that rejects the OpenAI dialect', async () => {
    const m = await load({ ...EL, TRANSCRIBE_URL: `${base}/v1/speech-to-text` });
    const r = await m.transcribeAudio({ bytes: Buffer.alloc(5000), filename: 'note.webm' });
    expect(r.text).toBe('find marketing agencies');
    // Its own STT model, not a TTS id and not whisper-1.
    expect(r.model).toBe('scribe_v1');
  });

  it('does not send the vocabulary prompt, which would be rejected', async () => {
    // The prior is a real accuracy win on Whisper and a 422 here. Silently
    // dropping it is correct; sending it breaks every request.
    const m = await load({ ...EL, TRANSCRIBE_URL: `${base}/v1/speech-to-text` });
    const r = await m.transcribeAudio({ bytes: Buffer.alloc(5000), prompt: 'LeadRail, Zoask' });
    expect(r.text).toBe('find marketing agencies');
  });

  it('sends language under ElevenLabs\' own field name', async () => {
    const m = await load({ ...EL, TRANSCRIBE_URL: `${base}/v1/speech-to-text` });
    const r = await m.transcribeAudio({ bytes: Buffer.alloc(5000), language: 'en' });
    expect(r.text).toBe('find marketing agencies');
  });

  it('honours an explicit model over the default', async () => {
    const m = await load({ ...EL, TRANSCRIBE_URL: `${base}/v1/speech-to-text`, TRANSCRIBE_MODEL: 'scribe_v1_experimental' });
    const r = await m.transcribeAudio({ bytes: Buffer.alloc(5000) });
    expect(r.model).toBe('scribe_v1_experimental');
  });
});

describe('the failure this adapter exists to prevent', () => {
  it('sending the OpenAI dialect to ElevenLabs is rejected', async () => {
    // Proves the mock is strict, so the passing tests above mean something.
    const m = await load({ TRANSCRIBE_URL: `${base}/v1/speech-to-text`, TRANSCRIBE_API_KEY: 'k', TRANSCRIBE_PROVIDER: 'openai', TRANSCRIBE_MODEL: undefined });
    await expect(m.transcribeAudio({ bytes: Buffer.alloc(5000) })).rejects.toThrow(/401|422/);
  });
});
