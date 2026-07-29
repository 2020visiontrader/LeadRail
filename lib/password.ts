import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(pw: string, stored?: string | null): boolean {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  const test = scryptSync(pw, salt, 64);
  const orig = Buffer.from(hash, 'hex');
  return test.length === orig.length && timingSafeEqual(test, orig);
}
