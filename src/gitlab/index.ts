import { GitLabClient, type GitLabClientConfig } from './client.js';
import { IssueAPI } from './issue.js';
import { MergeRequestAPI } from './merge-request.js';
import { NoteAPI } from './note.js';
import { ProjectAPI } from './project.js';

export { GitLabClient, type GitLabClientConfig } from './client.js';
export { IssueAPI } from './issue.js';
export { MergeRequestAPI } from './merge-request.js';
export { NoteAPI } from './note.js';
export { ProjectAPI } from './project.js';
export * from './types.js';

// Factory function to create GitLab client with all APIs
export function createGitLabClient(config: GitLabClientConfig) {
  const client = new GitLabClient(config);
  return {
    client,
    issues: new IssueAPI(client),
    mergeRequests: new MergeRequestAPI(client),
    notes: new NoteAPI(client),
    projects: new ProjectAPI(client),
  };
}
