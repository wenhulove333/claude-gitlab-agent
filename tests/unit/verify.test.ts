import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { verifyGitLabWebhook, verifyGitLabToken } from '../../src/webhook/verify.js';

describe('Webhook Verification', () => {
  const secret = 'test-secret';

  describe('verifyGitLabWebhook', () => {
    it('should return true when no secret configured', () => {
      const result = verifyGitLabWebhook('payload', 'signature', {});
      expect(result).toBe(true);
    });

    it('should verify token correctly', () => {
      const token = 'my-token';
      const result = verifyGitLabWebhook('payload', token, { token });
      expect(result).toBe(true);
    });

    it('should throw on invalid token', () => {
      expect(() => {
        verifyGitLabWebhook('payload', 'wrong-token', { token: 'correct-token' });
      }).toThrow('Webhook signature verification failed');
    });

    it('should verify sha256 signature correctly', () => {
      const payload = '{"test": "data"}';
      const signature = createHmac('sha256', secret)
        .update(payload, 'utf8')
        .digest('hex');

      const result = verifyGitLabWebhook(payload, `sha256=${signature}`, { secret });
      expect(result).toBe(true);
    });

    it('should throw on invalid signature', () => {
      expect(() => {
        verifyGitLabWebhook('payload', 'sha256=invalid', { secret });
      }).toThrow('Webhook signature verification failed');
    });
  });

  describe('verifyGitLabToken', () => {
    it('should return true for matching tokens', () => {
      const result = verifyGitLabToken('my-token', 'my-token');
      expect(result).toBe(true);
    });

    it('should return false for non-matching tokens', () => {
      const result = verifyGitLabToken('wrong', 'correct');
      expect(result).toBe(false);
    });

    it('should return false for null token', () => {
      const result = verifyGitLabToken(null as unknown as string, 'correct');
      expect(result).toBe(false);
    });
  });
});
