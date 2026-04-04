import { spawn } from 'child_process';
import { ClaudeCLIError } from '../utils/errors.js';
import { logDebug, logError } from '../utils/logger.js';
import { getEnv } from '../config/index.js';
import type { ClaudeCLIOptions, ClaudeCLIResult, ClaudePromptOptions } from './types.js';

const DEFAULT_TIMEOUT = 300; // 5 minutes

export class ClaudeCLI {
  private timeout: number;
  private cliPath: string;

  constructor(options: { timeout?: number; cliPath?: string } = {}) {
    const env = getEnv();
    this.timeout = options.timeout ?? env.CLI_TIMEOUT_SECONDS ?? DEFAULT_TIMEOUT;
    this.cliPath = options.cliPath ?? 'claude';
  }

  /**
   * Execute a Claude CLI command with arguments
   */
  async execute(
    args: string[],
    options: ClaudeCLIOptions = {}
  ): Promise<ClaudeCLIResult> {
    const {
      workingDirectory,
      timeout = this.timeout,
      env: extraEnv,
    } = options;

    const cwd = workingDirectory ?? process.cwd();

    logDebug(
      {
        event: 'claude_cli_execute',
        args,
        cwd,
        timeout,
      },
      `Executing Claude CLI: ${args.join(' ')}`
    );

    return new Promise((resolve) => {
      const env = {
        ...process.env,
        ...extraEnv,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      };

      const proc = spawn(this.cliPath, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        logError(
          { event: 'claude_cli_timeout', args, timeout },
          `Claude CLI timed out after ${timeout}s`
        );
      }, timeout * 1000);

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        const exitCode = code ?? 0;

        logDebug(
          {
            event: 'claude_cli_completed',
            args,
            exitCode,
            timedOut,
            stdoutLength: stdout.length,
          },
          `Claude CLI completed with exit code ${exitCode}`
        );

        resolve({
          stdout,
          stderr,
          exitCode,
          timedOut,
        });
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        logError(
          { event: 'claude_cli_error', args, error: error.message },
          `Claude CLI error: ${error.message}`
        );
        resolve({
          stdout: '',
          stderr: error.message,
          exitCode: -1,
          timedOut: false,
        });
      });
    });
  }

  /**
   * Send a prompt and get the response using --print flag
   */
  async prompt(prompt: string, options: ClaudePromptOptions = {}): Promise<string> {
    const {
      workingDirectory,
      systemPrompt,
      maxTokens,
      model,
      timeout,
      env,
    } = options;

    const args = ['--print'];

    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    if (maxTokens) {
      args.push('--max-tokens', String(maxTokens));
    }

    if (model) {
      args.push('--model', model);
    }

    args.push('--', prompt);

    const result = await this.execute(args, {
      workingDirectory,
      timeout,
      env,
    });

    if (result.timedOut) {
      throw new ClaudeCLIError('Claude CLI timed out', 124);
    }

    if (result.exitCode !== 0) {
      throw new ClaudeCLIError(
        `Claude CLI failed: ${result.stderr || result.stdout}`,
        result.exitCode
      );
    }

    return result.stdout.trim();
  }

  /**
   * Check if Claude CLI is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.execute(['--version'], { timeout: 5 });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Get Claude CLI version
   */
  async getVersion(): Promise<string | null> {
    try {
      const result = await this.execute(['--version'], { timeout: 5 });
      if (result.exitCode === 0) {
        return result.stdout.trim();
      }
      return null;
    } catch {
      return null;
    }
  }
}

// Singleton instance
let cliInstance: ClaudeCLI | null = null;

export function getClaudeCLI(): ClaudeCLI {
  if (!cliInstance) {
    cliInstance = new ClaudeCLI();
  }
  return cliInstance;
}
