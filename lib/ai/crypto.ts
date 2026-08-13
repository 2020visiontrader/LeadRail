// AES-256-GCM encrypt/decrypt for provider API keys (lib/ai/providers.ts).
// Node's built-in crypto only — no new dependency. Fails SAFE: if AI_VAULT_KEY
// is unset, encrypt() throws rather than silently storing plaintext, and
// decrypt() throws rather than returning a garbage/plaintext-looking key. A
// key is NEVER logged — callers must not include it in error messages either.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // 96-bit nonce, the GCM standard
const TAG_LEN = 16;

function vaultKey(): Buffer | null {
  const secret = process.env.AI_VAULT_KEY;
  if (!secret) return null;
  // Accept any length secret; derive a fixed 32-byte key so ops can rotate the
  // env value without worrying about exact byte length.
  return createHash('sha256').update(secret).digest();
}

export function vaultConfigured(): boolean {
  return vaultKey() !== null;
}

/**
 * Encrypt a plaintext API key. Output is a single base64url string encoding
 * [iv][authTag][ciphertext] so it fits in one TEXT column. Throws if
 * AI_VAULT_KEY is not set — callers must treat that as "cannot store keys",
 * never fall back to storing plaintext.
 */
export function encryptSecret(plaintext: string): string {
  const key = vaultKey();
  if (!key) {
    const err: any = new Error('AI_VAULT_KEY is not configured; cannot store provider keys');
    err.code = 'vault_not_configured';
    throw err;
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

/**
 * Decrypt a value produced by encryptSecret. Throws (never returns partial or
 * garbage data) on a missing vault key, malformed payload, or failed auth tag
 * check (tampering / wrong key).
 */
export function decryptSecret(encoded: string): string {
  const key = vaultKey();
  if (!key) {
    const err: any = new Error('AI_VAULT_KEY is not configured; cannot read provider keys');
    err.code = 'vault_not_configured';
    throw err;
  }
  const raw = Buffer.from(encoded, 'base64url');
  if (raw.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('Malformed encrypted secret');
  }
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/** Mask a secret for display: keep a short prefix, redact the rest. Never
 * returns enough of the key to be useful, even for a short key. */
export function maskSecret(plaintext: string): string {
  if (!plaintext) return '';
  const prefix = plaintext.slice(0, Math.min(4, Math.max(0, plaintext.length - 4)));
  return `${prefix}${'•'.repeat(8)}`;
}
