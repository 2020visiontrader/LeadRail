import { SEGMENTS, Segment, CONTACT_STATUSES } from '@/lib/types';

export interface ValidationResult<T> {
  ok: boolean;
  errors: string[];
  value: T;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Whitelist + validate a contact payload for insert. Strips unknown keys (blocks mass-assignment). */
export function validateContactInput(body: any): ValidationResult<Record<string, any>> {
  const errors: string[] = [];
  const value: Record<string, any> = {};

  if (!body || typeof body !== 'object') {
    return { ok: false, errors: ['body must be a JSON object'], value };
  }
  if (typeof body.brand_id !== 'string' || !body.brand_id.trim()) errors.push('brand_id is required');
  else value.brand_id = body.brand_id.trim();

  if (typeof body.name !== 'string' || !body.name.trim()) errors.push('name is required');
  else value.name = body.name.trim();

  if (typeof body.email !== 'string' || !EMAIL_RE.test(body.email)) errors.push('valid email is required');
  else value.email = body.email.trim().toLowerCase();

  if (body.company != null) value.company = String(body.company);
  if (body.title != null) value.title = String(body.title);
  if (body.notes != null) value.notes = String(body.notes);
  if (body.custom_fields != null) {
    if (typeof body.custom_fields !== 'object' || Array.isArray(body.custom_fields)) errors.push('custom_fields must be an object');
    else value.custom_fields = body.custom_fields;
  }

  if (body.segment != null) {
    if (!SEGMENTS.includes(body.segment as Segment)) errors.push(`segment must be one of: ${SEGMENTS.join(', ')}`);
    else value.segment = body.segment;
  }
  if (body.status != null) {
    if (!CONTACT_STATUSES.includes(body.status)) errors.push('invalid status');
    else value.status = body.status;
  }
  if (body.score != null) {
    const n = Number(body.score);
    if (!Number.isFinite(n)) errors.push('score must be a number');
    else value.score = Math.round(n);
  }
  return { ok: errors.length === 0, errors, value };
}

/** Whitelist for contact updates (all optional; ignores id/brand_id/timestamps). */
export function validateContactPatch(body: any): ValidationResult<Record<string, any>> {
  const errors: string[] = [];
  const value: Record<string, any> = {};
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be a JSON object'], value };

  const passthrough = ['name', 'email', 'company', 'title', 'notes'];
  for (const k of passthrough) if (body[k] != null) value[k] = String(body[k]);
  if (value.email && !EMAIL_RE.test(value.email)) errors.push('invalid email');
  if (body.custom_fields != null) {
    if (typeof body.custom_fields !== 'object' || Array.isArray(body.custom_fields)) errors.push('custom_fields must be an object');
    else value.custom_fields = body.custom_fields;
  }
  if (body.segment != null) {
    if (!SEGMENTS.includes(body.segment as Segment)) errors.push('invalid segment');
    else value.segment = body.segment;
  }
  if (body.status != null) {
    if (!CONTACT_STATUSES.includes(body.status)) errors.push('invalid status');
    else value.status = body.status;
  }
  if (body.score != null) {
    const n = Number(body.score);
    if (!Number.isFinite(n)) errors.push('score must be a number');
    else value.score = Math.round(n);
  }
  return { ok: errors.length === 0, errors, value };
}
