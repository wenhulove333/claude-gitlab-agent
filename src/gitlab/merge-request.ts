import { GitLabClient } from './client.js';
import type { MergeRequest, MRChanges, Note, Diff } from './types.js';

/**
 * Patterns to match issue references in MR descriptions
 * Matches: closes #123, fix #123, fixes #123, closes #123, close #123, resolved #123, resolves #123
 */
const ISSUE_REFERENCE_PATTERNS = [
  /(?:closes?|fix(?:es)?|close|resolve[sd]?)\s*#(\d+)/gi,
];

/**
 * Extract issue IID references from MR description
 */
export function extractIssueReferences(description: string): number[] {
  const iids = new Set<number>();

  for (const pattern of ISSUE_REFERENCE_PATTERNS) {
    let match;
    while ((match = pattern.exec(description)) !== null) {
      const iid = parseInt(match[1], 10);
      if (!isNaN(iid)) {
        iids.add(iid);
      }
    }
  }

  return Array.from(iids);
}

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
