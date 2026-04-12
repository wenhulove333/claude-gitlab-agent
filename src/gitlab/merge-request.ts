import { GitLabClient } from './client.js';
import type { MergeRequest, MRChanges, Note, Diff } from './types.js';
import { logger } from '../utils/logger.js';

/**
 * Patterns to match issue references in MR descriptions
 * Matches:
 *   - GitLab keywords: closes #123, fix #123, fixes #123, close #123, resolved #123, resolves #123
 *   - Chinese patterns: 此 MR 由 Claude 基于 Issue #123 自动创建。
 */
const ISSUE_REFERENCE_PATTERNS = [
  /(?:closes?|fix(?:es)?|close|resolve[sd]?)\s*#(\d+)/gi,
  /(?:此\s*MR\s*由\s*[^基于]*基于\s*)?[Ii]ssue\s*#(\d+)/g,
];

/**
 * Extract issue IID references from MR description
 */
export function extractIssueReferences(description: string): number[] {
  const iids = new Set<number>();

  if (!description) {
    logger.debug({ event: 'extract_issue_references', status: 'empty_description' }, 'MR description is empty');
    return [];
  }

  for (const pattern of ISSUE_REFERENCE_PATTERNS) {
    let match;
    while ((match = pattern.exec(description)) !== null) {
      const iid = parseInt(match[1], 10);
      if (!isNaN(iid)) {
        iids.add(iid);
        logger.info(
          { event: 'issue_reference_matched', pattern: pattern.source, matched: match[0], iid },
          `Matched issue reference: ${match[0]}`
        );
      }
    }
  }

  if (iids.size > 0) {
    logger.info(
      { event: 'extract_issue_references', status: 'success', count: iids.size, iids: Array.from(iids) },
      `Extracted ${iids.size} issue references from MR description`
    );
  } else {
    logger.warn(
      { event: 'extract_issue_references', status: 'no_match', description: description.slice(0, 100) },
      'No issue references found in MR description'
    );
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
