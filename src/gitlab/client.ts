import { GitLabAPIError } from '../utils/errors.js';
import { logDebug, logError } from '../utils/logger.js';

export interface GitLabClientConfig {
  baseUrl: string;
  token: string;
}

export class GitLabClient {
  private baseUrl: string;
  private token: string;

  constructor(config: GitLabClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token;
  }

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}/api/v4${path}`;

    logDebug({ event: 'gitlab_api_request', method: options.method || 'GET', path }, `GitLab API request: ${path}`);

    const response = await fetch(url, {
      ...options,
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      logError(
        {
          event: 'gitlab_api_error',
          path,
          status: response.status,
          error: errorText,
        },
        `GitLab API error: ${response.status} ${response.statusText}`
      );
      throw new GitLabAPIError(
        `GitLab API error: ${response.status} ${response.statusText} - ${errorText}`,
        response.status
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>(path, {
      method: 'DELETE',
    });
  }
}
