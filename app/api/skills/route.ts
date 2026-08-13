import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { dbReady } from '@/lib/db';
import { SKILLS, SKILL_CATEGORIES } from '@/lib/skills/registry';
import { listVisibleSkills, listAccountSkillStates, createCustomSkill } from '@/lib/skills/store';

export const dynamic = 'force-dynamic';

// GET /api/skills — the curated built-in catalog (unchanged, id/name/category/when,
// consumed by the venture wizard) PLUS, when the DB is configured, the fuller
// harvested+custom catalog (migration 025_skills.sql) with this account's
// enabled/override state joined in. Callers that only care about the original
// 12 built-ins can keep reading `skills`; the new `catalog` field is additive.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const skills = SKILLS.map((s) => ({ id: s.id, name: s.name, category: s.category, when: s.when }));

  if (!dbReady()) {
    return NextResponse.json({ skills, categories: SKILL_CATEGORIES, catalog: [] });
  }

  try {
    const [rows, states] = await Promise.all([
      listVisibleSkills(session.accountId),
      listAccountSkillStates(session.accountId),
    ]);
    const stateBySkillId = new Map(states.map((s) => [s.skill_id, s]));
    const catalog = rows.map((r) => {
      const state = stateBySkillId.get(r.id);
      return {
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description,
        category: r.category,
        instructions: r.instructions,
        source: r.source,
        license: r.license,
        inspiredBy: r.inspired_by,
        qualityFlags: r.quality_flags || [],
        isCustom: r.account_id !== null,
        enabled: state?.enabled ?? false,
        overriddenInstructions: state?.overridden_instructions ?? null,
      };
    });
    return NextResponse.json({ skills, categories: SKILL_CATEGORIES, catalog });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/skills — create a custom skill owned by this account. account_id
// always comes from the session, never the client body.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    const name = String(body?.name || '').trim();
    if (!name) return badRequest('name is required');
    const slugSource = String(body?.slug || name).trim();
    const slug = slugSource
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
    if (!slug) return badRequest('could not derive a slug from name/slug');
    const instructions = typeof body?.instructions === 'string' ? body.instructions : '';
    if (!instructions.trim()) return badRequest('instructions is required');

    const skill = await createCustomSkill(session.accountId, {
      slug,
      name,
      description: body?.description ? String(body.description) : null,
      category: body?.category ? String(body.category) : null,
      instructions,
      source: 'custom',
      license: null,
      inspired_by: body?.inspired_by ? String(body.inspired_by) : null,
      quality_flags: [],
    });
    return NextResponse.json(skill, { status: 201 });
  } catch (e: any) {
    if (e?.code === '23505') return badRequest('a skill with that slug already exists for this account');
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/skills", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/skills", method: "POST" });
