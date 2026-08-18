// ---------------------------------------------------------------------------
// Structured application logger.
//
// Two sinks, always best-effort (logging never throws into the request path):
//   1. Console — one JSON line per event. Captured by the container's stdout →
//      Loki, so it is greppable in real time.
//   2. app_logs table — durable, queryable history. Only 'warn'/'error' rows and
//      request-completion 'info' rows are persisted, so the table stays lean.
//
// Per-request context (request_id, route, method, actor, account) is carried in
// an AsyncLocalStorage store set up by withApi() in lib/http.ts. Any call to
// log.* automatically inherits that context — individual routes never thread it.
// ---------------------------------------------------------------------------
import { AsyncLocalStorage } from 'node:async_hooks';
import { supabase, dbReady } from '@/lib/db';

export type LogLevel = 'info' | 'warn' | 'error';

export interface RequestContext {
  requestId: string;
  route?: string;
  method?: string;
  status?: number;
  durationMs?: number;
  accountId?: string | null;
  actorEmail?: string | null;
}

export const requestStore = new AsyncLocalStorage<RequestContext>();

/** Read the current request's context, if any handler is on the stack. */
export function currentContext(): RequestContext | undefined {
  return requestStore.getStore();
}

/** Enrich the active request context (e.g. once the session is known). */
export function enrichContext(patch: Partial<RequestContext>): void {
  const store = requestStore.getStore();
  if (store) Object.assign(store, patch);
}

interface LogFields {
  message?: string;
  detail?: Record<string, unknown> | null;
  // Explicit overrides; default to the active request context.
  route?: string;
  method?: string;
  status?: number;
  durationMs?: number;
  accountId?: string | null;
  actorEmail?: string | null;
  requestId?: string;
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack?.split('\n').slice(0, 8).join('\n') };
  }
  if (err && typeof err === 'object') {
    try {
      return JSON.parse(JSON.stringify(err));
    } catch {
      return { value: String(err) };
    }
  }
  return { value: String(err) };
}

async function persist(level: LogLevel, ctx: RequestContext | undefined, fields: LogFields): Promise<void> {
  if (!dbReady()) return;
  try {
    await supabase.from('app_logs').insert([
      {
        request_id: fields.requestId ?? ctx?.requestId ?? null,
        level,
        route: fields.route ?? ctx?.route ?? null,
        method: fields.method ?? ctx?.method ?? null,
        status: fields.status ?? ctx?.status ?? null,
        duration_ms: fields.durationMs ?? ctx?.durationMs ?? null,
        account_id: fields.accountId ?? ctx?.accountId ?? null,
        actor_email: fields.actorEmail ?? ctx?.actorEmail ?? null,
        message: fields.message ?? null,
        detail: fields.detail ?? null,
      },
    ]);
  } catch (e: any) {
    // Never let the logging sink break the caller; surface only on console.
    console.error('[logger:persist-failed]', e?.message || e);
  }
}

function emit(level: LogLevel, fields: LogFields, opts: { persist: boolean }): void {
  const ctx = requestStore.getStore();
  const line = {
    t: new Date().toISOString(),
    level,
    request_id: fields.requestId ?? ctx?.requestId,
    route: fields.route ?? ctx?.route,
    method: fields.method ?? ctx?.method,
    status: fields.status ?? ctx?.status,
    duration_ms: fields.durationMs ?? ctx?.durationMs,
    account_id: fields.accountId ?? ctx?.accountId,
    actor: fields.actorEmail ?? ctx?.actorEmail,
    msg: fields.message,
    ...(fields.detail ? { detail: fields.detail } : {}),
  };
  const serialized = JSON.stringify(line);
  if (level === 'error') console.error(serialized);
  else if (level === 'warn') console.warn(serialized);
  else console.log(serialized);

  if (opts.persist) {
    // Fire-and-forget; persist() swallows its own errors.
    void persist(level, ctx, fields);
  }
}

export const log = {
  /** Ephemeral info — console only, not persisted (keeps app_logs lean). */
  info(message: string, detail?: Record<string, unknown>): void {
    emit('info', { message, detail }, { persist: false });
  },
  /** Request-completion line — console + persisted so success/latency is queryable.
   *
   *  `level` defaults to 'info' but callers should derive it from the HTTP
   *  status. Every request line used to be logged as info regardless of outcome,
   *  which made the Error and Warn filters on /logs permanently empty: a run of
   *  rejected Meta webhooks showed as "0 errors, 0 warns" while real inbound
   *  events were being dropped. A filter that cannot go non-zero is worse than
   *  no filter — it actively reassures. */
  request(fields: LogFields, level: LogLevel = 'info'): void {
    emit(level, fields, { persist: true });
  },
  warn(message: string, detail?: Record<string, unknown>): void {
    emit('warn', { message, detail }, { persist: true });
  },
  error(message: string, err?: unknown, extra?: Record<string, unknown>): void {
    emit('error', { message, detail: { ...(err !== undefined ? serializeError(err) : {}), ...extra } }, { persist: true });
  },
};
