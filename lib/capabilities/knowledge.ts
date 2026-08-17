import { z } from 'zod';
import { notionSearch, notionGetPageText } from '@/lib/integrations/notion';
import { driveSearch, driveReadFileText } from '@/lib/integrations/gdrive';
import {
  obj, S, type Capability,
  rowsOf, plural, tally, samples, digestLine,
} from './types';

export const KNOWLEDGE_CAPABILITIES: Capability[] = [
  {
    name: 'searchNotion',
    domain: 'knowledge',
    title: 'Search Notion',
    description: 'Search connected Notion for pages/databases matching a query. Use when the user references notes, docs, or knowledge kept in Notion.',
    gate: 'read',
    inputSchema: obj({ query: S.string, limit: S.number }, ['query']),
    zod: z.object({ query: z.string(), limit: z.number().optional() }),
    run: (accountId, { query, limit }) => notionSearch(accountId, query, limit),
    digest: (args, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      const titles = samples(rows, ['title'], 5);
      const kinds = tally(rows, 'type');
      const q = args?.query ? ` for "${String(args.query)}"` : '';
      return digestLine(
        `${plural(rows.length, 'Notion result')}${q}.`,
        kinds ? `By type: ${kinds}.` : null,
        titles.length ? `Titles: ${titles.join(' | ')}.` : null,
      );
    },
  },
  {
    name: 'searchDrive',
    domain: 'knowledge',
    title: 'Search Google Drive',
    description: 'Search connected Google Drive files by name. Use when the user references a document, sheet, or asset stored in Drive.',
    gate: 'read',
    inputSchema: obj({ query: S.string, limit: S.number }, ['query']),
    zod: z.object({ query: z.string(), limit: z.number().optional() }),
    run: (accountId, { query, limit }) => driveSearch(accountId, query, limit),
    digest: (args, result) => {
      const rows = rowsOf(result);
      if (!rows) return '';
      const names = samples(rows, ['name'], 5);
      const kinds = tally(rows, 'mimeType');
      const q = args?.query ? ` for "${String(args.query)}"` : '';
      return digestLine(
        `${plural(rows.length, 'Drive file')}${q}.`,
        kinds ? `By type: ${kinds}.` : null,
        names.length ? `Files: ${names.join(' | ')}.` : null,
      );
    },
  },
  {
    name: 'readNotionPage',
    domain: 'knowledge',
    title: 'Read Notion page',
    description: 'Read the text content of a specific Notion page by id (get the id from searchNotion first).',
    gate: 'read',
    inputSchema: obj({ pageId: S.string, max: S.number }, ['pageId']),
    zod: z.object({ pageId: z.string(), max: z.number().optional() }),
    run: (accountId, { pageId, max }) => notionGetPageText(accountId, pageId, max),
  },
  {
    name: 'readDriveFile',
    domain: 'knowledge',
    title: 'Read Google Drive file',
    description: 'Read the text content of a specific Google Drive file by id (get the id from searchDrive first). Exports Google Docs to text.',
    gate: 'read',
    inputSchema: obj({ fileId: S.string, maxChars: S.number }, ['fileId']),
    zod: z.object({ fileId: z.string(), maxChars: z.number().optional() }),
    run: (accountId, { fileId, maxChars }) => driveReadFileText(accountId, fileId, maxChars),
  },
];
