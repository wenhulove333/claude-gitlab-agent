/**
 * Claude GitLab Agent - Main Server Entry Point
 *
 * This server handles GitLab webhooks and provides endpoints for:
 * - /webhook: GitLab webhook receiver
 * - /health: Health check endpoint
 * - /metrics: Prometheus metrics endpoint
 */

import { serve } from '@hono/node-server';
import { logger } from './utils/logger.js';
import { getEnv } from './config/index.js';
import { createWebhookServer, createWebhookHandlers } from './webhook/index.js';

/**
 * Starts the HTTP server with webhook handling capabilities
 */
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
