export type WorkspaceType = 'issue' | 'mr';

export interface WorkspaceInfo {
  id: string;
  type: WorkspaceType;
  projectId: number;
  iid: number;
  path: string;
  createdAt: Date;
  lastUsedAt: Date;
}

export interface CreateWorkspaceOptions {
  type: WorkspaceType;
  projectId: number;
  iid: number;
  repoUrl: string;
  defaultBranch: string;
}

export interface WorkspaceStatus {
  exists: boolean;
  path: string;
  isClean: boolean;
  lastCommit?: string;
}
