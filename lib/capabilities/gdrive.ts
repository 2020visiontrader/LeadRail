// lib/capabilities/gdrive.ts — Google Drive write/organise capabilities.
//
// THE DEFECT THIS CLOSES. Before this file, the assistant had exactly two
// Drive tools (searchDrive, readDriveFile — both still in knowledge.ts,
// deliberately left there rather than moved here, to avoid churn on files
// that already work): it could find and read a file, and nothing else. It
// could not list a folder, create or edit a file, organise anything, or
// share. This file is the wiring: thin wrappers over the new functions in
// lib/integrations/gdrive.ts, no Drive API logic reimplemented here.
//
// THE SCOPE BLOCKER. The stored Drive OAuth connection was granted
// drive.readonly — every write call below would have failed against it with
// an opaque Google 403 "Insufficient Permission". Fixed at the source
// (lib/social/google-oauth.ts's DRIVE_SCOPE widened to the full `drive`
// scope, the exchange/refresh now persist what Google actually granted as
// meta.scope), and every write function in lib/integrations/gdrive.ts routes
// through requireDriveWriteToken(), which reads that recorded scope and
// throws a readable, actionable message for a connection that predates the
// widening (or was only ever granted read access) instead of ever reaching
// Google and getting a raw 403 back.
//
// GATES.
//   listDriveFiles / getDriveFileMetadata — 'read'. No
//     mutation, and deliberately reachable even on a read-only connection
//     (requireDriveWriteToken is NOT used for these — see the functions'
//     own comments in lib/integrations/gdrive.ts).
//   createDriveFile / createDriveFolder / updateDriveFile / moveDriveFile —
//     'internal_write'. Every one of these mutates only the OWNER'S OWN
//     Drive (their files, their folders) — nothing is sent to a third party
//     and nothing is destroyed. Same category internal_write already covers
//     for markGmailMessageRead/createGmailDraft in lib/capabilities/gmail.ts.
//   shareDriveFile — 'external_send'. This is the one Drive write that is
//     NOT internal: it hands a real person (by email, or the entire public
//     internet via an "anyone" link) access to the OWNER'S data. That is
//     exactly the "reaches a real third party" line external_send draws —
//     the same class as sendGmailEmail, just granting access instead of
//     sending a message.
//   deleteDriveFile — 'destructive'. Permanently removes a file; Drive's own
//     files.delete is NOT the same as moving to trash — it is irreversible
//     from chat, the same class as deleteGmailDraft/deleteDeal.
import { z } from 'zod';
import {
  listDriveFilesInFolder,
  getDriveFileMetadata,
  createDriveFile,
  createDriveFolder,
  updateDriveFile,
  moveDriveFile,
  deleteDriveFile,
  shareDriveFile,
  type DriveFile,
} from '@/lib/integrations/gdrive';
import { obj, S, type Capability, present, digestLine, clip, plural, samples } from './types';

