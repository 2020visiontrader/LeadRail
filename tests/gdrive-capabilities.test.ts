// tests/gdrive-capabilities.test.ts — Google Drive write/organise domain
// (lib/capabilities/gdrive.ts, lib/integrations/gdrive.ts's new write
// functions, and the scope-widening in lib/social/google-oauth.ts).
//
// THE DEFECT UNDER TEST: the assistant had only searchDrive/readDriveFile —
// it could not list a folder, create or edit a file, organise anything, or
// share. Worse, the stored Drive OAuth connection was scoped
// drive.readonly, so every write call built here would have failed against
// it with an opaque Google 403. This file covers:
//   A. capability registration + gate classification (real registry)
//   B. the read-only-connection gate: a connection recorded with no `drive`
//      write scope (including one with NO recorded scope at all — the
//      honest "predates this change" case) gets a readable error, never a
//      raw 403
//   C. a write-capable connection actually reaches the Drive API
//   D. the multipart upload body for createDriveFile actually carries the
//      content
//   E. moveDriveFile sends BOTH addParents and removeParents
//   F. digest: results render as prose, never raw JSON
//
// Fetch is mocked directly (gdrive.ts calls global fetch, not an injected
// client) — the module under test is never mocked, only what it calls.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getConnection = vi.fn();
const upsertConnection = vi.fn();
vi.mock('@/lib/db', () => ({
  getConnection: (...a: any[]) => (getConnection as any)(...a),
  upsertConnection: (...a: any[]) => (upsertConnection as any)(...a),
}));

const resolveTokensForRow = vi.fn();
vi.mock('@/lib/social/connection-token', () => ({
  resolveTokensForRow: (...a: any[]) => (resolveTokensForRow as any)(...a),
  encryptTokenBundle: () => 'encrypted-bundle',
  stripTokenKeys: (meta: any) => ({ ...(meta || {}) }),
}));

const refreshGoogleToken = vi.fn();
vi.mock('@/lib/social/google-oauth', () => ({
  refreshGoogleToken: (...a: any[]) => (refreshGoogleToken as any)(...a),
}));

const ACCOUNT_A = 'acct-a';
const FUTURE_EXPIRY = Date.now() + 60 * 60 * 1000;

