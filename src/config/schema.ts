import { z } from 'zod';

export const envSchema = z.object({
  // Server configuration
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // GitLab configuration
  GITLAB_URL: z.string().url().default('https://gitlab.com'),
  GITLAB_ACCESS_TOKEN: z.string().min(1),

  // Claude configuration
  ANTHROPIC_API_KEY: z.string().min(1),

  // Security configuration
  WEBHOOK_SECRET: z.string().optional(),

  // Workspace configuration
  WORKSPACE_ROOT: z.string().default('/data/workspaces'),
  WORKSPACE_TTL_HOURS: z.coerce.number().default(24),
  MAX_WORKSPACES: z.coerce.number().default(50),

  // Redis configuration
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Claude CLI configuration
  CLI_TIMEOUT_SECONDS: z.coerce.number().default(120),
  CLI_HEARTBEAT_INTERVAL: z.coerce.number().default(30),
  USE_DOCKER_ISOLATION: z.coerce.boolean().default(false),

  // Bot configuration
  BOT_NAME: z.string().default('Claude'),
  BOT_USERNAME: z.string().default('claude-bot'),
});

export type Env = z.infer<typeof envSchema>;
