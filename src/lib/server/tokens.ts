import { createHash, randomBytes } from 'node:crypto';

/** Token de webhook: se muestra UNA vez; en la base solo queda su hash SHA-256. */
export function generateWebhookToken(): { token: string; hash: string; hint: string } {
  const token = `cfw_${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token), hint: token.slice(-4) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
