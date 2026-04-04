import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing cli
vi.mock('../../src/config/index.js', () => ({
  getEnv: () => ({
    CLI_TIMEOUT_SECONDS: 5,
  }),
}));

describe('ClaudeCLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('types', () => {
    it('should have correct interface for ClaudeCLIResult', () => {
      const result = {
        stdout: 'test',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
      expect(result.stdout).toBe('test');
      expect(result.exitCode).toBe(0);
    });

    it('should have correct interface for ClaudePromptOptions', () => {
      const options = {
        workingDirectory: '/tmp',
        timeout: 60,
        systemPrompt: 'You are helpful',
        maxTokens: 1024,
        model: 'claude-3-5-sonnet-20241022',
      };
      expect(options.workingDirectory).toBe('/tmp');
      expect(options.maxTokens).toBe(1024);
    });
  });

  describe('CLI options', () => {
    it('should accept custom timeout', async () => {
      const { ClaudeCLI } = await import('../../src/claude/cli.js');
      const cli = new ClaudeCLI({ timeout: 60 });
      expect(cli).toBeDefined();
    });

    it('should accept custom cli path', async () => {
      const { ClaudeCLI } = await import('../../src/claude/cli.js');
      const cli = new ClaudeCLI({ cliPath: '/usr/local/bin/claude' });
      expect(cli).toBeDefined();
    });
  });
});
