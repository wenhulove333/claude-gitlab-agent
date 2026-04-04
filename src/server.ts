import { serve } from '@hono/node-server';
import { logger } from './utils/logger.js';
import { getEnv } from './config/index.js';
import { createWebhookServer, createWebhookHandlers } from './webhook/index.js';

export async function startServer(): Promise<void> {
  const env = getEnv();

  // Create webhook server with real handlers
  const app = createWebhookServer({
    handlers: createWebhookHandlers(),
  });

  // Start server
  const port = env.PORT;
  serve({
    fetch: app.fetch,
    port,
  });
  logger.info({ event: 'server_started', port }, `Server started on port ${port}`);
}
