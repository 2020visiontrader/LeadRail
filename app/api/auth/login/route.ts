import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { verifyPassword } from '@/lib/password';
import { signSession, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/session';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function POST__impl(request: NextRequest) {
  try {
    const { email, password } = await request.json();
    if (!email || !password) return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
    const { data: member } = await supabase
      .from('account_members')
      .select('account_id, email, role, password_hash')
      .eq('email', String(email).toLowerCase().trim())
      .maybeSingle();
    if (!member || !verifyPassword(password, member.password_hash)) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
    }
    const token = await signSession({ email: member.email, accountId: member.account_id, role: member.role, exp: Date.now() + SESSION_MAX_AGE * 1000 });
    await supabase.from('account_members').update({ last_login_at: new Date().toISOString() }).eq('account_id', member.account_id).eq('email', member.email);
    const res = NextResponse.json({ ok: true, email: member.email, role: member.role });
    res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: SESSION_MAX_AGE });
    return res;
  } catch {
    return NextResponse.json({ error: 'Login failed' }, { status: 500 });
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/auth/login", method: "POST" });
