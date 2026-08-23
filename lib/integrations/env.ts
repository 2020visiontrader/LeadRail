export interface RequiredEnv {
  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
}

export interface OptionalEnv {
  SUPABASE_SERVICE_ROLE_KEY?: string;
  APOLLO_API_KEY?: string;
  LEADRAIL_RESEND_API_KEY?: string;
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  BREVO_API_KEY?: string;
  POSTIZ_API_KEY?: string;
  META_ACCESS_TOKEN?: string;
  NIM_API_KEY?: string;
  OPENCODE_API_KEY?: string;
  TAVILY_API_KEY?: string;
  EXA_API_KEY?: string;
  SERPAPI_KEY?: string;
  /** RapidAPI, account-wide. One key spans every API on the marketplace, but
   *  each API needs its OWN subscription — an unsubscribed call returns 403
   *  "You are not subscribed to this API", not 401, so a valid key that has
   *  simply not been subscribed looks like a broken key unless you read the
   *  body. Used for Maps Data (business discovery) and the Facebook Ad Library. */
  RAPIDAPI_KEY?: string;
}

export function validateEnv(): RequiredEnv & OptionalEnv {
  const required: (keyof RequiredEnv)[] = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  ];

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const optional: (keyof OptionalEnv)[] = [
    'SUPABASE_SERVICE_ROLE_KEY',
    'BREVO_API_KEY',
    'POSTIZ_API_KEY',
    'META_ACCESS_TOKEN',
    'NIM_API_KEY',
    'OPENCODE_API_KEY',
    'TAVILY_API_KEY',
    'EXA_API_KEY',
    'SERPAPI_KEY',
    'RAPIDAPI_KEY',
  ];

  const env: RequiredEnv & OptionalEnv = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  };

  optional.forEach((key) => {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  });

  return env;
}

export function getIntegrationStatus() {
  const status: Record<string, boolean> = {
    supabase: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    apollo: !!(process.env.APOLLO_API_KEY || process.env.Apollo_Api_Key || process.env.APOLLO_KEY),
    gemini: !!(process.env.GEMINI_API_KEY || process.env.Gemini_api_key || process.env.GOOGLE_API_KEY),
    opencode: !!(process.env.OPENCODE_API_KEY || process.env.OpenCode_Api_Key || process.env.OPENCODE_GO_API_KEY),
    brevo: !!process.env.BREVO_API_KEY,
    resend: !!process.env.LEADRAIL_RESEND_API_KEY,
    postiz: !!process.env.POSTIZ_API_KEY,
    meta: !!process.env.META_ACCESS_TOKEN,
    google_ads: !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    nim: !!process.env.NIM_API_KEY,
    notion: !!(process.env.NOTION_API_KEY || process.env.NOTION_TOKEN),
    google_drive: !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_DRIVE_ACCESS_TOKEN),
    // DuckDuckGo needs no key and is always available as a thin-coverage
    // floor (see lib/integrations/websearch.ts), so this flag intentionally
    // tracks only the keyed, full-coverage providers — it answers "is a real
    // SERP configured", not "will webSearch return anything at all".
    web_search: !!(process.env.TAVILY_API_KEY || process.env.EXA_API_KEY || process.env.SERPAPI_KEY),
  };

  return status;
}