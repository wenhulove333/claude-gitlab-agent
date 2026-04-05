import { spawn, execSync } from 'child_process';
import { platform } from 'os';
import { ClaudeCLIError } from '../utils/errors.js';
import { logDebug, logError, logInfo } from '../utils/logger.js';
import { getEnv } from '../config/index.js';
import type { ClaudeCLIOptions, ClaudeCLIResult, ClaudePromptOptions } from './types.js';

const DEFAULT_TIMEOUT = 120; // 2 minutes base timeout
const DEFAULT_HEARTBEAT_INTERVAL = 30; // Check every 30 seconds

/**
 * Check if a process and its children are still running
 * Returns: { parentAlive: boolean, childrenAlive: number, totalAlive: number }
 */
/**
 * Cross-platform process status checker
 * Detects if a process and its children are still running
 */
function checkProcessStatus(pid: number): { parentAlive: boolean; childrenAlive: number; totalAlive: number } {
  // Check if parent process is still alive using kill -0 (works on all Unix-like systems)
  let parentAlive = false;
  try {
    process.kill(pid, 0);
    parentAlive = true;
  } catch {
    return { parentAlive: false, childrenAlive: 0, totalAlive: 0 };
  }

  // Count child processes based on platform
  let childrenAlive = 0;
  try {
    const isWindows = platform() === 'win32';

    if (isWindows) {
      // Windows: use wmic
      const result = execSync(
        `wmic process where "ParentProcessId=${pid}" get ProcessId 2>nul`,
        { encoding: 'utf8', timeout: 5000 }
      );
      const lines = result.trim().split('\n').slice(1); // Skip header
      childrenAlive = lines.filter(line => line.trim() && !isNaN(parseInt(line.trim()))).length;
    } else {
      // Unix-like (Linux, macOS): use ps
      const result = execSync(
        `ps -eo pid,ppid 2>/dev/null | grep -v "^\\s*PID" | awk '{print $1, $2}'`,
        { encoding: 'utf8', timeout: 5000 }
      );
      const lines = result.trim().split('\n').filter(line => line.trim());
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const ppid = parseInt(parts[1], 10);
          if (ppid === pid) {
            childrenAlive++;
          }
        }
      }
    }
  } catch {
    // ps/wmic failed, that's okay
  }

  return { parentAlive, childrenAlive, totalAlive: (parentAlive ? 1 : 0) + childrenAlive };
}

export class ClaudeCLI {
  private timeout: number;
  private cliPath: string;
  private heartbeatInterval: number;

  constructor(options: {
    timeout?: number;
    cliPath?: string;
    heartbeatInterval?: number;
  } = {}) {
    const env = getEnv();
    this.timeout = options.timeout ?? env.CLI_TIMEOUT_SECONDS ?? DEFAULT_TIMEOUT;
    this.cliPath = options.cliPath ?? 'claude';
    this.heartbeatInterval = options.heartbeatInterval ?? env.CLI_HEARTBEAT_INTERVAL ?? DEFAULT_HEARTBEAT_INTERVAL;
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
      let heartbeatTimer: NodeJS.Timeout | null = null;
      let completed = false;

      const startTime = Date.now();

      // Heartbeat: log progress periodically
      const checkHeartbeat = () => {
        if (completed) return;
        const totalFor = (Date.now() - startTime) / 1000;

        if (!proc.pid) return;
        const processStatus = checkProcessStatus(proc.pid);

        logInfo(
          {
            event: 'claude_cli_heartbeat',
            totalFor: Math.round(totalFor),
            stdoutLength: stdout.length,
            childProcesses: processStatus.childrenAlive,
          },
          `Claude CLI heartbeat: ${processStatus.childrenAlive > 0 ? `actively working (${processStatus.childrenAlive} children)` : 'idle'}`
        );
      };

      heartbeatTimer = setInterval(checkHeartbeat, this.heartbeatInterval * 1000);

      const cleanup = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };

      // Timeout timer: only triggers when both parent and children are gone
      const timer = setInterval(() => {
        if (completed) {
          clearInterval(timer);
          return;
        }

        const totalFor = (Date.now() - startTime) / 1000;

        // Check if we've exceeded the base timeout
        if (totalFor < timeout) return;

        // Check process status
        if (!proc.pid) return;
        const processStatus = checkProcessStatus(proc.pid);

        // If either parent or children are still running, don't timeout
        if (processStatus.parentAlive || processStatus.childrenAlive > 0) {
          return;
        }

        // Both parent and children are gone, exceeded timeout - trigger timeout
        timedOut = true;
        completed = true;
        cleanup();
        clearInterval(timer);
        proc.kill('SIGTERM');
        logError(
          { event: 'claude_cli_timeout', cwd, args, timeout, totalFor: Math.round(totalFor), stdoutLength: stdout.length },
          `Claude CLI timed out after ${timeout}s in ${cwd}`
        );
      }, 10000); // Check every 10 seconds

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (completed) return;
        completed = true;
        cleanup();
        clearInterval(timer);
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
        clearInterval(timer);
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
