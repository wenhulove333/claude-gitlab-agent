export interface ClaudeCLIOptions {
  /** Working directory for the command */
  workingDirectory?: string;
  /** Timeout in seconds */
  timeout?: number;
  /** Environment variables */
  env?: Record<string, string>;
}

export interface ClaudeCLIResult {
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Exit code */
  exitCode: number;
  /** Whether it was killed due to timeout */
  timedOut: boolean;
}

export interface ClaudePromptOptions extends ClaudeCLIOptions {
  /** System prompt to use */
  systemPrompt?: string;
  /** Max tokens to generate */
  maxTokens?: number;
  /** Model to use */
  model?: string;
}
