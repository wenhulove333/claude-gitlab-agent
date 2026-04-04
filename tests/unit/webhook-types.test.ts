import { describe, it, expect } from 'vitest';
import {
  isIssuePayload,
  isMRPayload,
  isNotePayload,
} from '../../src/webhook/types.js';

describe('Webhook Type Guards', () => {
  const issuePayload = {
    object_kind: 'issue' as const,
    event_type: 'Issue Hook' as const,
    project: { id: 1, name: 'test', description: '', web_url: '', git_ssh_url: '', git_http_url: '', namespace: '', path_with_namespace: '', default_branch: 'main' },
    user: { id: 1, username: 'user', name: 'User', avatar_url: '', email: '' },
    object_attributes: {
      id: 1,
      iid: 1,
      title: 'Test',
      description: 'Test',
      state: 'opened' as const,
      action: 'open' as const,
      created_at: '',
      updated_at: '',
      labels: [],
    },
  };

  const mrPayload = {
    object_kind: 'merge_request' as const,
    event_type: 'Merge Request Hook' as const,
    project: { id: 1, name: 'test', description: '', web_url: '', git_ssh_url: '', git_http_url: '', namespace: '', path_with_namespace: '', default_branch: 'main' },
    user: { id: 1, username: 'user', name: 'User', avatar_url: '', email: '' },
    object_attributes: {
      id: 1,
      iid: 1,
      title: 'Test',
      description: 'Test',
      state: 'opened' as const,
      action: 'open' as const,
      created_at: '',
      updated_at: '',
      source_branch: 'feature',
      target_branch: 'main',
    },
  };

  const notePayload = {
    object_kind: 'note' as const,
    event_type: 'Note Hook' as const,
    project: { id: 1, name: 'test', description: '', web_url: '', git_ssh_url: '', git_http_url: '', namespace: '', path_with_namespace: '', default_branch: 'main' },
    user: { id: 1, username: 'user', name: 'User', avatar_url: '', email: '' },
    object_attributes: {
      id: 1,
      note: 'Test comment',
      noteable_type: 'Issue' as const,
      content: 'Test comment',
      action: 'create' as const,
      created_at: '',
      updated_at: '',
    },
  };

  describe('isIssuePayload', () => {
    it('should return true for issue payload', () => {
      expect(isIssuePayload(issuePayload)).toBe(true);
    });

    it('should return false for MR payload', () => {
      expect(isIssuePayload(mrPayload)).toBe(false);
    });

    it('should return false for note payload', () => {
      expect(isIssuePayload(notePayload)).toBe(false);
    });
  });

  describe('isMRPayload', () => {
    it('should return false for issue payload', () => {
      expect(isMRPayload(issuePayload)).toBe(false);
    });

    it('should return true for MR payload', () => {
      expect(isMRPayload(mrPayload)).toBe(true);
    });

    it('should return false for note payload', () => {
      expect(isMRPayload(notePayload)).toBe(false);
    });
  });

  describe('isNotePayload', () => {
    it('should return false for issue payload', () => {
      expect(isNotePayload(issuePayload)).toBe(false);
    });

    it('should return false for MR payload', () => {
      expect(isNotePayload(mrPayload)).toBe(false);
    });

    it('should return true for note payload', () => {
      expect(isNotePayload(notePayload)).toBe(true);
    });
  });
});
