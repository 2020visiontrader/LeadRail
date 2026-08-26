// Voice, exercised against a REAL http server on localhost.
//
// The microphone shipped broken twice — an availability probe that could only
// ever answer "available", and a 503 path that unmounted the button along with
// its own error message. Both would have been caught by actually running the
// thing. These tests stand up a Whisper-shaped endpoint and post real multipart
// at it, so the wire format is verified rather than assumed.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

let server: Server;
let url = '';
let lastBody = '';

let lastHeaders: Record<string, string | string[] | undefined> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('latin1');
      lastHeaders = req.headers;
      if (req.url === '/fail') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'model not loaded' }));
      }
      if (req.url === '/silent') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ text: '   ' }));
      }
      if (req.url === '/quota-exceeded') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ detail: { status: 'quota_exceeded' } }));
      }
      if (req.url === '/elevenlabs-ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ text: 'from scribe', audio_duration_secs: 4.1 }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'two hundred qualified leads', duration: 3.2 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address() as any;
  url = `http://127.0.0.1:${a.port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return import('../lib/ai/transcribe');
}

describe('when it is not configured', () => {
  it('reports itself unconfigured rather than pretending', async () => {
    // This is the exact check the composer uses to decide whether to show a
    // microphone at all. The first version could only ever answer "yes".
    const m = await load({ TRANSCRIBE_URL: undefined });
    expect(m.transcribeConfigured()).toBe(false);
  });

  it('refuses with an actionable message, naming the variable to set', async () => {
    const m = await load({ TRANSCRIBE_URL: undefined });
    await expect(m.transcribeAudio({ bytes: Buffer.alloc(5000) }))
      .rejects.toThrow(/TRANSCRIBE_URL/);
  });
});

describe('against a live Whisper-shaped endpoint', () => {
  it('transcribes, and sends the multipart fields the contract requires', async () => {
    const m = await load({ TRANSCRIBE_URL: `${url}/v1/audio/transcriptions`, TRANSCRIBE_MODEL: 'whisper-1' });
    const r = await m.transcribeAudio({
      bytes: Buffer.from('fake audio bytes'.repeat(200)),
      filename: 'note.webm', mimeType: 'audio/webm',
    });
    expect(r.text).toBe('two hundred qualified leads');
    expect(r.duration).toBe(3.2);
    // The wire format every one of these servers expects.
    expect(lastBody).toContain('name="file"');
    expect(lastBody).toContain('filename="note.webm"');
    expect(lastBody).toContain('name="model"');
    expect(lastBody).toContain('whisper-1');
  });

  it('passes domain vocabulary through as a prior', async () => {
    const m = await load({ TRANSCRIBE_URL: `${url}/v1/audio/transcriptions` });
    await m.transcribeAudio({ bytes: Buffer.alloc(5000), prompt: 'Zoask, LeadRail' });
    // Without this a venture called "Zoask" comes back as "so ask".
    expect(lastBody).toContain('name="prompt"');
    expect(lastBody).toContain('Zoask, LeadRail');
  });

  it('surfaces the engine\'s own error instead of a generic failure', async () => {
    const m = await load({ TRANSCRIBE_URL: `${url}/fail` });
    await expect(m.transcribeAudio({ bytes: Buffer.alloc(5000) })).rejects.toThrow(/500|model not loaded/);
  });

  it('treats a blank transcript as silence, not as success', async () => {
    const m = await load({ TRANSCRIBE_URL: `${url}/silent` });
    // Handing back an empty box after someone spoke is the worst outcome.
    await expect(m.transcribeAudio({ bytes: Buffer.alloc(5000) })).rejects.toThrow(/silent|microphone/i);
  });
});

describe('ElevenLabs as primary, generic engine as fallback', () => {
  it('is configured when only ELEVENLABS_API_KEY is set', async () => {
    const m = await load({ TRANSCRIBE_URL: undefined, ELEVENLABS_API_KEY: 'sk_test' });
    expect(m.transcribeConfigured()).toBe(true);
  });

  it('uses ElevenLabs first, sending its own header and field shape', async () => {
    const m = await load({
      ELEVENLABS_API_KEY: 'sk_test',
      ELEVENLABS_URL: `${url}/elevenlabs-ok`,
      TRANSCRIBE_URL: `${url}/v1/audio/transcriptions`,
    });
    const r = await m.transcribeAudio({ bytes: Buffer.alloc(5000), language: 'en' });
    expect(r.text).toBe('from scribe');
    expect(r.duration).toBe(4.1);
    expect(r.provider).toBe('elevenlabs');
    expect(lastHeaders['xi-api-key']).toBe('sk_test');
    expect(lastBody).toContain('name="model_id"');
    expect(lastBody).toContain('name="language_code"');
  });

  it('falls back to the generic engine when ElevenLabs fails', async () => {
    const m = await load({
      ELEVENLABS_API_KEY: 'sk_test',
      ELEVENLABS_URL: `${url}/quota-exceeded`,
      TRANSCRIBE_URL: `${url}/v1/audio/transcriptions`,
      TRANSCRIBE_MODEL: 'whisper-1',
    });
    const r = await m.transcribeAudio({ bytes: Buffer.alloc(5000) });
    expect(r.text).toBe('two hundred qualified leads');
    expect(r.provider).toBe('generic');
  });

  it('surfaces the ElevenLabs error when no fallback is configured', async () => {
    const m = await load({
      ELEVENLABS_API_KEY: 'sk_test',
      ELEVENLABS_URL: `${url}/quota-exceeded`,
      TRANSCRIBE_URL: undefined,
    });
    await expect(m.transcribeAudio({ bytes: Buffer.alloc(5000) })).rejects.toThrow(/401|quota_exceeded/);
  });

  it('surfaces the generic engine error when both fail', async () => {
    const m = await load({
      ELEVENLABS_API_KEY: 'sk_test',
      ELEVENLABS_URL: `${url}/quota-exceeded`,
      TRANSCRIBE_URL: `${url}/fail`,
    });
    await expect(m.transcribeAudio({ bytes: Buffer.alloc(5000) })).rejects.toThrow(/500|model not loaded/);
  });
});

describe('input bounds', () => {
  it('rejects an empty recording', async () => {
    const m = await load({ TRANSCRIBE_URL: `${url}/v1/audio/transcriptions` });
    await expect(m.transcribeAudio({ bytes: Buffer.alloc(0) })).rejects.toThrow(/empty/i);
  });

  it('rejects a recording over the size ceiling', async () => {
    const m = await load({ TRANSCRIBE_URL: `${url}/v1/audio/transcriptions` });
    await expect(m.transcribeAudio({ bytes: Buffer.alloc(m.MAX_AUDIO_BYTES + 1) })).rejects.toThrow(/too long/i);
  });
});
