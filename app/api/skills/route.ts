import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/http';
import { SKILLS, SKILL_CATEGORIES } from '@/lib/skills/registry';

export const dynamic = 'force-dynamic';

// GET /api/skills — the curated skills catalog (id, name, category, when).
// Used by the venture wizard to let the user pick skills or leave it to Hermes.
async function GET__impl(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  const skills = SKILLS.map((s) => ({ id: s.id, name: s.name, category: s.category, when: s.when }));
  return NextResponse.json({ skills, categories: SKILL_CATEGORIES });
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/skills", method: "GET" });
