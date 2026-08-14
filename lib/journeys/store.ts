// Account-scoped CRUD + graph validation for journeys (migration
// 029_journeys.sql). A journey is a branching automation graph — the DAG
// evolution of the linear lib/sequences.ts. Every query is scoped by
// account_id so a caller can never read or mutate another tenant's journey.

import { supabase } from '@/lib/db';

export type JourneyStatus = 'draft' | 'active' | 'paused' | 'archived';
export type JourneyTrigger = 'manual' | 'lead_created' | 'tag_added' | 'stage_changed';
export type JourneyNodeType = 'trigger' | 'send_email' | 'wait' | 'condition' | 'goal' | 'exit';

export interface JourneyEdge {
  to: string;                 // target node id
  when?: string | null;       // optional branch label (e.g. 'yes' | 'no' for condition)
}

export interface JourneyNode {
  id: string;
  type: JourneyNodeType;
  config: Record<string, any>;
  next: JourneyEdge[];
}

export interface JourneyGraph {
  nodes: JourneyNode[];
}

export interface JourneyRow {
  id: string;
  account_id: string;
  name: string;
  description: string | null;
  status: JourneyStatus;
  trigger: JourneyTrigger;
  graph: JourneyGraph;
  stats: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export const VALID_STATUS: JourneyStatus[] = ['draft', 'active', 'paused', 'archived'];
export const VALID_TRIGGER: JourneyTrigger[] = ['manual', 'lead_created', 'tag_added', 'stage_changed'];
const VALID_NODE_TYPES: JourneyNodeType[] = ['trigger', 'send_email', 'wait', 'condition', 'goal', 'exit'];

/**
 * Validate a journey graph before persisting. Enforces: exactly one trigger
 * node, unique node ids, known node types, and no dangling edges (every edge
 * target must reference an existing node). Returns the first error or null.
 * Kept pure (no I/O) so both create and update can gate on it.
 */
export function validateGraph(graph: JourneyGraph): string | null {
  if (!graph || !Array.isArray(graph.nodes)) return 'graph.nodes must be an array';
  const nodes = graph.nodes;
  if (nodes.length === 0) return null; // empty draft is allowed
  const ids = new Set<string>();
  let triggerCount = 0;
  for (const n of nodes) {
    if (!n.id) return 'every node needs an id';
    if (ids.has(n.id)) return `duplicate node id: ${n.id}`;
    ids.add(n.id);
    if (!VALID_NODE_TYPES.includes(n.type)) return `unknown node type: ${n.type}`;
    if (n.type === 'trigger') triggerCount++;
    if (!Array.isArray(n.next)) return `node ${n.id}: next must be an array`;
  }
  if (triggerCount !== 1) return `graph must have exactly one trigger node (found ${triggerCount})`;
  for (const n of nodes) {
    for (const e of n.next) {
      if (!ids.has(e.to)) return `node ${n.id} has a dangling edge to missing node: ${e.to}`;
    }
  }
  return null;
}

export async function listJourneys(accountId: string): Promise<JourneyRow[]> {
  const { data, error } = await supabase
    .from('journeys')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getJourney(accountId: string, id: string): Promise<JourneyRow | null> {
  const { data, error } = await supabase
    .from('journeys')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function createJourney(accountId: string, input: {
  name: string; description?: string; trigger?: JourneyTrigger; graph?: JourneyGraph;
}): Promise<JourneyRow> {
  const row = {
    account_id: accountId,
    name: input.name,
    description: input.description ?? null,
    trigger: input.trigger ?? 'manual',
    graph: input.graph ?? { nodes: [] },
    status: 'draft' as JourneyStatus,
  };
  const { data, error } = await supabase.from('journeys').insert([row]).select().single();
  if (error) throw error;
  return data;
}

export async function updateJourney(accountId: string, id: string, patch: {
  name?: string; description?: string; status?: JourneyStatus; trigger?: JourneyTrigger; graph?: JourneyGraph;
}): Promise<JourneyRow> {
  const row: Record<string, any> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.trigger !== undefined) row.trigger = patch.trigger;
  if (patch.graph !== undefined) row.graph = patch.graph;
  const { data, error } = await supabase
    .from('journeys')
    .update(row)
    .eq('id', id)
    .eq('account_id', accountId)
    .select()
    .single();
  if (error) throw error;
  if (!data) throw new Error('journey not found');
  return data;
}

export async function deleteJourney(accountId: string, id: string): Promise<{ id: string; deleted: true }> {
  const { data, error } = await supabase
    .from('journeys')
    .delete()
    .eq('id', id)
    .eq('account_id', accountId)
    .select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('journey not found');
  return { id, deleted: true };
}
