export interface RequiredEnv {
  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
}

export interface OptionalEnv {
  SUPABASE_SERVICE_ROLE_KEY?: string;
  BREVO_API_KEY?: string;
  POSTIZ_API_KEY?: string;
  META_ACCESS_TOKEN?: string;
  NIM_API_KEY?: string;
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
    brevo: !!process.env.BREVO_API_KEY,
    postiz: !!process.env.POSTIZ_API_KEY,
    meta: !!process.env.META_ACCESS_TOKEN,
    nim: !!process.env.NIM_API_KEY,
  };

  return status;
}