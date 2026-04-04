import { spawn } from 'child_process';
import { ClaudeCLIError } from '../utils/errors.js';
import { logDebug, logError, logInfo } from '../utils/logger.js';
import { getEnv } from '../config/index.js';
import type { ClaudeCLIOptions, ClaudeCLIResult, ClaudePromptOptions } from './types.js';

const DEFAULT_TIMEOUT = 300; // 5 minutes
const DEFAULT_HEARTBEAT_INTERVAL = 30; // 30 seconds of no output = might be stuck
const DEFAULT_QUIET_TIMEOUT = 60; // 60 seconds of no output = definitely stuck

export class ClaudeCLI {
  private timeout: number;
  private cliPath: string;
  private heartbeatInterval: number;
  private quietTimeout: number;

  constructor(options: { timeout?: number; cliPath?: string; heartbeatInterval?: number; quietTimeout?: number } = {}) {
    const env = getEnv();
    this.timeout = options.timeout ?? env.CLI_TIMEOUT_SECONDS ?? DEFAULT_TIMEOUT;
    this.cliPath = options.cliPath ?? 'claude';
    this.heartbeatInterval = options.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL;
    this.quietTimeout = options.quietTimeout ?? DEFAULT_QUIET_TIMEOUT;
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
      `Executing Claude CLI: claude ${args.join(' ')}`
    );

    // Also log as info for easy debugging
    logInfo(
      { event: 'claude_command', cwd, command: `claude ${args.join(' ')}` },
      `Running: claude ${args.join(' ')} in ${cwd}`
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

      // Immediately close stdin to prevent hanging
      proc.stdin?.end();

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let lastOutputTime = Date.now();
      let heartbeatTimer: NodeJS.Timeout | null = null;
      let completed = false;

      // Heartbeat: log progress if no output for a while
      const startTime = Date.now();
      const checkHeartbeat = () => {
        if (completed) return;
        const quietFor = (Date.now() - lastOutputTime) / 1000;
        const totalFor = (Date.now() - startTime) / 1000;
        if (quietFor >= this.quietTimeout) {
          logInfo(
            { event: 'claude_cli_heartbeat', quietFor: Math.round(quietFor), totalFor: Math.round(totalFor), stdoutLength: stdout.length },
            `Claude CLI is still working... (quiet for ${Math.round(quietFor)}s, total ${Math.round(totalFor)}s)`
          );
        }
      };

      heartbeatTimer = setInterval(checkHeartbeat, this.heartbeatInterval * 1000);

      const cleanup = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        completed = true;
        cleanup();
        proc.kill('SIGTERM');
        logError(
          { event: 'claude_cli_timeout', cwd, args, timeout, stdoutLength: stdout.length },
          `Claude CLI timed out after ${timeout}s in ${cwd}: claude ${args.join(' ')}`
        );
      }, timeout * 1000);

      proc.stdout?.on('data', (data) => {
        lastOutputTime = Date.now();
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        lastOutputTime = Date.now();
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (completed) return;
        completed = true;
        cleanup();
        clearTimeout(timer);
        const exitCode = code ?? 0;
        const totalFor = (Date.now() - startTime) / 1000;

        logDebug(
          {
            event: 'claude_cli_completed',
            args,
            exitCode,
            timedOut,
            stdoutLength: stdout.length,
            totalFor: Math.round(totalFor),
          },
          `Claude CLI completed with exit code ${exitCode} after ${Math.round(totalFor)}s`
        );

        resolve({
          stdout,
          stderr,
          exitCode,
          timedOut,
        });
      });

      proc.on('error', (error) => {
        if (completed) return;
        completed = true;
        cleanup();
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

    const args = ['--print', '--dangerously-skip-permissions'];

    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    if (maxTokens) {
      args.push('--max-tokens', String(maxTokens));
    }

    if (model) {
      args.push('--model', model);
    }

    args.push('--', prompt); // Use -- to separate flags from prompt

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
