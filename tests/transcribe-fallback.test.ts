// The fallback loop: a second endpoint, tried only when the primary fails.
//
// The point is that a voice note should not die because one vendor had a bad
// five minutes — out of credits, a bad key, a transient outage. Both mock
// servers below are dialect-strict (same as transcribe-elevenlabs.test.ts),
// so a regression in the fallback's own request-building would fail these
// tests, not just the primary's.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

function makeServer(handler: (body: string, headers: Record<string, any>) => { code: number; payload: any }) {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      const { code, payload } = handler(body, req.headers as Record<string, any>);
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as any).port}`;
}

async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('../lib/ai/transcribe');
}

const BASE_ENV = {
  TRANSCRIBE_URL: undefined,
  TRANSCRIBE_API_KEY: undefined,
  TRANSCRIBE_MODEL: undefined,
  TRANSCRIBE_PROVIDER: undefined,
  TRANSCRIBE_FALLBACK_URL: undefined,
  TRANSCRIBE_FALLBACK_API_KEY: undefined,
  TRANSCRIBE_FALLBACK_MODEL: undefined,
  TRANSCRIBE_FALLBACK_PROVIDER: undefined,
};

describe('falling through to a second endpoint', () => {
  let downServer: Server;
  let upServer: Server;
  let downBase = '';
  let upBase = '';

  beforeAll(async () => {
    // Always 500s — models the primary being out of credits or down.
    downServer = makeServer(() => ({ code: 500, payload: { detail: 'out of credits' } }));
    // A working generic (OpenAI-shaped) endpoint.
    upServer = makeServer((body) => {
      if (!body.includes('name="model"\r\n')) return { code: 422, payload: { detail: 'model is required' } };
      return { code: 200, payload: { text: 'call the location scout', duration: 3.2 } };
    });
    downBase = await listen(downServer);
    upBase = await listen(upServer);
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((r) => downServer.close(() => r())),
      new Promise<void>((r) => upServer.close(() => r())),
    ]);
  });

  it('is configured as soon as a fallback URL is set', async () => {
    const m = await load({ ...BASE_ENV, TRANSCRIBE_FALLBACK_URL: `${upBase}/v1/audio/transcriptions` });
    expect(m.fallbackConfigured()).toBe(true);
  });

  it('is not configured when unset', async () => {
    const m = await load(BASE_ENV);
    expect(m.fallbackConfigured()).toBe(false);
  });

  it('uses the primary and never touches the fallback when the primary works', async () => {
    const m = await load({
      ...BASE_ENV,
      TRANSCRIBE_URL: `${upBase}/v1/audio/transcriptions`,
      TRANSCRIBE_FALLBACK_URL: `${downBase}/v1/audio/transcriptions`,
    });
    const r = await m.transcribeAudio({ bytes: Buffer.alloc(5000) });
    expect(r.text).toBe('call the location scout');
    expect(r.usedFallback).toBeFalsy();
  });

  it('falls through to the fallback when the primary fails', async () => {
    const m = await load({
      ...BASE_ENV,
      TRANSCRIBE_URL: `${downBase}/v1/audio/transcriptions`,
      TRANSCRIBE_FALLBACK_URL: `${upBase}/v1/audio/transcriptions`,
    });
    const r = await m.transcribeAudio({ bytes: Buffer.alloc(5000) });
    expect(r.text).toBe('call the location scout');
    expect(r.usedFallback).toBe(true);
  });

  it('surfaces the primary error directly when no fallback is configured', async () => {
    const m = await load({ ...BASE_ENV, TRANSCRIBE_URL: `${downBase}/v1/audio/transcriptions` });
    await expect(m.transcribeAudio({ bytes: Buffer.alloc(5000) })).rejects.toThrow(/500/);
  });

  it('surfaces the fallback error when both fail', async () => {
    const m = await load({
      ...BASE_ENV,
      TRANSCRIBE_URL: `${downBase}/v1/audio/transcriptions`,
      TRANSCRIBE_FALLBACK_URL: `${downBase}/v1/audio/transcriptions`,
    });
    await expect(m.transcribeAudio({ bytes: Buffer.alloc(5000) })).rejects.toThrow(/out of credits|500/);
  });

  it('adapts the fallback dialect independently of the primary', async () => {
    // Primary is a plain (down) OpenAI-shaped endpoint; fallback is ElevenLabs,
    // forced via TRANSCRIBE_FALLBACK_PROVIDER since the mock isn't on the real
    // elevenlabs.io host.
    const elevenServer = makeServer((body, headers) => {
      if (!headers['xi-api-key']) return { code: 401, payload: { detail: 'missing xi-api-key' } };
      if (!body.includes('name="model_id"')) return { code: 422, payload: { detail: 'model_id is required' } };
      return { code: 200, payload: { text: 'scout wrapped early' } };
    });
    const elevenBase = await listen(elevenServer);
    try {
      const m = await load({
        ...BASE_ENV,
        TRANSCRIBE_URL: `${downBase}/v1/audio/transcriptions`,
        TRANSCRIBE_FALLBACK_URL: `${elevenBase}/v1/speech-to-text`,
        TRANSCRIBE_FALLBACK_API_KEY: 'xi-test',
        TRANSCRIBE_FALLBACK_PROVIDER: 'elevenlabs',
      });
      const r = await m.transcribeAudio({ bytes: Buffer.alloc(5000) });
      expect(r.text).toBe('scout wrapped early');
      expect(r.usedFallback).toBe(true);
      expect(r.model).toBe('scribe_v1');
    } finally {
      elevenServer.close();
    }
  });
});
