import type { Project, User } from '../gitlab/types.js';

// Webhook event types
export type GitLabObjectKind = 'issue' | 'merge_request' | 'note' | 'push' | 'tag_push';

export type GitLabEventType =
  | 'Issue Hook'
  | 'Merge Request Hook'
  | 'Note Hook'
  | 'Push Hook'
  | 'Tag Push Hook';

// Base webhook payload
export interface BaseWebhookPayload {
  object_kind: GitLabObjectKind;
  event_type: GitLabEventType;
  project: Project;
  user: User;
}

// Issue events
export type IssueAction = 'open' | 'close' | 'reopen' | 'update' | 'label_update' | 'label_clear' | 'milestone' | 'due_update' | 'lock' | 'unlock';

export interface IssueWebhookPayload extends BaseWebhookPayload {
  object_kind: 'issue';
  object_attributes: {
    id: number;
    iid: number;
    title: string;
    description: string;
    state: 'opened' | 'closed';
    action: IssueAction;
    created_at: string;
    updated_at: string;
    last_edited_at?: string;
    closed_at?: string;
    target_branch?: string;
    labels: Array<{
      id: number;
      title: string;
      color: string;
    }>;
  };
}

// Merge Request events
export type MergeRequestAction = 'open' | 'close' | 'reopen' | 'update' | 'merge' | 'approved' | 'unapproved';

export interface MRWebhookPayload extends BaseWebhookPayload {
  object_kind: 'merge_request';
  object_attributes: {
    id: number;
    iid: number;
    title: string;
    description: string;
    state: 'opened' | 'closed' | 'merged' | 'locked';
    action: MergeRequestAction;
    created_at: string;
    updated_at: string;
    merged_at?: string;
    closed_at?: string;
    source_branch: string;
    target_branch: string;
    diff_refs?: {
      base_sha: string;
      head_sha: string;
      start_sha: string;
    };
    changes_count?: string;
  };
}

// Note/Comment events
export type NoteAction = 'create' | 'update' | 'delete';

export interface NoteWebhookPayload extends BaseWebhookPayload {
  object_kind: 'note';
  object_attributes: {
    id: number;
    note: string;
    noteable_type: 'Issue' | 'MergeRequest';
    content: string;
    action: NoteAction;
    created_at: string;
    updated_at: string;
  };
  project: Project;
  issue?: {
    id: number;
    iid: number;
    title: string;
  };
  merge_request?: {
    id: number;
    iid: number;
    title: string;
  };
}

// Union type for all payloads
export type WebhookPayload = IssueWebhookPayload | MRWebhookPayload | NoteWebhookPayload;

// Check if payload is specific type
export function isIssuePayload(payload: WebhookPayload): payload is IssueWebhookPayload {
  return payload.object_kind === 'issue';
}

export function isMRPayload(payload: WebhookPayload): payload is MRWebhookPayload {
  return payload.object_kind === 'merge_request';
}

export function isNotePayload(payload: WebhookPayload): payload is NoteWebhookPayload {
  return payload.object_kind === 'note';
}
