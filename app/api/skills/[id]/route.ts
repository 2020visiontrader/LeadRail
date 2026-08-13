import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import {
  getSkillRow, updateCustomSkill, deleteCustomSkill, setAccountSkillState,
} from '@/lib/skills/store';

export const dynamic = 'force-dynamic';

// GET /api/skills/:id — fetch one catalog skill (global or this account's
// custom row) by id.
async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const skill = await getSkillRow(session.accountId, params.id);
    if (!skill) return badRequest('unknown skill');
    return NextResponse.json(skill);
  } catch (e) {
    return errorResponse(e);
  }
}

// PATCH /api/skills/:id — two independent things can be updated in one call,
// both optional:
//   - `enabled` / `overridden_instructions` -> account_skills (this account's
//     enable state for ANY visible skill, global or custom).
//   - field edits (name/description/category/instructions/...) -> the skills
//     row itself, but ONLY when it's a custom row owned by this account;
//     global catalog rows are read-only for field edits.
async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json();
    const existing = await getSkillRow(session.accountId, params.id);
    if (!existing) return badRequest('unknown skill');

    const wantsFieldEdit = ['name', 'description', 'category', 'instructions', 'slug'].some((k) => body?.[k] !== undefined);
    if (wantsFieldEdit) {
      if (existing.account_id !== session.accountId) {
        return badRequest('cannot edit a global catalog skill; enable/disable it or create your own custom skill instead');
      }
      await updateCustomSkill(session.accountId, params.id, {
        name: body?.name !== undefined ? String(body.name) : undefined,
        description: body?.description !== undefined ? (body.description ? String(body.description) : null) : undefined,
        category: body?.category !== undefined ? (body.category ? String(body.category) : null) : undefined,
        instructions: body?.instructions !== undefined ? String(body.instructions) : undefined,
        slug: body?.slug !== undefined ? String(body.slug) : undefined,
      });
    }

    if (body?.enabled !== undefined || body?.overridden_instructions !== undefined) {
      await setAccountSkillState(session.accountId, params.id, {
        enabled: body?.enabled !== undefined ? Boolean(body.enabled) : undefined,
        overridden_instructions: body?.overridden_instructions !== undefined ? (body.overridden_instructions ? String(body.overridden_instructions) : null) : undefined,
      });
    }

    const updated = await getSkillRow(session.accountId, params.id);
    return NextResponse.json(updated);
  } catch (e: any) {
    if (e?.message === 'skill not found') return badRequest('unknown skill');
    return errorResponse(e);
  }
}

// DELETE /api/skills/:id — hard delete, custom (account-owned) skills only.
// Global catalog rows cannot be deleted here — disable them via PATCH
// {enabled:false} instead.
async function DELETE__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const existing = await getSkillRow(session.accountId, params.id);
    if (!existing) return badRequest('unknown skill');
    if (existing.account_id !== session.accountId) {
      return badRequest('cannot delete a global catalog skill; disable it for your account instead');
    }
    return NextResponse.json(await deleteCustomSkill(session.accountId, params.id));
  } catch (e: any) {
    if (e?.message === 'skill not found') return badRequest('unknown skill');
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: '/api/skills/[id]', method: 'GET' });
export const PATCH = withApi(PATCH__impl as any, { route: '/api/skills/[id]', method: 'PATCH' });
export const DELETE = withApi(DELETE__impl as any, { route: '/api/skills/[id]', method: 'DELETE' });
