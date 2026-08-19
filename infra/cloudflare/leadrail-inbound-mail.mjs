// LeadRail inbound-mail Email Worker.
// For each inbound message on a bound address it: (1) best-effort POSTs a parsed
// JSON payload to the LeadRail inbound webhook, and (2) forwards the original to
// the operator Gmail so nothing is lost. Delivery is never blocked by the webhook.

const WEBHOOK = 'https://app.leadrail.xyz/api/webhooks/inbound-email';
// Live value equals the app's INBOUND_EMAIL_SECRET env; set inline in the deployed Cloudflare worker, not committed.
const SECRET = 'REDACTED_SET_IN_DEPLOYED_WORKER';
// Per-address Gmail secondary. Falls back to the operator inbox.
const FORWARD_MAP = {
  'franck@leadrail.xyz': 'leadrailos@gmail.com',
  'hello@leadrail.xyz': 'leadrailos@gmail.com',
  'francksayshello@leadrail.xyz': 'leadrailos@gmail.com',
  'rentahub@leadrail.xyz': 'therentahub@gmail.com',
  'retentionrail@leadrail.xyz': 'francklrail@gmail.com',
  // filmopsai.com is a separate zone; this entry only takes effect once that
  // zone's Email Routing rule for franck@filmopsai.com is repointed to this
  // worker (not done automatically — see infra/cloudflare/README.md).
  'franck@filmopsai.com': 'franckf.bdbpro@gmail.com',
};
const DEFAULT_FORWARD = 'leadrailos@gmail.com';

function decodeQP(s) {
  return s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeCTE(body, cte) {
  cte = (cte || '').toLowerCase();
  if (cte.includes('quoted-printable')) return decodeQP(body);
  if (cte.includes('base64')) {
    try {
      const bin = atob(body.replace(/\s+/g, ''));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      return body;
    }
  }
  return body;
}

function splitHeaderBody(s) {
  let idx = s.indexOf('\r\n\r\n');
  let sep = 4;
  if (idx < 0) {
    idx = s.indexOf('\n\n');
    sep = 2;
  }
  if (idx < 0) return { head: s, body: '' };
  return { head: s.slice(0, idx), body: s.slice(idx + sep) };
}

function parseMime(raw) {
  const { head, body } = splitHeaderBody(raw);
  const ctMatch = head.match(/content-type:\s*([^\r\n]+(?:\r?\n[ \t]+[^\r\n]+)*)/i);
  const ct = ctMatch ? ctMatch[1].replace(/\r?\n[ \t]+/g, ' ') : 'text/plain';
  const cte = (head.match(/content-transfer-encoding:\s*([^\r\n]+)/i) || [, ''])[1].trim();
  let text = null;
  let html = null;
  const boundaryMatch = ct.match(/boundary="?([^";\r\n]+)"?/i);
  if (/multipart/i.test(ct) && boundaryMatch) {
    const parts = body.split('--' + boundaryMatch[1]);
    for (const part of parts) {
      const { head: pHead, body: pBody } = splitHeaderBody(part);
      if (!pBody) continue;
      const pct = (pHead.match(/content-type:\s*([^\r\n;]+)/i) || [, ''])[1].toLowerCase();
      const pcte = (pHead.match(/content-transfer-encoding:\s*([^\r\n]+)/i) || [, ''])[1].trim();
      if (pct.includes('text/plain') && text === null) text = decodeCTE(pBody, pcte).trim();
      else if (pct.includes('text/html') && html === null) html = decodeCTE(pBody, pcte).trim();
      else if (pct.includes('multipart')) {
        const nested = parseMime(part);
        if (nested.text && text === null) text = nested.text;
        if (nested.html && html === null) html = nested.html;
      }
    }
  } else {
    const decoded = decodeCTE(body, cte).trim();
    if (/text\/html/i.test(ct)) html = decoded;
    else text = decoded;
  }
  return { text, html };
}

export default {
  async email(message, env, ctx) {
    let parsed = { text: null, html: null };
    try {
      const raw = await new Response(message.raw).text();
      if (raw) parsed = parseMime(raw);
    } catch {
      // parsing failed — still forward + POST metadata below
    }
    const payload = {
      from: message.from,
      to: message.to,
      subject: message.headers.get('subject') || '',
      text: parsed.text,
      html: parsed.html,
      message_id: message.headers.get('message-id') || null,
      in_reply_to: message.headers.get('in-reply-to') || null,
    };
    ctx.waitUntil(
      fetch(WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-inbound-secret': SECRET },
        body: JSON.stringify(payload),
      }).catch(() => {})
    );
    const forwardTo = FORWARD_MAP[(message.to || '').toLowerCase()] || DEFAULT_FORWARD;
    try {
      await message.forward(forwardTo);
    } catch {
      // already captured via webhook; don't reject the message
    }
  },
};
