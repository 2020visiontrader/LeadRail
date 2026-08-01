import { withApi } from '@/lib/http';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Starter outreach templates. Placeholders: {{name}}, {{company}}.
const TEMPLATES = [
  { id: 'intro-investor', segment: 'investor', name: 'Investor Intro', subject: 'Quick intro — {{company}}', body: '<p>Hi {{name}},</p><p>Reaching out because your work at {{company}} aligns with what we are building. Open to a 15-min call?</p>' },
  { id: 'vc-followup', segment: 'vc', name: 'VC Follow-up', subject: 'Following up on {{company}}', body: '<p>Hi {{name}},</p><p>Circling back — happy to share our latest traction deck. When works this week?</p>' },
  { id: 'angel-warm', segment: 'angel', name: 'Angel Warm Intro', subject: 'Loved your angel thesis', body: '<p>Hi {{name}},</p><p>Your recent investments caught my eye. Would value 10 minutes of your perspective.</p>' },
  { id: 'founder-peer', segment: 'founder', name: 'Founder Peer', subject: 'Fellow founder — {{company}}', body: '<p>Hi {{name}},</p><p>Building in an adjacent space. Would love to compare notes.</p>' },
  { id: 'media-pitch', segment: 'media', name: 'Media Pitch', subject: 'Story idea for {{company}}', body: '<p>Hi {{name}},</p><p>Think your audience would find our launch relevant. Can I send a short brief?</p>' },
  { id: 'partner-collab', segment: 'partner', name: 'Partnership', subject: 'Partnership with {{company}}', body: '<p>Hi {{name}},</p><p>I see a clean partnership fit. Worth a quick exploratory call?</p>' },
];

async function GET__impl() {
  return NextResponse.json(TEMPLATES);
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/outreach/templates", method: "GET" });
