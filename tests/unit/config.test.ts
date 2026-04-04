import { describe, it, expect, vi, beforeEach } from 'vitest';
import { envSchema } from '../../src/config/schema.js';

describe('Config Schema', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should validate correct environment variables', () => {
    const env = {
      GITLAB_URL: 'https://gitlab.com',
      GITLAB_ACCESS_TOKEN: 'test-token',
      ANTHROPIC_API_KEY: 'sk-test',
    };

    const result = envSchema.safeParse(env);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.GITLAB_URL).toBe('https://gitlab.com');
      expect(result.data.GITLAB_ACCESS_TOKEN).toBe('test-token');
      expect(result.data.PORT).toBe(3000); // default
      expect(result.data.NODE_ENV).toBe('development'); // default
    }
  });

  it('should fail when required variables missing', () => {
    const env = {
      PORT: '3000',
    };

    const result = envSchema.safeParse(env);
    expect(result.success).toBe(false);
  });

  it('should coerce string to number for port', () => {
    const env = {
      GITLAB_URL: 'https://gitlab.com',
      GITLAB_ACCESS_TOKEN: 'test-token',
      ANTHROPIC_API_KEY: 'sk-test',
      PORT: '8080',
    };

    const result = envSchema.safeParse(env);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.PORT).toBe(8080);
    }
  });

  it('should coerce string to boolean for USE_DOCKER_ISOLATION', () => {
    const env = {
      GITLAB_URL: 'https://gitlab.com',
      GITLAB_ACCESS_TOKEN: 'test-token',
      ANTHROPIC_API_KEY: 'sk-test',
      USE_DOCKER_ISOLATION: 'true',
    };

    const result = envSchema.safeParse(env);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.USE_DOCKER_ISOLATION).toBe(true);
    }
  });

  it('should reject invalid NODE_ENV', () => {
    const env = {
      GITLAB_URL: 'https://gitlab.com',
      GITLAB_ACCESS_TOKEN: 'test-token',
      ANTHROPIC_API_KEY: 'sk-test',
      NODE_ENV: 'invalid',
    };

    const result = envSchema.safeParse(env);
    expect(result.success).toBe(false);
  });

  it('should use default values', () => {
    const env = {
      GITLAB_URL: 'https://gitlab.com',
      GITLAB_ACCESS_TOKEN: 'test-token',
      ANTHROPIC_API_KEY: 'sk-test',
    };

    const result = envSchema.safeParse(env);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.WORKSPACE_ROOT).toBe('/data/workspaces');
      expect(result.data.WORKSPACE_TTL_HOURS).toBe(24);
      expect(result.data.MAX_WORKSPACES).toBe(50);
      expect(result.data.REDIS_URL).toBe('redis://localhost:6379');
      expect(result.data.CLI_TIMEOUT_SECONDS).toBe(300);
      expect(result.data.USE_DOCKER_ISOLATION).toBe(false);
    }
  });
});
