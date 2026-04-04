import { GitLabClient } from './client.js';
import type { Issue, Note, User } from './types.js';

export interface GetIssueNotesOptions {
  sort?: 'asc' | 'desc';
  orderBy?: 'created_at' | 'updated_at';
}

export class IssueAPI {
  constructor(private client: GitLabClient) {}

  async get(projectId: number, issueIid: number): Promise<Issue> {
    return this.client.get<Issue>(`/projects/${projectId}/issues/${issueIid}`);
  }

  async getNotes(projectId: number, issueIid: number, options: GetIssueNotesOptions = {}): Promise<Note[]> {
    const params = new URLSearchParams();
    if (options.sort) params.set('sort', options.sort);
    if (options.orderBy) params.set('order_by', options.orderBy);

    const query = params.toString() ? `?${params.toString()}` : '';
    return this.client.get<Note[]>(`/projects/${projectId}/issues/${issueIid}/notes${query}`);
  }

  async createNote(projectId: number, issueIid: number, body: string): Promise<Note> {
    return this.client.post<Note>(`/projects/${projectId}/issues/${issueIid}/notes`, { body });
  }

  async assignees(projectId: number, issueIid: number): Promise<User[]> {
    return this.client.get<User[]>(`/projects/${projectId}/issues/${issueIid}/assignees`);
  }
}
