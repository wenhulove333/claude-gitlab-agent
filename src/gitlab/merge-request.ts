import { GitLabClient } from './client.js';
import type { MergeRequest, MRChanges, Note, Diff } from './types.js';

export interface GetMRChangesOptions {
  includeDiff?: boolean;
}

export class MergeRequestAPI {
  constructor(private client: GitLabClient) {}

  async get(projectId: number, mrIid: number): Promise<MergeRequest> {
    return this.client.get<MergeRequest>(`/projects/${projectId}/merge_requests/${mrIid}`);
  }

  async getChanges(projectId: number, mrIid: number): Promise<MRChanges> {
    return this.client.get<MRChanges>(
      `/projects/${projectId}/merge_requests/${mrIid}/changes`
    );
  }

  async getDiff(projectId: number, mrIid: number): Promise<Diff[]> {
    const changes = await this.getChanges(projectId, mrIid);
    return changes.changes;
  }

  async getNotes(projectId: number, mrIid: number): Promise<Note[]> {
    return this.client.get<Note[]>(`/projects/${projectId}/merge_requests/${mrIid}/notes`);
  }

  async createNote(projectId: number, mrIid: number, body: string): Promise<Note> {
    return this.client.post<Note>(`/projects/${projectId}/merge_requests/${mrIid}/notes`, { body });
  }

  async getVersion(projectId: number, mrIid: number): Promise<{ id: number; version: string }> {
    return this.client.get(`/projects/${projectId}/merge_requests/${mrIid}/versions`);
  }
}
