import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: isDev ? 'debug' : 'info',
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
        },
      }
    : undefined,
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
