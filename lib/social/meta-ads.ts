import { getMetaCreds } from '@/lib/integrations/meta';

// Meta Marketing API (ads). Separate host-version const from the publishing
// client (v18) — ads endpoints use v19. One job: map our calls to the Graph
// Ads API. No business logic beyond that. Every create* defaults to PAUSED;
// only updateStatus(...,'ACTIVE') can spend money.
const GRAPH = 'https://graph.facebook.com/v19.0';

function actId(adAccountId: string): string {
  const s = String(adAccountId).trim();
  return s.startsWith('act_') ? s : `act_${s}`;
}

// Marketing API is happiest with form-urlencoded bodies where nested params
// (targeting, object_story_spec, special_ad_categories) are JSON-stringified.
function encodeForm(params: Record<string, any>, token: string): URLSearchParams {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  form.set('access_token', token);
  return form;
}

async function graphPost(path: string, token: string, params: Record<string, any>) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm(params, token),
  });
  const json = await res.json();
  if (!res.ok || json?.error) throw new Error(json?.error?.message || `Meta Ads error (${res.status})`);
  return json;
}

async function graphGet(path: string, token: string, query: Record<string, string> = {}) {
  const qs = new URLSearchParams({ ...query, access_token: token });
  const res = await fetch(`${GRAPH}/${path}?${qs.toString()}`);
  const json = await res.json();
  if (!res.ok || json?.error) throw new Error(json?.error?.message || `Meta Ads error (${res.status})`);
  return json;
}

async function tokenFor(accountId: string): Promise<string> {
  const { token } = await getMetaCreds(accountId);
  if (!token) throw new Error('Meta not connected — connect a Meta ad account in Settings first');
  return token;
}

export interface AdAccount { id: string; name: string; account_status: number; }

/** List the connected user's ad accounts (id is `act_<id>`). */
export async function listAdAccounts(accountId: string): Promise<AdAccount[]> {
  const token = await tokenFor(accountId);
  const json = await graphGet('me/adaccounts', token, { fields: 'name,account_status', limit: '100' });
  return (json.data || []).map((a: any) => ({ id: a.id, name: a.name, account_status: a.account_status }));
}

/** Create a campaign — ALWAYS PAUSED. objective e.g. OUTCOME_TRAFFIC. */
export async function createCampaign(
  accountId: string,
  adAccountId: string,
  opts: { name: string; objective: string; status?: 'PAUSED' | 'ACTIVE' },
): Promise<{ id: string }> {
  const token = await tokenFor(accountId);
  return graphPost(`${actId(adAccountId)}/campaigns`, token, {
    name: opts.name,
    objective: opts.objective,
    status: opts.status ?? 'PAUSED',
    special_ad_categories: [],
  });
}

/** Create an ad set under a campaign — PAUSED. daily budget in minor units (cents). */
export async function createAdSet(
  accountId: string,
  adAccountId: string,
  opts: {
    campaignId: string;
    name: string;
    dailyBudgetCents: number;
    optimizationGoal?: string;
    billingEvent?: string;
    targeting?: Record<string, any>;
    status?: 'PAUSED' | 'ACTIVE';
  },
): Promise<{ id: string }> {
  const token = await tokenFor(accountId);
  return graphPost(`${actId(adAccountId)}/adsets`, token, {
    name: opts.name,
    campaign_id: opts.campaignId,
    daily_budget: Math.round(opts.dailyBudgetCents),
    optimization_goal: opts.optimizationGoal ?? 'LINK_CLICKS',
    billing_event: opts.billingEvent ?? 'IMPRESSIONS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    targeting: opts.targeting ?? { geo_locations: { countries: ['US'] } },
    status: opts.status ?? 'PAUSED',
  });
}

/** Upload an image (raw bytes) → returns Meta image hash. */
export async function uploadAdImage(
  accountId: string,
  adAccountId: string,
  bytes: Uint8Array | Buffer,
  filename = 'asset.jpg',
): Promise<{ hash: string }> {
  const token = await tokenFor(accountId);
  const b64 = Buffer.from(bytes).toString('base64');
  const json = await graphPost(`${actId(adAccountId)}/adimages`, token, { bytes: b64 });
  // Response shape: { images: { <filename>: { hash, ... } } }
  const images = json.images || {};
  const first = Object.values(images)[0] as any;
  if (!first?.hash) throw new Error('Meta did not return an image hash');
  return { hash: String(first.hash) };
}

/** Register a video by URL → returns Meta video id. */
export async function uploadAdVideo(
  accountId: string,
  adAccountId: string,
  fileUrl: string,
): Promise<{ videoId: string }> {
  const token = await tokenFor(accountId);
  const json = await graphPost(`${actId(adAccountId)}/advideos`, token, { file_url: fileUrl });
  if (!json?.id) throw new Error('Meta did not return a video id');
  return { videoId: String(json.id) };
}

/** Create a creative from an uploaded image hash or video id. */
export async function createAdCreative(
  accountId: string,
  adAccountId: string,
  opts: { name: string; pageId: string; message: string; link: string; imageHash?: string; videoId?: string },
): Promise<{ id: string }> {
  const token = await tokenFor(accountId);
  const object_story_spec: Record<string, any> = { page_id: opts.pageId };
  if (opts.videoId) {
    object_story_spec.video_data = { video_id: opts.videoId, message: opts.message, call_to_action: { type: 'LEARN_MORE', value: { link: opts.link } } };
  } else if (opts.imageHash) {
    object_story_spec.link_data = { image_hash: opts.imageHash, message: opts.message, link: opts.link };
  } else {
    throw new Error('createAdCreative requires imageHash or videoId');
  }
  return graphPost(`${actId(adAccountId)}/adcreatives`, token, { name: opts.name, object_story_spec });
}

/** Create an ad — PAUSED. */
export async function createAd(
  accountId: string,
  adAccountId: string,
  opts: { name: string; adsetId: string; creativeId: string; status?: 'PAUSED' | 'ACTIVE' },
): Promise<{ id: string }> {
  const token = await tokenFor(accountId);
  return graphPost(`${actId(adAccountId)}/ads`, token, {
    name: opts.name,
    adset_id: opts.adsetId,
    creative: { creative_id: opts.creativeId },
    status: opts.status ?? 'PAUSED',
  });
}

/** The ONLY path that spends money. */
export async function updateStatus(
  accountId: string,
  objectId: string,
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED',
): Promise<{ success: true }> {
  const token = await tokenFor(accountId);
  await graphPost(objectId, token, { status });
  return { success: true };
}

export interface AdInsights { spend: number; impressions: number; clicks: number; cpc: number; cpm: number; ctr: number; }

/** Pull live insights for a campaign/adset/ad object. Returns zeros when empty. */
export async function getInsights(accountId: string, objectId: string): Promise<AdInsights> {
  const token = await tokenFor(accountId);
  const json = await graphGet(`${objectId}/insights`, token, { fields: 'spend,impressions,clicks,cpc,cpm,ctr' });
  const row = (json.data && json.data[0]) || {};
  const num = (v: any) => (v == null ? 0 : Number(v) || 0);
  return {
    spend: num(row.spend), impressions: num(row.impressions), clicks: num(row.clicks),
    cpc: num(row.cpc), cpm: num(row.cpm), ctr: num(row.ctr),
  };
}
