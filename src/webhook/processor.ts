import { logger } from '../utils/logger.js';
import { createGitLabClient } from '../gitlab/index.js';
import { getEnv } from '../config/index.js';
import {
  isClaudeCommand,
  extractInstruction,
  handleClaudeComment,
  handleAutoReview,
  isCreateMRCommand,
  handleCreateMR,
} from '../handlers/index.js';
import type {
  IssueWebhookPayload,
  MRWebhookPayload,
  NoteWebhookPayload,
} from './types.js';
import type { WebhookHandler } from './router.js';

/**
 * Create webhook handlers with business logic
 */
export function createWebhookHandlers(): WebhookHandler {
  return {
    onIssue: async (payload: IssueWebhookPayload) => {
      const { action } = payload.object_attributes;
      const project = payload.project;

      // Handle issue events
      if (action === 'open' || action === 'reopen') {
        logger.info(
          {
            event: 'issue_action',
            action,
            project_id: project.id,
            issue_iid: payload.object_attributes.iid,
          },
          `Issue ${action}: #${payload.object_attributes.iid}`
        );
      }
    },

    onMergeRequest: async (payload: MRWebhookPayload) => {
      const { action } = payload.object_attributes;

      // Get project settings (simplified)
      const projectSettings = {
        autoReviewEnabled: true,
        excludePaths: ['*.lock', 'package-lock.json', 'yarn.lock'],
      };

      const botUsername = 'claude'; // This should come from project settings

      // Handle auto review
      if (action === 'open' || action === 'reopen') {
        await handleAutoReview({
          payload,
          botUsername,
          maxFiles: 20,
          projectSettings,
        });
      }
    },

    onNote: async (payload: NoteWebhookPayload) => {
      const { noteable_type, note, content } = payload.object_attributes;
      const project = payload.project;
      const commentBody = note || content;

      if (!commentBody) {
        return;
      }

      // Check if this is a @claude command
      if (!isClaudeCommand(commentBody)) {
        return;
      }

      logger.info(
        {
          event: 'claude_command_detected',
          project_id: project.id,
          noteable_type,
        },
        'Claude command detected in comment'
      );

      // Check for /create-mr first
      if (isCreateMRCommand(commentBody)) {
        // Get issue payload info if this is on an issue
        if (noteable_type === 'Issue' && payload.issue) {
          const env = getEnv();
          const gitlab = createGitLabClient({
            baseUrl: env.GITLAB_URL,
            token: env.GITLAB_ACCESS_TOKEN,
          });

          // Get full issue details
          const issue = await gitlab.issues.get(project.id, payload.issue.iid);

          // Create a synthetic IssueWebhookPayload-like structure
          const issuePayload: IssueWebhookPayload = {
            object_kind: 'issue',
            event_type: 'Issue Hook',
            project: payload.project,
            user: payload.user,
            object_attributes: {
              id: issue.id,
              iid: issue.iid,
              title: issue.title,
              description: issue.description,
              state: issue.state,
              action: 'open',
              created_at: issue.created_at,
              updated_at: issue.updated_at,
              labels: [], // Labels not needed for create MR
            },
          };

          const projectSettings = {
            createMREnabled: true, // In production, fetch from project settings
          };

          await handleCreateMR({
            payload: issuePayload,
            projectSettings,
          });
        }
        return;
      }

      // Handle regular @claude Q&A
      const instruction = extractInstruction(commentBody);
      if (instruction) {
        await handleClaudeComment({
          payload,
        });
      }
    },
  };
}