export const GDRIVE_CAPABILITIES: Capability[] = [
  {
    name: 'listDriveFiles',
    domain: 'gdrive',
    title: 'List a Google Drive folder',
    description:
      'List the files directly inside a Google Drive folder, by folder id (get folder ids from searchDrive or getDriveFileMetadata; the literal string "root" refers to the user\'s My Drive root folder). Returns file ids, names, and mime types.',
    gate: 'read',
    inputSchema: obj({ folderId: S.string, pageSize: S.number }, ['folderId']),
    zod: z.object({ folderId: z.string(), pageSize: z.number().int().positive().max(100).optional() }),
    run: (accountId, { folderId, pageSize }) => listDriveFilesInFolder(accountId, folderId, pageSize),
    digest: (_a, result) => {
      const rows: DriveFile[] | null = Array.isArray(result) ? result : null;
      if (!rows) return '';
      if (!rows.length) return 'The folder is empty.';
      const names = samples(rows, ['name'], 8);
      return digestLine(
        `${plural(rows.length, 'file')} in this folder.`,
        names.length ? `Includes: ${names.join(', ')}.` : null,
      );
    },
  },
  {
    name: 'getDriveFileMetadata',
    domain: 'gdrive',
    title: 'Get Google Drive file metadata',
    description:
      'Get one Google Drive file\'s metadata by id (name, mime type, last modified, parent folder, link) without reading its contents. Use readDriveFile instead to read the text.',
    gate: 'read',
    inputSchema: obj({ fileId: S.string }, ['fileId']),
    zod: z.object({ fileId: z.string() }),
    run: (accountId, { fileId }) => getDriveFileMetadata(accountId, fileId),
    digest: (_a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      if (!present(r, 'name') && !present(r, 'mimeType')) return '';
      return digestLine(
        present(r, 'name') ? `Name: "${clip(String(r.name), 120)}".` : null,
        present(r, 'mimeType') ? `Type: ${clip(String(r.mimeType), 80)}.` : null,
        present(r, 'modifiedTime') ? `Last modified: ${clip(String(r.modifiedTime), 40)}.` : null,
      );
    },
  },
  {
    name: 'createDriveFile',
    domain: 'gdrive',
    title: 'Create a Google Drive file',
    description:
      'Create a new file in Google Drive, optionally with text content and a parent folder. Writes only to the owner\'s own Drive — nothing is sent to anyone.',
    gate: 'internal_write',
    inputSchema: obj(
      { name: S.string, mimeType: S.string, parentId: S.string, content: S.string },
      ['name', 'mimeType'],
    ),
    zod: z.object({
      name: z.string(),
      mimeType: z.string(),
      parentId: z.string().optional(),
      content: z.string().optional(),
    }),
    run: (accountId, { name, mimeType, parentId, content }) =>
      createDriveFile(accountId, { name, mimeType, parentId, content }),
    digest: (a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      const id = present(r, 'id') ? String(r.id) : null;
      if (!id) return '';
      const name = present(a, 'name') ? String(a.name) : (present(r, 'name') ? String(r.name) : 'the file');
      return digestLine(`Created "${clip(name, 120)}" in Google Drive.`, `File id ${clip(id, 60)}.`);
    },
  },
  {
    name: 'createDriveFolder',
    domain: 'gdrive',
    title: 'Create a Google Drive folder',
    description:
      'Create a new folder in Google Drive, optionally inside a parent folder. Writes only to the owner\'s own Drive.',
    gate: 'internal_write',
    inputSchema: obj({ name: S.string, parentId: S.string }, ['name']),
    zod: z.object({ name: z.string(), parentId: z.string().optional() }),
    run: (accountId, { name, parentId }) => createDriveFolder(accountId, { name, parentId }),
    digest: (a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      const id = present(r, 'id') ? String(r.id) : null;
      if (!id) return '';
      const name = present(a, 'name') ? String(a.name) : (present(r, 'name') ? String(r.name) : 'the folder');
      return digestLine(`Created the folder "${clip(name, 120)}" in Google Drive.`, `Folder id ${clip(id, 60)}.`);
    },
  },
  {
    name: 'updateDriveFile',
    domain: 'gdrive',
    title: 'Update a Google Drive file',
    description:
      'Rename a Google Drive file and/or replace its text content, by id. Provide a new name, new content, or both. Writes only to the owner\'s own Drive.',
    gate: 'internal_write',
    inputSchema: obj(
      { fileId: S.string, name: S.string, content: S.string, mimeType: S.string },
      ['fileId'],
    ),
    zod: z.object({
      fileId: z.string(),
      name: z.string().optional(),
      content: z.string().optional(),
      mimeType: z.string().optional(),
    }),
    run: (accountId, { fileId, name, content, mimeType }) =>
      updateDriveFile(accountId, { fileId, name, content, mimeType }),
    digest: (a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      const id = present(r, 'id') ? String(r.id) : (present(a, 'fileId') ? String(a.fileId) : null);
      if (!id) return '';
      const renamed = present(a, 'name');
      const contentChanged = present(a, 'content');
      return digestLine(
        `Updated Google Drive file ${clip(id, 60)}.`,
        renamed ? `Renamed to "${clip(String(a.name), 120)}".` : null,
        contentChanged ? 'Content replaced.' : null,
      );
    },
  },
  {
    name: 'moveDriveFile',
    domain: 'gdrive',
    title: 'Move a Google Drive file',
    description:
      'Move a Google Drive file into a different folder, by id. Provide the destination folder id; the file\'s current parent is removed automatically unless you also pass oldParentId. Writes only to the owner\'s own Drive.',
    gate: 'internal_write',
    inputSchema: obj({ fileId: S.string, newParentId: S.string, oldParentId: S.string }, ['fileId', 'newParentId']),
    zod: z.object({ fileId: z.string(), newParentId: z.string(), oldParentId: z.string().optional() }),
    run: (accountId, { fileId, newParentId, oldParentId }) =>
      moveDriveFile(accountId, { fileId, newParentId, oldParentId }),
    digest: (a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      const id = present(r, 'id') ? String(r.id) : (present(a, 'fileId') ? String(a.fileId) : null);
      if (!id) return '';
      return digestLine(`Moved Google Drive file ${clip(id, 60)} to a new folder.`);
    },
  },
  {
    name: 'deleteDriveFile',
    domain: 'gdrive',
    title: 'Delete a Google Drive file',
    description:
      'Permanently delete a Google Drive file by id. This is irreversible — the file cannot be recovered from chat, and this is NOT the same as moving it to trash.',
    gate: 'destructive',
    inputSchema: obj({ fileId: S.string }, ['fileId']),
    zod: z.object({ fileId: z.string() }),
    run: (accountId, { fileId }) => deleteDriveFile(accountId, fileId),
    summarize: (a) => `Permanently delete Google Drive file ${String(a.fileId ?? '')}. This cannot be undone.`,
    digest: (a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      if (!r.deleted) return '';
      return digestLine(`Deleted Google Drive file ${clip(String(a.fileId ?? r.id ?? ''), 60)}.`);
    },
  },
  {
    name: 'shareDriveFile',
    domain: 'gdrive',
    title: 'Share a Google Drive file (GRANTS access to a real person)',
    description:
      'Grant a real person access to a Google Drive file by email (role: reader, commenter, or writer), or set anyone:true for a public link. This immediately gives someone real access to the owner\'s data once approved — it cannot be silently undone.',
    gate: 'external_send',
    inputSchema: obj(
      { fileId: S.string, role: S.string, emailAddress: S.string, anyone: { type: 'boolean' } },
      ['fileId', 'role'],
    ),
    zod: z.object({
      fileId: z.string(),
      role: z.enum(['reader', 'commenter', 'writer']),
      emailAddress: z.string().optional(),
      anyone: z.boolean().optional(),
    }),
    run: (accountId, { fileId, role, emailAddress, anyone }) =>
      shareDriveFile(accountId, { fileId, role, emailAddress, anyone }),
    summarize: (a) => {
      const who = a.anyone ? 'anyone with the link' : String(a.emailAddress ?? 'a person');
      return `Grant ${String(a.role ?? 'reader')} access to Google Drive file ${String(a.fileId ?? '')} for ${who}. This gives them real access to the owner's data immediately.`;
    },
    digest: (a, result) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
      const r: any = result;
      const id = present(r, 'id') ? String(r.id) : null;
      if (!id) return '';
      const who = present(r, 'emailAddress') ? String(r.emailAddress) : (a.anyone ? 'anyone with the link' : 'the recipient');
      return digestLine(
        `Shared the file with ${clip(who, 120)} as ${clip(String(r.role ?? a.role ?? 'reader'), 40)}.`,
        `Permission id ${clip(id, 60)}.`,
      );
    },
  },
];
