// GitLab API Types

export interface Project {
  id: number;
  name: string;
  description: string;
  web_url: string;
  git_ssh_url: string;
  git_http_url: string;
  namespace: string;
  path_with_namespace: string;
  default_branch: string;
}

export interface User {
  id: number;
  username: string;
  name: string;
  avatar_url: string;
  email: string;
}

export interface Issue {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string;
  state: 'opened' | 'closed';
  author: User;
  assignee?: User;
  assignees: User[];
  created_at: string;
  updated_at: string;
  labels: string[];
  milestone?: Milestone;
  web_url: string;
  references: {
    short: string;
    relative: string;
    full: string;
  };
}

export interface Milestone {
  id: number;
  iid: number;
  title: string;
  description: string;
  state: 'active' | 'closed';
  created_at: string;
  updated_at: string;
  due_date?: string;
}

export interface MergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  author: User;
  assignee?: User;
  assignees: User[];
  created_at: string;
  updated_at: string;
  source_branch: string;
  target_branch: string;
  web_url: string;
  references: {
    short: string;
    relative: string;
    full: string;
  };
  diff_refs?: {
    base_sha: string;
    head_sha: string;
    start_sha: string;
  };
  changes_count?: string;
}

export interface Note {
  id: number;
  type?: string;
  body: string;
  author: User;
  created_at: string;
  updated_at: string;
  resolvable?: boolean;
  resolved?: boolean;
  noteable_id: number;
  noteable_type: 'Issue' | 'MergeRequest';
}

export interface Diff {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
}

export interface MRChanges {
  id: number;
  iid: number;
  project_id: number;
  changes: Diff[];
  changes_count: string;
}

export interface ProjectAccess {
  access_level: number;
  notification_level: number;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}
