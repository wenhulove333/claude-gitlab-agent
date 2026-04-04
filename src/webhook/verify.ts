import { createHmac } from 'crypto';
import { WebhookVerificationError } from '../utils/errors.js';

export interface VerifyOptions {
  secret?: string;
  token?: string;
}

export function verifyGitLabWebhook(
  payload: string,
  signature: string | null,
  gitlabToken: string | null,
  options: VerifyOptions
): boolean {
  const { secret, token } = options;

  // If no secret/token configured, skip verification (not recommended for production)
  if (!secret && !token) {
    return true;
  }

  // Check X-Gitlab-Token header (token comparison)
  if (gitlabToken && token) {
    if (timingSafeEqual(gitlabToken, token)) {
      return true;
    }
  }

  // Check X-Hub-Signature-256 header (HMAC verification)
  if (secret && signature && signature.startsWith('sha256=')) {
    const expectedSignature = createHmac('sha256', secret)
      .update(payload, 'utf8')
      .digest('hex');
    const providedSignature = signature.slice(7); // Remove 'sha256=' prefix

    if (timingSafeEqual(expectedSignature, providedSignature)) {
      return true;
    }
  }

  throw new WebhookVerificationError('Webhook signature verification failed');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function verifyGitLabToken(providedToken: string | null, expectedToken: string): boolean {
  if (!providedToken) {
    return false;
  }

  return timingSafeEqual(providedToken, expectedToken);
}
