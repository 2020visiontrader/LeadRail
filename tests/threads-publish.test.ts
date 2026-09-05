// tests/threads-publish.test.ts — Threads went live in the Settings UI
// (lib/social/providers.ts `live: true`) with a complete OAuth flow and ZERO
// publisher: PUBLISHERS in lib/capabilities/social.ts had no `threads` entry,
// so every publish attempt failed after a successful "connected" state. This
// file covers the fix: lib/social/threads.ts's two-step publish/reply/hide
// functions, and that the wrong OAuth authorize host
// (lib/social/threads-oauth.ts's TH_AUTH, which pointed at
// www.facebook.com/v18.0/dialog/oauth instead of Threads' own authorize host)
// is now correct.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { publishThreadsPost, replyToThreadsPost, listThreadsReplies, hideThreadsReply } from '@/lib/social/threads';

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: any, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('publishThreadsPost — two-step container flow', () => {
  it('creates a container, then publishes it using the creation_id from step 1', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'CREATION_123' })) // POST /{userId}/threads
      .mockResolvedValueOnce(jsonResponse({ id: 'PUBLISHED_456' })); // POST /{userId}/threads_publish

    const result = await publishThreadsPost('tok-abc', 'user-1', { text: 'hello threads' });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [containerUrl, containerInit] = fetchMock.mock.calls[0];
    expect(String(containerUrl)).toContain('/user-1/threads?');
    expect(containerInit.method).toBe('POST');
    expect(String(containerUrl)).toContain('media_type=TEXT');
    expect(String(containerUrl)).toContain('access_token=tok-abc');

    const [publishUrl] = fetchMock.mock.calls[1];
    expect(String(publishUrl)).toContain('/user-1/threads_publish?');
    // THE ASSERTION THAT MATTERS: step 2 carries the id step 1 returned, not a
    // constant, not the args, not something echoed from the container body.
    expect(String(publishUrl)).toContain('creation_id=CREATION_123');

    expect(result).toEqual({ id: 'PUBLISHED_456' });
  });

  it('picks media_type from imageUrl/videoUrl and carries the url through', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'C1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'P1' }));
    await publishThreadsPost('tok', 'user-1', { imageUrl: 'https://example.com/pic.png' });
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('media_type=IMAGE');
    expect(String(url)).toContain(encodeURIComponent('https://example.com/pic.png'));
  });

  it('throws with the platform error message when the container step fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'Invalid text' } }, false, 400));
    await expect(publishThreadsPost('tok', 'user-1', { text: 'x' })).rejects.toThrow(/Invalid text/);
    // Only one call — a failed container must never reach the publish step.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws if the container step returns no creation_id, without calling publish', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(publishThreadsPost('tok', 'user-1', { text: 'x' })).rejects.toThrow(/creation_id/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('replyToThreadsPost', () => {
  it('sends reply_to_id on the container step, not the publish step', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'C2' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'P2' }));
    await replyToThreadsPost('tok', 'user-1', 'THREAD_TO_REPLY', 'nice post');
    const [containerUrl] = fetchMock.mock.calls[0];
    expect(String(containerUrl)).toContain('reply_to_id=THREAD_TO_REPLY');
    const [publishUrl] = fetchMock.mock.calls[1];
    expect(String(publishUrl)).not.toContain('reply_to_id');
  });
});

describe('listThreadsReplies', () => {
  it('reads GET /{id}/replies with the access token and returns the data array', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'r1', text: 'hi' }] }));
    const rows = await listThreadsReplies('tok', 'POST_1', 10);
    expect(rows).toEqual([{ id: 'r1', text: 'hi' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/POST_1/replies?');
    expect(String(url)).toContain('limit=10');
    expect(init).toBeUndefined(); // GET, no method override
  });
});

describe('hideThreadsReply', () => {
  it('POSTs /{replyId}/manage_reply with hide=true by default', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    await hideThreadsReply('tok', 'REPLY_1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/REPLY_1/manage_reply?');
    expect(String(url)).toContain('hide=true');
    expect(init.method).toBe('POST');
  });

  it('sends hide=false to unhide', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    await hideThreadsReply('tok', 'REPLY_1', false);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('hide=false');
  });
});

describe('Threads OAuth authorize host', () => {
  // Static source check, not an import — threads-oauth.ts's TH_AUTH is a
  // module-private const, and importing the module for its side effects
  // would also require env vars this test has no business setting.
  const source = readFileSync(path.resolve(__dirname, '../lib/social/threads-oauth.ts'), 'utf8');

  it('points at Threads\' own authorize host, not facebook.com', () => {
    const m = source.match(/const TH_AUTH = ['"]([^'"]+)['"]/);
    expect(m, 'expected to find TH_AUTH in threads-oauth.ts').toBeTruthy();
    const host = new URL(m![1]).host;
    expect(host).toBe('threads.net');
    expect(host).not.toContain('facebook.com');
  });
});
