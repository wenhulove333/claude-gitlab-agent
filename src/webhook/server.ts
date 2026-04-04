import { Hono } from 'hono';
import { logger } from '../utils/logger.js';
import { verifyGitLabWebhook } from './verify.js';
import { WebhookRouter, type WebhookHandler } from './router.js';
import type { WebhookPayload } from './types.js';
import { getEnv } from '../config/index.js';
import { generateMetrics } from '../metrics/index.js';

export interface WebhookServerOptions {
  handlers: WebhookHandler;
}

export function createWebhookServer(options: WebhookServerOptions): Hono {
  const app = new Hono();
  const env = getEnv();

  // Health check endpoint
  app.get('/health', (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Prometheus metrics endpoint
  app.get('/metrics', (c) => {
    const metricsOutput = generateMetrics();
    return c.text(metricsOutput, 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    });
  });

  // Webhook endpoint
  app.post('/webhook', async (c) => {
    const body = await c.req.text();
    const signature = c.req.header('X-Hub-Signature-256') ?? null;
    const gitlabToken = c.req.header('X-Gitlab-Token') ?? null;

    logger.info({
      event: 'webhook_received',
      path: '/webhook',
      hasSignature: !!signature,
      hasGitlabToken: !!gitlabToken,
      webhookSecretConfigured: !!env.WEBHOOK_SECRET,
      gitlabTokenConfigured: !!env.GITLAB_ACCESS_TOKEN,
    }, 'Webhook received');

    // Verify webhook signature
    try {
      // X-Gitlab-Token header should match WEBHOOK_SECRET (GitLab's token auth)
      // X-Hub-Signature-256 header should match WEBHOOK_SECRET (HMAC signature)
      verifyGitLabWebhook(body, signature, gitlabToken, {
        secret: env.WEBHOOK_SECRET,
        token: env.WEBHOOK_SECRET, // X-Gitlab-Token matches WEBHOOK_SECRET
      });
    } catch (error) {
      logger.error({
        event: 'webhook_verification_failed',
        error,
        receivedSignature: signature?.slice(0, 20),
        receivedGitlabToken: gitlabToken?.slice(0, 10),
        expectedSecret: env.WEBHOOK_SECRET ? '***configured***' : 'NOT SET',
      }, 'Webhook verification failed');
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Parse payload
    let payload: WebhookPayload;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      logger.error({ event: 'webhook_parse_failed', error }, 'Failed to parse webhook payload');
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    // Route webhook
    const router = new WebhookRouter(options.handlers);
    try {
      await router.route(payload);
      return c.json({ status: 'ok' });
    } catch (error) {
      logger.error({ event: 'webhook_route_error', error }, 'Error routing webhook');
      return c.json({ error: 'Internal error' }, 500);
    }
  });

  return app;
}
