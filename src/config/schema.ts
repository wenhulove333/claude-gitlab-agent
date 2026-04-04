import { z } from 'zod';

export const envSchema = z.object({
  // 服务配置
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // GitLab 配置
  GITLAB_URL: z.string().url().default('https://gitlab.com'),
  GITLAB_ACCESS_TOKEN: z.string().min(1),

  // Claude 配置
  ANTHROPIC_API_KEY: z.string().min(1),

  // 安全配置
  WEBHOOK_SECRET: z.string().optional(),

  // 工作空间配置
  WORKSPACE_ROOT: z.string().default('/data/workspaces'),
  WORKSPACE_TTL_HOURS: z.coerce.number().default(24),
  MAX_WORKSPACES: z.coerce.number().default(50),

  // Redis 配置
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Claude CLI 配置
  CLI_TIMEOUT_SECONDS: z.coerce.number().default(300),
  USE_DOCKER_ISOLATION: z.coerce.boolean().default(false),
});

export type Env = z.infer<typeof envSchema>;
