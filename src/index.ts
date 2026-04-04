import 'dotenv/config';
import { startServer } from './server.js';
import { logger } from './utils/logger.js';

async function main() {
  try {
    await startServer();
  } catch (error) {
    logger.error({ event: 'startup_failed', error }, 'Failed to start server');
    process.exit(1);
  }
}

main();
