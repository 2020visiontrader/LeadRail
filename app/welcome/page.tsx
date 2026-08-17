'use client';
import { useEffect, useRef } from 'react';
import Link from 'next/link';

// Public marketing landing — Tier C, no data access, no session required.
// Faithful port of design/Landing.dc.html (dark operator console). Fabricated
// metrics from the mockup were replaced with honest, verifiable claims per
// delegation/PACKET-11.2-landing-page.md — no invented numbers/social proof.

const HERO_STATS = [
  { value: '6-in-1', label: 'systems, one deck' },
  { value: '3', label: 'ventures, one login' },
  { value: 'Approval', label: 'before any send or spend' },
  { value: 'Sourced', label: 'every enriched field tagged' },
];

const MARQUEE = ['WATERFALL ENRICHMENT', 'ICP SCORING', 'MULTICHANNEL SEQUENCES', 'INTENT INBOX', 'HERMES AUTOMATION', 'VENTURE THEMING', 'APOLLO', 'META', 'INSTAGRAM', 'BUFFER', 'NOTION', 'GOOGLE DRIVE'];

const FEATURES = [
  { icon: 'W', title: 'Waterfall enrichment', body: 'Providers queried in ranked order — you pay only when one hits, and every field shows the source it came from.', iconBg: 'rgba(0,212,180,0.12)', iconColor: '#00D4B4' },
  { icon: 'S', title: 'ICP scoring', body: 'Fit, engagement and deal probability scored per lead — so the top sends each morning are ranked, not guessed.', iconBg: 'rgba(255,107,43,0.12)', iconColor: '#FF6B2B' },
  { icon: 'Q', title: 'Multichannel sequences', body: 'Email, LinkedIn and call steps in one touch plan, with per-step open and reply rates that tell you what to cut.', iconBg: 'rgba(0,212,180,0.12)', iconColor: '#00D4B4' },
  { icon: 'I', title: 'Intent-classified inbox', body: 'Replies land pre-sorted: positive, question, objection, not-now. Book the meeting before the thread goes cold.', iconBg: 'rgba(255,107,43,0.12)', iconColor: '#FF6B2B' },
  { icon: 'H', title: 'AI assistant, every step shown', body: 'Operate the platform in plain language. The assistant shows every action it takes and pauses for approval before anything that spends money or reaches a real person.', iconBg: 'rgba(0,212,180,0.12)', iconColor: '#00D4B4' },
  { icon: 'V', title: 'Multi-venture theming', body: 'RetentionRail, FilmOps, RENTAHUB — separate pipelines and brand themes, one login, one keyboard.', iconBg: 'rgba(255,107,43,0.12)', iconColor: '#FF6B2B' },
];

const STEPS = [
  { num: '01', title: 'Import', body: 'Drop a CSV or sync Apollo. Field mapping takes one screen, duplicates merge on the way in.' },
  { num: '02', title: 'Enrich & score', body: 'The waterfall fills emails and phones; the scoring engine ranks who is worth your morning.' },
  { num: '03', title: 'Sequence', body: 'Enroll by segment into venture-specific touch plans. Sends pace themselves past spam filters.' },
  { num: '04', title: 'Close', body: 'Intent-sorted replies with one-click booking. Qualified leads sync to your pipeline automatically.' },
];

const VENTURES = [
  { name: 'RetentionRail', tagline: 'Creator retention analytics', body: 'Churn prediction for MCNs and media companies — flag creators dropping off early.', secondary: '#00D4B4', accent: '#FF6B2B', primary: '#0F1A2E', floatDur: '7s' },
  { name: 'FilmOps', tagline: 'Production operating system', body: 'Script breakdown, scheduling and payroll bridging for production houses and agencies.', secondary: '#FF9500', accent: '#FFBF47', primary: '#1A1A1A', floatDur: '8s' },
  { name: 'RENTAHUB', tagline: 'SEA transport marketplace', body: 'Scooter and motorcycle rentals across Southeast Asia — with creator and affiliate partnerships.', secondary: '#00C2A8', accent: '#FF6B4A', primary: '#0F1520', floatDur: '9s' },
];

