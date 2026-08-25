// Higgsfield — video generation, over MCP.
//
// A CORRECTION, recorded because the wrong version of this file shipped first.
// The original was written against a REST API at platform.higgsfield.ai with an
// `Authorization: Key KEY_ID:KEY_SECRET` header, and instructed operators to set
// HIGGSFIELD_API_KEY. Higgsfield does not issue an API key. It publishes an MCP
// server and nothing else, so that entire path — the base URL, the key format,
// the env var, the setup advice — was describing something that does not exist.
// Anyone following it would have gone looking for a key they could never find.
//
// So video generation goes where Higgsfield actually lives: the account's
// registered Higgsfield MCP server, called through the same client every other
// external MCP tool uses (lib/mcp/client.ts). No second credential, no second
// code path.
//
// WHAT THIS MEANS FOR CONNECTING. Higgsfield's MCP is OAuth-protected, and
// LeadRail's MCP client sends a static auth header — it has no OAuth flow
// (no discovery, no dynamic client registration, no PKCE, no refresh). Until
// that exists, this is reachable only if the server accepts a long-lived token
// in a header. `isConfigured` therefore reports on a REGISTERED SERVER ROW, and
// the capability says plainly what is missing rather than naming a key that was
// never real.

import { supabase, dbReady } from '@/lib/db';
import { callTool } from '@/lib/mcp/client';
import { decryptMcpAuthHeader, listMcpClients } from '@/lib/mcp/clients';

/** How we recognise the Higgsfield server among an account's MCP clients.
 *  Host-based rather than name-based: the row's name is whatever the operator
 *  typed, and matching on "did they call it Higgsfield" would miss a server
 *  registered as "video" pointing at the same endpoint. */
const HIGGSFIELD_HOST = /(^|\.)higgsfield\.ai$/i;

export interface HiggsfieldConnection {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  lastStatus: string | null;
  /** Tool names discovered on the last successful test, when there was one. */
  tools: string[];
}

/** The account's Higgsfield MCP server, or null when none is registered. */
export async function getHiggsfieldConnection(accountId: string): Promise<HiggsfieldConnection | null> {
  if (!dbReady() || !accountId) return null;
  try {
    const clients = await listMcpClients(accountId);
    const row = clients.find((c) => {
      try { return HIGGSFIELD_HOST.test(new URL(c.url).hostname); } catch { return false; }
    });
    if (!row) return null;
    const discovered = Array.isArray((row as any).discovered_tools) ? (row as any).discovered_tools : [];
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      enabled: row.enabled,
      lastStatus: (row as any).last_status ?? null,
      tools: discovered.map((t: any) => (typeof t === 'string' ? t : t?.name)).filter(Boolean),
    };
  } catch {
    return null;
  }
}

/** True when a Higgsfield MCP server is registered AND switched on. Async,
 *  unlike the env check it replaces — a connection is account state, not
 *  process state, and pretending otherwise is what produced the wrong file. */
export async function higgsfieldConfigured(accountId: string): Promise<boolean> {
  const conn = await getHiggsfieldConnection(accountId);
  return Boolean(conn?.enabled);
}

/** Plain-language reason a video request cannot proceed, or null when it can.
 *  Written for the person reading the assistant's reply, and deliberately never
 *  mentions an API key. */
export async function higgsfieldUnavailableReason(accountId: string): Promise<string | null> {
  const conn = await getHiggsfieldConnection(accountId);
  if (!conn) {
    return 'Video generation is not connected. Higgsfield is reached through its MCP server — add it under Admin → MCP servers.';
  }
  if (!conn.enabled) {
    return `The Higgsfield connection ("${conn.name}") is switched off. Turn it on under Admin → MCP servers.`;
  }
  return null;
}

/** Names the Higgsfield MCP publishes for the two things we need. Ordered by
 *  preference: the first one the server actually exposes wins, so a rename
 *  upstream degrades to "tool not found" with a real list rather than a silent
 *  failure. */
const VIDEO_TOOLS = ['generate_video', 'image2video', 'generate_video_batch'];
const STATUS_TOOLS = ['job_display', 'jobs_wait', 'show_generation_by_ids'];

