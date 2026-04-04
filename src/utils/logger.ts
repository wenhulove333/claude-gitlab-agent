import pino from 'pino';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';

const isDev = process.env.NODE_ENV !== 'production';

// Ensure logs directory exists
const logsDir = join(process.cwd(), 'logs');
if (!existsSync(logsDir)) {
  mkdirSync(logsDir, { recursive: true });
}

const logFile = join(logsDir, 'app.log');

export const logger = pino({
  level: isDev ? 'debug' : 'info',
  transport: isDev
    ? {
        targets: [
          {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
            },
            level: 'debug',
          },
          {
            target: 'pino/file',
            options: {
              destination: logFile,
              mkdir: true,
            },
            level: 'info',
          },
        ],
      }
    : {
        target: 'pino/file',
        options: {
          destination: logFile,
          mkdir: true,
        },
      },
});

export interface LogFields {
  event: string;
  [key: string]: unknown;
}

export function logInfo(fields: LogFields, message: string): void {
  logger.info(fields, message);
}

export function logError(fields: LogFields & { error?: Error | string }, message: string): void {
  logger.error(fields, message);
}

export function logWarn(fields: LogFields, message: string): void {
  logger.warn(fields, message);
}

export function logDebug(fields: LogFields, message: string): void {
  logger.debug(fields, message);
}