const WRITE_ROW = {
  id: 'row-a',
  account_id: ACCOUNT_A,
  provider: 'google_drive',
  external_id: 'a@example.com',
  secret_encrypted: 'ciphertext',
  meta: { expiry_ms: FUTURE_EXPIRY, email: 'a@example.com', scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email' },
};

const READONLY_ROW = {
  ...WRITE_ROW,
  meta: { expiry_ms: FUTURE_EXPIRY, email: 'a@example.com', scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email' },
};

const NO_SCOPE_ROW = {
  ...WRITE_ROW,
  meta: { expiry_ms: FUTURE_EXPIRY, email: 'a@example.com' }, // predates this change — no meta.scope at all
};

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: any, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

async function gdriveCaps() {
  const { GDRIVE_CAPABILITIES } = await import('@/lib/capabilities/gdrive');
  return Object.fromEntries(GDRIVE_CAPABILITIES.map((c) => [c.name, c]));
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveTokensForRow.mockResolvedValue({ accessToken: 'fresh-token', refreshToken: 'refresh-token', userToken: null });
  fetchMock = vi.fn(async () => jsonResponse({}));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// A. Capability registration + gate classification — the REAL registry.
// ---------------------------------------------------------------------------
describe('gdrive capabilities: registration and gates', () => {
  const ALL_GDRIVE_CAPABILITY_NAMES = [
    'listDriveFiles', 'getDriveFileMetadata', 'createDriveFile',
    'createDriveFolder', 'updateDriveFile', 'moveDriveFile', 'deleteDriveFile', 'shareDriveFile',
  ];

  it('registers all eight gdrive capabilities, present in the catalog', async () => {
    const { CAPABILITY_BY_NAME } = await import('@/lib/capabilities/registry');
    for (const name of ALL_GDRIVE_CAPABILITY_NAMES) {
      expect(CAPABILITY_BY_NAME[name], `${name} should be registered`).toBeTruthy();
    }
    const { GDRIVE_CAPABILITIES } = await import('@/lib/capabilities/gdrive');
    expect(GDRIVE_CAPABILITIES).toHaveLength(8);
  });

  it('listDriveFiles, getDriveFileMetadata are read — no approval', async () => {
    const { CAPABILITY_BY_NAME } = await import('@/lib/capabilities/registry');
    const { isSensitive } = await import('@/lib/capabilities/types');
    for (const name of ['listDriveFiles', 'getDriveFileMetadata']) {
      expect(CAPABILITY_BY_NAME[name].gate).toBe('read');
      expect(isSensitive(CAPABILITY_BY_NAME[name])).toBe(false);
    }
  });

  it('no two gdrive capabilities share a run implementation or declare themselves an alias of another', async () => {
    const { GDRIVE_CAPABILITIES } = await import('@/lib/capabilities/gdrive');
    // Each capability's `run` is defined as its own arrow-function closure, so
    // comparing function identity would never match even for a copy-pasted
    // duplicate — compare the function SOURCE TEXT instead, which is what
    // actually distinguishes "wraps a different underlying call" from
    // "wraps the exact same call with the exact same argument wiring".
    const runBySource = new Map<string, string>();
    for (const cap of GDRIVE_CAPABILITIES) {
      const src = cap.run.toString();
      const prior = runBySource.get(src);
      expect(prior, `${cap.name} has the same run implementation as ${prior} — duplicate capability`).toBeUndefined();
      runBySource.set(src, cap.name);

      // A capability whose own description/title admits it's an alias/duplicate
      // of another tool is the same defect even if the run functions differ.
      // Match "same as <camelCaseToolName>" specifically (not any prose use of
      // "same as", e.g. "NOT the same as moving it to trash" is legitimate).
      const text = `${cap.title} ${cap.description}`;
      expect(text, `${cap.name}'s title/description declares itself an alias — merge or remove it`).not.toMatch(
        /\balias\b|\bduplicate of\b/i,
      );
      // Case-sensitive: only a literal camelCase tool name after "same as"
      // counts (e.g. "same as listDriveFiles"), not prose like "the same as
      // moving it to trash".
      expect(text, `${cap.name}'s title/description points to another capability as "same as <toolName>" — merge or remove it`).not.toMatch(
        /same as\s+[a-z]+[A-Z]\w*/,
      );
    }
  });

  it('createDriveFile, createDriveFolder, updateDriveFile, moveDriveFile are internal_write — run immediately', async () => {
    const { CAPABILITY_BY_NAME } = await import('@/lib/capabilities/registry');
    const { isSensitive } = await import('@/lib/capabilities/types');
    for (const name of ['createDriveFile', 'createDriveFolder', 'updateDriveFile', 'moveDriveFile']) {
      expect(CAPABILITY_BY_NAME[name].gate).toBe('internal_write');
      expect(isSensitive(CAPABILITY_BY_NAME[name])).toBe(false);
    }
  });

  it('shareDriveFile is external_send — grants a real person access, needs approval', async () => {
    const { CAPABILITY_BY_NAME } = await import('@/lib/capabilities/registry');
    const { isSensitive } = await import('@/lib/capabilities/types');
    expect(CAPABILITY_BY_NAME.shareDriveFile.gate).toBe('external_send');
    expect(isSensitive(CAPABILITY_BY_NAME.shareDriveFile)).toBe(true);
  });

  it('deleteDriveFile is destructive — irreversible, needs approval', async () => {
    const { CAPABILITY_BY_NAME } = await import('@/lib/capabilities/registry');
    const { isSensitive } = await import('@/lib/capabilities/types');
    expect(CAPABILITY_BY_NAME.deleteDriveFile.gate).toBe('destructive');
    expect(isSensitive(CAPABILITY_BY_NAME.deleteDriveFile)).toBe(true);
  });

  it('every gdrive tool has a TOOL_VERB entry (fixture already enforces this globally; spot-check directly)', async () => {
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const file = path.join(process.cwd(), 'src/components/AgentConsole.tsx');
    const src = await fs.readFile(file, 'utf8');
    for (const name of ALL_GDRIVE_CAPABILITY_NAMES) {
      expect(src).toContain(`${name}:`);
    }
  });
});

// ---------------------------------------------------------------------------
// B. The read-only-connection gate.
// ---------------------------------------------------------------------------
describe('the read-only-connection gate: a readable message, never a raw 403', () => {
  it('a connection recorded with drive.readonly (not the full drive scope) is refused with a readable message', async () => {
    getConnection.mockResolvedValue(READONLY_ROW);
    const caps = await gdriveCaps();
    await expect(
      caps.createDriveFile.run(ACCOUNT_A, { name: 'x.txt', mimeType: 'text/plain' }),
    ).rejects.toThrow(/read-only/i);
    await expect(
      caps.createDriveFile.run(ACCOUNT_A, { name: 'x.txt', mimeType: 'text/plain' }),
    ).rejects.toThrow(/reconnect it in settings/i);
    // Never a raw Google error code leaking through instead:
    await caps.createDriveFile.run(ACCOUNT_A, { name: 'x.txt', mimeType: 'text/plain' }).catch((e: Error) => {
      expect(e.message).not.toMatch(/insufficient permission|403/i);
    });
    // The gate fires BEFORE any write reaches Google:
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a connection with NO recorded scope at all (predates the widening) is ALSO treated as read-only — the honest default', async () => {
    getConnection.mockResolvedValue(NO_SCOPE_ROW);
    const caps = await gdriveCaps();
    await expect(
      caps.deleteDriveFile.run(ACCOUNT_A, { fileId: 'f1' }),
    ).rejects.toThrow(/read-only/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the same read-only connection can still READ (listDriveFiles is unaffected by the write gate)', async () => {
    getConnection.mockResolvedValue(READONLY_ROW);
    fetchMock.mockResolvedValue(jsonResponse({ files: [{ id: 'f1', name: 'Doc', mimeType: 'text/plain' }] }));
    const caps = await gdriveCaps();
    const result = await caps.listDriveFiles.run(ACCOUNT_A, { folderId: 'folder1' });
    expect(result).toEqual([{ id: 'f1', name: 'Doc', mimeType: 'text/plain' }]);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('a connection carrying the full drive scope is allowed through to the write', async () => {
    getConnection.mockResolvedValue(WRITE_ROW);
    fetchMock.mockResolvedValue(jsonResponse({ id: 'new-folder-1', name: 'New Folder', mimeType: 'application/vnd.google-apps.folder' }));
    const caps = await gdriveCaps();
    const result = await caps.createDriveFolder.run(ACCOUNT_A, { name: 'New Folder' });
    expect((result as any).id).toBe('new-folder-1');
    expect(fetchMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// C/D. Multipart upload actually carries the content.
// ---------------------------------------------------------------------------
describe('createDriveFile: multipart upload body actually carries the content', () => {
  it('the request body includes both the JSON metadata part and the raw text content', async () => {
    getConnection.mockResolvedValue(WRITE_ROW);
    fetchMock.mockResolvedValue(jsonResponse({ id: 'file-1', name: 'notes.txt', mimeType: 'text/plain' }));
    const caps = await gdriveCaps();
    await caps.createDriveFile.run(ACCOUNT_A, {
      name: 'notes.txt',
      mimeType: 'text/plain',
      parentId: 'folder-9',
      content: 'CONTENT-CANARY: the actual body text',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('upload/drive/v3/files');
    expect(String(url)).toContain('uploadType=multipart');
    expect(init.method).toBe('POST');
    expect(String(init.headers.Authorization)).toContain('fresh-token');
    expect(String(init.headers['Content-Type'])).toMatch(/^multipart\/related; boundary=/);
    const body = String(init.body);
    expect(body).toContain('"name":"notes.txt"');
    expect(body).toContain('"mimeType":"text/plain"');
    expect(body).toContain('"parents":["folder-9"]');
    expect(body).toContain('CONTENT-CANARY: the actual body text');
  });

  it('the digest names the created file, not raw JSON', async () => {
    getConnection.mockResolvedValue(WRITE_ROW);
    fetchMock.mockResolvedValue(jsonResponse({ id: 'file-1', name: 'notes.txt' }));
    const caps = await gdriveCaps();
    const result = await caps.createDriveFile.run(ACCOUNT_A, { name: 'notes.txt', mimeType: 'text/plain', content: 'hi' });
    const digest = caps.createDriveFile.digest!({ name: 'notes.txt' }, result);
    expect(digest).toContain('notes.txt');
    expect(digest).not.toMatch(/[{}[\]]/);
  });
});

// ---------------------------------------------------------------------------
// E. moveDriveFile sends BOTH addParents and removeParents.
// ---------------------------------------------------------------------------
describe('moveDriveFile: sends both addParents and removeParents', () => {
  it('when oldParentId is given explicitly, both query params are sent in one PATCH', async () => {
    getConnection.mockResolvedValue(WRITE_ROW);
    fetchMock.mockResolvedValue(jsonResponse({ id: 'f1', name: 'Doc', parents: ['new-parent'] }));
    const caps = await gdriveCaps();
    await caps.moveDriveFile.run(ACCOUNT_A, { fileId: 'f1', newParentId: 'new-parent', oldParentId: 'old-parent' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('PATCH');
    expect(String(url)).toContain('addParents=new-parent');
    expect(String(url)).toContain('removeParents=old-parent');
  });

  it('when oldParentId is omitted, it is looked up from the file\'s current parents, then still sends both params', async () => {
    getConnection.mockResolvedValue(WRITE_ROW);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ parents: ['current-parent'] })) // the GET lookup
      .mockResolvedValueOnce(jsonResponse({ id: 'f1', parents: ['new-parent'] })); // the PATCH
    const caps = await gdriveCaps();
    await caps.moveDriveFile.run(ACCOUNT_A, { fileId: 'f1', newParentId: 'new-parent' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [patchUrl, patchInit] = fetchMock.mock.calls[1];
    expect(patchInit.method).toBe('PATCH');
    expect(String(patchUrl)).toContain('addParents=new-parent');
    expect(String(patchUrl)).toContain('removeParents=current-parent');
  });
});

// ---------------------------------------------------------------------------
// F0. Arg schema validation (zod) — required fields actually enforced.
// ---------------------------------------------------------------------------
describe('arg validation: required fields are actually required', () => {
  it('createDriveFile requires name and mimeType', async () => {
    const caps = await gdriveCaps();
    expect(caps.createDriveFile.zod.safeParse({}).success).toBe(false);
    expect(caps.createDriveFile.zod.safeParse({ name: 'x' }).success).toBe(false);
    expect(caps.createDriveFile.zod.safeParse({ name: 'x', mimeType: 'text/plain' }).success).toBe(true);
  });

  it('moveDriveFile requires fileId and newParentId; oldParentId stays optional', async () => {
    const caps = await gdriveCaps();
    expect(caps.moveDriveFile.zod.safeParse({ fileId: 'f1' }).success).toBe(false);
    expect(caps.moveDriveFile.zod.safeParse({ fileId: 'f1', newParentId: 'p1' }).success).toBe(true);
  });

  it('shareDriveFile requires fileId and a valid role enum', async () => {
    const caps = await gdriveCaps();
    expect(caps.shareDriveFile.zod.safeParse({ fileId: 'f1', role: 'owner' }).success).toBe(false); // not in enum
    expect(caps.shareDriveFile.zod.safeParse({ fileId: 'f1', role: 'reader' }).success).toBe(true);
    expect(caps.shareDriveFile.zod.safeParse({ role: 'reader' }).success).toBe(false); // missing fileId
  });
});

// ---------------------------------------------------------------------------
// F. shareDriveFile and deleteDriveFile digests, and share validation.
// ---------------------------------------------------------------------------
describe('shareDriveFile and deleteDriveFile', () => {
  it('shareDriveFile requires an emailAddress unless anyone:true', async () => {
    getConnection.mockResolvedValue(WRITE_ROW);
    const caps = await gdriveCaps();
    await expect(
      caps.shareDriveFile.run(ACCOUNT_A, { fileId: 'f1', role: 'reader' }),
    ).rejects.toThrow(/emailAddress|anyone/i);
  });

  it('shareDriveFile with an email posts a user permission and digests the recipient', async () => {
    getConnection.mockResolvedValue(WRITE_ROW);
    fetchMock.mockResolvedValue(jsonResponse({ id: 'perm-1', role: 'reader', type: 'user', emailAddress: 'lead@example.com' }));
    const caps = await gdriveCaps();
    const result = await caps.shareDriveFile.run(ACCOUNT_A, { fileId: 'f1', role: 'reader', emailAddress: 'lead@example.com' });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ role: 'reader', type: 'user', emailAddress: 'lead@example.com' });
    const digest = caps.shareDriveFile.digest!({ role: 'reader' }, result);
    expect(digest).toContain('lead@example.com');
    expect(digest).not.toMatch(/[{}[\]]/);
  });

  it('shareDriveFile summarize discloses who gets access, without JSON', async () => {
    const caps = await gdriveCaps();
    const summary = caps.shareDriveFile.summarize!({ fileId: 'f1', role: 'writer', emailAddress: 'lead@example.com' });
    expect(summary).toContain('lead@example.com');
    expect(summary).not.toContain('[object Object]');
  });

  it('deleteDriveFile calls DELETE and digests a confirmation, never raw JSON', async () => {
    getConnection.mockResolvedValue(WRITE_ROW);
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => ({}), text: async () => '' });
    const caps = await gdriveCaps();
    const result = await caps.deleteDriveFile.run(ACCOUNT_A, { fileId: 'f1' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('DELETE');
    const digest = caps.deleteDriveFile.digest!({ fileId: 'f1' }, result);
    expect(digest).toContain('Deleted Google Drive file f1');
    expect(digest).not.toMatch(/[{}[\]]/);
  });
});