function pickTool(available: string[], preferred: string[]): string | null {
  for (const name of preferred) if (available.includes(name)) return name;
  return null;
}

async function credentialsFor(accountId: string, connId: string) {
  const creds = await decryptMcpAuthHeader(accountId, connId);
  if (!creds) throw new Error('Could not read the Higgsfield connection.');
  return creds;
}

export interface GenerateVideoInput {
  /** The still to animate. Pair this with a character reference so the person
   *  in the video is the same person as in the stills. */
  imageUrl: string;
  /** What MOVES — camera motion, gesture, the action. Not who the subject is;
   *  that is already fixed by the image. */
  prompt: string;
  /** Spoken line for native lip-sync, when the model supports it. */
  dialogue?: string;
}

export interface VideoResult {
  url?: string;
  jobId?: string;
  status?: string;
  raw?: any;
}

/**
 * Animate a still into a short video through the Higgsfield MCP server.
 *
 * Returns whatever the server gives back rather than insisting on a shape:
 * this platform does not own that contract, the tool surface is versioned
 * upstream, and a normaliser written against a guess is how the first version
 * of this file went wrong. The caller reports what came back.
 */
export async function generateVideo(accountId: string, input: GenerateVideoInput): Promise<VideoResult> {
  const conn = await getHiggsfieldConnection(accountId);
  if (!conn) throw new Error('No Higgsfield MCP server is registered for this account.');

  const tool = pickTool(conn.tools, VIDEO_TOOLS);
  if (!tool) {
    throw new Error(
      conn.tools.length
        ? `The Higgsfield connection does not expose a video tool. It offers: ${conn.tools.slice(0, 12).join(', ')}.`
        : 'The Higgsfield connection has not discovered any tools yet — test it under Admin → MCP servers.',
    );
  }

  const { url, authHeader } = await credentialsFor(accountId, conn.id);
  const prompt = input.dialogue
    ? `${input.prompt}\n\nThe subject speaks this line to camera, lip-synced: "${input.dialogue}"`
    : input.prompt;

  const res = await callTool(url, authHeader, tool, {
    prompt,
    input_images: [{ type: 'image_url', image_url: input.imageUrl }],
  });
  if (!res.ok) throw new Error(res.error || 'The video tool failed.');

  return extractVideo(res.result);
}

/** Check on a render that was still going. */
export async function getVideoStatus(accountId: string, jobId: string): Promise<VideoResult> {
  const conn = await getHiggsfieldConnection(accountId);
  if (!conn) throw new Error('No Higgsfield MCP server is registered for this account.');

  const tool = pickTool(conn.tools, STATUS_TOOLS);
  if (!tool) throw new Error('The Higgsfield connection does not expose a job-status tool.');

  const { url, authHeader } = await credentialsFor(accountId, conn.id);
  const res = await callTool(url, authHeader, tool, { id: jobId, ids: [jobId] });
  if (!res.ok) throw new Error(res.error || 'Could not read the render status.');
  return extractVideo(res.result);
}

/** Pull a video URL and job id out of an MCP tool result, tolerantly.
 *
 *  MCP returns content blocks, and a provider may put its payload in a text
 *  block as JSON, in structured content, or both. Rather than assuming one, this
 *  looks for a URL that ends in a video extension anywhere in the response and
 *  hands back the raw result alongside, so nothing is lost when the shape is
 *  not what we expected. */
function extractVideo(result: any): VideoResult {
  const out: VideoResult = { raw: result };
  const blob = JSON.stringify(result ?? {});

  const urlMatch = blob.match(/https?:\/\/[^"'\s\\]+\.(?:mp4|mov|webm|m4v)(?:\?[^"'\s\\]*)?/i);
  if (urlMatch) out.url = urlMatch[0];

  const idMatch = blob.match(/"(?:job_?id|id|request_?id)"\s*:\s*"([^"]{6,})"/i);
  if (idMatch) out.jobId = idMatch[1];

  const statusMatch = blob.match(/"status"\s*:\s*"([a-z_]+)"/i);
  if (statusMatch) out.status = statusMatch[1];

  return out;
}
