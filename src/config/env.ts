import { envSchema, type Env } from './schema.js';

let cachedConfig: Env | null = null;

export function getConfig(): Env {
  if (cachedConfig) return cachedConfig;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.format();
    throw new Error(`Invalid environment variables:\n${JSON.stringify(errors, null, 2)}`);
  }

  cachedConfig = result.data;
  return cachedConfig;
}

export function getEnv(): Env {
  return getConfig();
}
