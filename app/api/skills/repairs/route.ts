import { withApi, requireSession, errorResponse, badRequest } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { listSkillRepairs, applySkillRepair, rejectSkillRepair } from '@/lib/skills/repair';

export const dynamic = 'force-dynamic';

// Skill repair review — OWNER ONLY, both verbs.
//
// A repair rewrites text that lands in the assistant's system prompt, which is
// the most trusted position in the context. That is not a per-account
// preference and it is not something a client account may do on its own
// workspace: the skills catalog is shared, so an applied repair changes what
// every account's assistant reads. The role check below is the whole control.
async function requireOwner(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return { error };
  if (session.role !== 'owner') {
    return { error: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  }
  return { session };
}

async function GET__impl(request: NextRequest) {
  const { error } = await requireOwner(request);
  if (error) return error;
  try {
    return NextResponse.json({ repairs: await listSkillRepairs() });
  } catch (e) {
    return errorResponse(e);
  }
}

async function POST__impl(request: NextRequest) {
  const { session, error } = await requireOwner(request);
  if (error) return error;

  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }
  const repairId = typeof body?.repairId === 'string' ? body.repairId : '';
  const decision = body?.decision;
  if (!repairId) return badRequest('repairId is required');
  if (decision !== 'apply' && decision !== 'reject') return badRequest('decision must be "apply" or "reject"');

  try {
    if (decision === 'reject') {
      await rejectSkillRepair(repairId, session!.email || 'owner');
      return NextResponse.json({ applied: false, rejected: true });
    }
    // applySkillRepair re-screens the text on the way in and refuses a
    // proposal whose skill changed since it was written — see the guards there.
    const result = await applySkillRepair(repairId, session!.email || 'owner');
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: '/api/skills/repairs', method: 'GET' });
export const POST = withApi(POST__impl as any, { route: '/api/skills/repairs', method: 'POST' });
