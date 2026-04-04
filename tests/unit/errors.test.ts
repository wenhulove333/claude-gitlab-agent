import { describe, it, expect } from 'vitest';
import {
  AppError,
  GitLabAPIError,
  WebhookVerificationError,
  WorkspaceError,
  ClaudeCLIError,
  ValidationError,
  NotFoundError,
} from '../../src/utils/errors.js';

describe('Error Classes', () => {
  describe('AppError', () => {
    it('should create error with correct properties', () => {
      const error = new AppError('Test error', 'TEST_ERROR', 400);
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_ERROR');
      expect(error.statusCode).toBe(400);
      expect(error.name).toBe('AppError');
    });

    it('should default statusCode to 500', () => {
      const error = new AppError('Test', 'TEST');
      expect(error.statusCode).toBe(500);
    });
  });

  describe('GitLabAPIError', () => {
    it('should create GitLab API error', () => {
      const error = new GitLabAPIError('API failed', 502);
      expect(error.code).toBe('GITLAB_API_ERROR');
      expect(error.statusCode).toBe(502);
      expect(error.name).toBe('GitLabAPIError');
    });
  });

  describe('WebhookVerificationError', () => {
    it('should create webhook verification error with 401', () => {
      const error = new WebhookVerificationError('Invalid signature');
      expect(error.code).toBe('WEBHOOK_VERIFICATION_FAILED');
      expect(error.statusCode).toBe(401);
      expect(error.name).toBe('WebhookVerificationError');
    });
  });

  describe('WorkspaceError', () => {
    it('should create workspace error', () => {
      const error = new WorkspaceError('Cannot create directory');
      expect(error.code).toBe('WORKSPACE_ERROR');
      expect(error.statusCode).toBe(500);
      expect(error.name).toBe('WorkspaceError');
    });
  });

  describe('ClaudeCLIError', () => {
    it('should create Claude CLI error with exit code', () => {
      const error = new ClaudeCLIError('CLI timeout', 124);
      expect(error.code).toBe('CLAUDE_CLI_ERROR');
      expect(error.exitCode).toBe(124);
      expect(error.name).toBe('ClaudeCLIError');
    });
  });

  describe('ValidationError', () => {
    it('should create validation error with 400', () => {
      const error = new ValidationError('Invalid input');
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.statusCode).toBe(400);
      expect(error.name).toBe('ValidationError');
    });
  });

  describe('NotFoundError', () => {
    it('should create not found error with 404', () => {
      const error = new NotFoundError('Resource not found');
      expect(error.code).toBe('NOT_FOUND');
      expect(error.statusCode).toBe(404);
      expect(error.name).toBe('NotFoundError');
    });
  });
});
