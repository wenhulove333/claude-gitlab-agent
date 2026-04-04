export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class GitLabAPIError extends AppError {
  constructor(
    message: string,
    public statusCode: number,
    public response?: Response
  ) {
    super(message, 'GITLAB_API_ERROR', statusCode);
    this.name = 'GitLabAPIError';
  }
}

export class WebhookVerificationError extends AppError {
  constructor(message: string) {
    super(message, 'WEBHOOK_VERIFICATION_FAILED', 401);
    this.name = 'WebhookVerificationError';
  }
}

export class WorkspaceError extends AppError {
  constructor(message: string) {
    super(message, 'WORKSPACE_ERROR', 500);
    this.name = 'WorkspaceError';
  }
}

export class ClaudeCLIError extends AppError {
  constructor(message: string, public exitCode: number) {
    super(message, 'CLAUDE_CLI_ERROR', 500);
    this.name = 'ClaudeCLIError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}