export default function Welcome() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Particle-net hero background.
    const canvas = canvasRef.current;
    let raf = 0;
    let onResize: (() => void) | null = null;
    if (canvas) {
      const ctx = canvas.getContext('2d')!;
      let w = 0, h = 0;
      let pts: { x: number; y: number; vx: number; vy: number }[] = [];
      const resize = () => {
        w = canvas.width = canvas.offsetWidth;
        h = canvas.height = canvas.offsetHeight;
        const count = Math.min(70, Math.floor(w / 22));
        pts = Array.from({ length: count }, () => ({
          x: Math.random() * w, y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35,
        }));
      };
      resize();
      onResize = resize;
      window.addEventListener('resize', resize);
      const tick = () => {
        if (!canvas.isConnected) return;
        ctx.clearRect(0, 0, w, h);
        for (const p of pts) {
          p.x += p.vx; p.y += p.vy;
          if (p.x < 0 || p.x > w) p.vx *= -1;
          if (p.y < 0 || p.y > h) p.vy *= -1;
        }
        for (let i = 0; i < pts.length; i++) {
          for (let j = i + 1; j < pts.length; j++) {
            const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < 140) {
              ctx.strokeStyle = 'rgba(0,212,180,' + (0.14 * (1 - d / 140)).toFixed(3) + ')';
              ctx.lineWidth = 1;
              ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); ctx.stroke();
            }
          }
        }
        for (const p of pts) {
          ctx.fillStyle = 'rgba(0,212,180,0.5)';
          ctx.beginPath(); ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2); ctx.fill();
        }
        raf = requestAnimationFrame(tick);
      };
      tick();
    }
    // Scroll reveals.
    const els = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-reveal]') ?? []);
    els.forEach((el) => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(28px)';
      el.style.transition = 'opacity 0.7s cubic-bezier(0.22,1,0.36,1), transform 0.7s cubic-bezier(0.22,1,0.36,1)';
      el.style.transitionDelay = (parseInt(el.getAttribute('data-reveal') || '0') * 90) + 'ms';
    });
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          (e.target as HTMLElement).style.opacity = '1';
          (e.target as HTMLElement).style.transform = 'translateY(0)';
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12 });
    els.forEach((el) => io.observe(el));
    return () => {
      cancelAnimationFrame(raf);
      if (onResize) window.removeEventListener('resize', onResize);
      io.disconnect();
    };
  }, []);

  const spotlight = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.currentTarget;
    const r = t.getBoundingClientRect();
    t.style.background = 'radial-gradient(320px circle at ' + (e.clientX - r.left) + 'px ' + (e.clientY - r.top) + 'px, rgba(0,212,180,0.06), #0F1A2E 70%)';
  };
  const unspot = (e: React.MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = '#0F1A2E'; };

  return (
    <div ref={rootRef} style={{ minHeight: '100vh', background: '#0A0F1F', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', color: '#FFFFFF', overflowX: 'hidden' }}>
      <style>{`
        @keyframes lr-shine{0%{background-position:200% center;}100%{background-position:-200% center;}}
        @keyframes lr-floaty{0%,100%{transform:translateY(0);}50%{transform:translateY(-14px);}}
        @keyframes lr-pulseDot{0%,100%{opacity:.5;transform:scale(1);}50%{opacity:1;transform:scale(1.4);}}
        @keyframes lr-marquee{0%{transform:translateX(0);}100%{transform:translateX(-50%);}}
        .lr-nav-link{font-size:13px;color:#A0AEC0;text-decoration:none;}
        .lr-nav-link:hover{color:#fff;}
        @media(max-width:720px){.lr-hero-h1{font-size:40px !important;}.lr-desktop-nav{display:none !important;}.lr-grid3,.lr-grid4{grid-template-columns:1fr !important;}}
      `}</style>

      {/* NAV */}
      <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 40px', background: 'rgba(10,15,31,0.75)', backdropFilter: 'blur(12px)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: 'linear-gradient(135deg,#00D4B4,#FF6B2B)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 15, color: '#0A0F1F' }}>L</div>
          <span style={{ fontSize: 16, fontWeight: 700 }}>LeadRail</span>
        </div>
        <nav className="lr-desktop-nav" style={{ display: 'flex', gap: 28, alignItems: 'center' }}>
          <a href="#features" className="lr-nav-link">Features</a>
          <a href="#how" className="lr-nav-link">How it works</a>
          <a href="#ventures" className="lr-nav-link">Ventures</a>
        </nav>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Link href="/login" style={{ fontSize: 13, fontWeight: 600, color: '#FFFFFF', padding: '8px 14px', textDecoration: 'none' }}>Log in</Link>
          <Link href="/login" style={{ fontSize: 13, fontWeight: 600, color: '#0A0F1F', background: '#FF6B2B', padding: '9px 16px', borderRadius: 6, textDecoration: 'none' }}>Get Started</Link>
        </div>
      </div>

      {/* HERO */}
      <div style={{ position: 'relative', minHeight: '92vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '140px 40px 80px', overflow: 'hidden' }}>
        <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 50% 30%, rgba(0,212,180,0.10), transparent 60%)', pointerEvents: 'none' }} />
        <div style={{ position: 'relative', maxWidth: 860, textAlign: 'center' }}>
          <div data-reveal="0" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'rgba(0,212,180,0.08)', border: '1px solid rgba(0,212,180,0.25)', borderRadius: 9999, padding: '7px 16px', marginBottom: 28 }}>
            <span style={{ width: 7, height: 7, borderRadius: 9999, background: '#00D4B4', animation: 'lr-pulseDot 2s ease-in-out infinite' }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: '#00D4B4' }}>One CRM. Three ventures. Zero guessing.</span>
          </div>
          <h1 data-reveal="1" className="lr-hero-h1" style={{ fontSize: 64, fontWeight: 800, letterSpacing: '-2px', lineHeight: 1.06, margin: '0 0 24px' }}>
            Find, enrich and close leads
            <span style={{ display: 'block', background: 'linear-gradient(90deg,#00D4B4,#FFFFFF,#FF6B2B,#00D4B4)', backgroundSize: '200% auto', WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent', animation: 'lr-shine 6s linear infinite' }}>before anyone else calls them.</span>
          </h1>
          <p data-reveal="2" style={{ fontSize: 18, color: '#A0AEC0', lineHeight: 1.65, maxWidth: 620, margin: '0 auto 36px' }}>Waterfall enrichment across your provider stack, ICP scoring that ranks who to send first, and multichannel sequences — for every brand you run, from one command deck.</p>
          <div data-reveal="3" style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link href="/login" style={{ fontSize: 15, fontWeight: 600, color: '#0A0F1F', background: '#FF6B2B', padding: '14px 28px', borderRadius: 8, boxShadow: '0 8px 32px rgba(255,107,43,0.35)', textDecoration: 'none' }}>Start free</Link>
            <Link href="/login" style={{ fontSize: 15, fontWeight: 600, color: '#FFFFFF', border: '1px solid rgba(255,255,255,0.18)', padding: '14px 28px', borderRadius: 8, textDecoration: 'none' }}>Log in</Link>
          </div>
          <div data-reveal="4" style={{ display: 'flex', gap: 40, justifyContent: 'center', marginTop: 64, flexWrap: 'wrap' }}>
            {HERO_STATS.map((hs) => (
              <div key={hs.label} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-1px', color: '#FFFFFF' }}>{hs.value}</div>
                <div style={{ fontSize: 12, color: '#6B7B93', marginTop: 4 }}>{hs.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* MARQUEE */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', borderBottom: '1px solid rgba(255,255,255,0.06)', padding: '18px 0', overflow: 'hidden', background: '#0C1226' }}>
        <div style={{ display: 'flex', gap: 56, width: 'max-content', animation: 'lr-marquee 28s linear infinite' }}>
          {[...MARQUEE, ...MARQUEE].map((label, i) => (
            <span key={i} style={{ fontSize: 13, fontWeight: 600, color: '#6B7B93', whiteSpace: 'nowrap', letterSpacing: 1 }}>{label}</span>
          ))}
        </div>
      </div>

      {/* FEATURES */}
      <div id="features" style={{ maxWidth: 1180, margin: '0 auto', padding: '110px 40px' }}>
        <div data-reveal="0" style={{ textAlign: 'center', marginBottom: 56 }}>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: 2, color: '#FF6B2B', textTransform: 'uppercase', marginBottom: 14 }}>The full outbound engine</div>
          <h2 style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-1px', margin: '0 0 14px' }}>Everything between a name and a deal</h2>
          <p style={{ fontSize: 16, color: '#A0AEC0', maxWidth: 560, margin: '0 auto' }}>Six systems that used to be six subscriptions, wired together and themed per venture.</p>
        </div>
        <div className="lr-grid3" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 18 }}>
          {FEATURES.map((f, i) => (
            <div key={f.title} data-reveal={String(i % 3)} onMouseMove={spotlight} onMouseLeave={unspot} style={{ position: 'relative', background: '#0F1A2E', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: 28, overflow: 'hidden', transition: 'border-color 0.3s' }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: f.iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, fontWeight: 800, color: f.iconColor, marginBottom: 18 }}>{f.icon}</div>
              <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>{f.title}</div>
              <div style={{ fontSize: 13, color: '#A0AEC0', lineHeight: 1.6 }}>{f.body}</div>
            </div>
          ))}
        </div>
      </div>

      {/* HOW IT WORKS */}
      <div id="how" style={{ background: '#0C1226', borderTop: '1px solid rgba(255,255,255,0.06)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ maxWidth: 1180, margin: '0 auto', padding: '110px 40px' }}>
          <div data-reveal="0" style={{ marginBottom: 56 }}>
            <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: 2, color: '#00D4B4', textTransform: 'uppercase', marginBottom: 14 }}>How it works</div>
            <h2 style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-1px', margin: 0 }}>Name in. Meeting out.</h2>
          </div>
          <div className="lr-grid4" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 18 }}>
            {STEPS.map((st, i) => (
              <div key={st.num} data-reveal={String(i)} style={{ position: 'relative', padding: '24px 20px 24px 0' }}>
                <div style={{ fontSize: 48, fontWeight: 800, letterSpacing: '-2px', color: 'transparent', WebkitTextStroke: '1px rgba(0,212,180,0.5)', marginBottom: 14 }}>{st.num}</div>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>{st.title}</div>
                <div style={{ fontSize: 13, color: '#A0AEC0', lineHeight: 1.6 }}>{st.body}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* VENTURES */}
      <div id="ventures" style={{ maxWidth: 1180, margin: '0 auto', padding: '110px 40px' }}>
        <div data-reveal="0" style={{ textAlign: 'center', marginBottom: 56 }}>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: 2, color: '#FF6B2B', textTransform: 'uppercase', marginBottom: 14 }}>Multi-venture by design</div>
          <h2 style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-1px', margin: '0 0 14px' }}>One deck, every brand you run</h2>
          <p style={{ fontSize: 16, color: '#A0AEC0', maxWidth: 560, margin: '0 auto' }}>Each venture gets its own pipeline, sequences and theme. Same muscle memory everywhere.</p>
        </div>
        <div className="lr-grid3" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 18 }}>
          {VENTURES.map((v, i) => (
            <div key={v.name} data-reveal={String(i)} style={{ background: '#0F1A2E', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: 28, animation: `lr-floaty ${v.floatDur} ease-in-out infinite` }}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
                <div style={{ width: 26, height: 26, borderRadius: 7, background: v.secondary }} />
                <div style={{ width: 26, height: 26, borderRadius: 7, background: v.accent }} />
                <div style={{ width: 26, height: 26, borderRadius: 7, background: v.primary, border: '1px solid rgba(255,255,255,0.12)' }} />
              </div>
              <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>{v.name}</div>
              <div style={{ fontSize: 12, color: v.secondary, fontWeight: 600, marginBottom: 10 }}>{v.tagline}</div>
              <div style={{ fontSize: 13, color: '#A0AEC0', lineHeight: 1.6 }}>{v.body}</div>
            </div>
          ))}
        </div>
      </div>

      {/* CTA */}
      <div style={{ position: 'relative', overflow: 'hidden', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 50% 100%, rgba(255,107,43,0.12), transparent 60%)', pointerEvents: 'none' }} />
        <div style={{ maxWidth: 760, margin: '0 auto', padding: '110px 40px', textAlign: 'center', position: 'relative' }}>
          <h2 data-reveal="0" style={{ fontSize: 44, fontWeight: 800, letterSpacing: '-1.5px', margin: '0 0 18px' }}>Import your list. Send your first sequence today.</h2>
          <p data-reveal="1" style={{ fontSize: 16, color: '#A0AEC0', margin: '0 0 32px' }}>Bring a contact list, pick a venture, and put your outbound on rails.</p>
          <div data-reveal="2" style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link href="/login" style={{ fontSize: 15, fontWeight: 600, color: '#0A0F1F', background: '#FF6B2B', padding: '14px 28px', borderRadius: 8, boxShadow: '0 8px 32px rgba(255,107,43,0.35)', textDecoration: 'none' }}>Create your workspace</Link>
            <Link href="/login" style={{ fontSize: 15, fontWeight: 600, color: '#FFFFFF', border: '1px solid rgba(255,255,255,0.18)', padding: '14px 28px', borderRadius: 8, textDecoration: 'none' }}>Log in</Link>
          </div>
        </div>
      </div>

      {/* FOOTER */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '32px 40px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 24, height: 24, borderRadius: 6, background: 'linear-gradient(135deg,#00D4B4,#FF6B2B)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 12, color: '#0A0F1F' }}>L</div>
          <span style={{ fontSize: 13, color: '#6B7B93' }}>© 2026 LeadRail · Excalix, Toronto, ON</span>
        </div>
        <div style={{ display: 'flex', gap: 24 }}>
          <Link href="/privacy" style={{ fontSize: 12, color: '#6B7B93', textDecoration: 'none' }}>Privacy</Link>
          <Link href="/terms" style={{ fontSize: 12, color: '#6B7B93', textDecoration: 'none' }}>Terms</Link>
          <Link href="/login" style={{ fontSize: 12, color: '#6B7B93', textDecoration: 'none' }}>Log in</Link>
        </div>
      </div>
    </div>
  );
}
