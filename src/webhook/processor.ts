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
  analyzeIssue,
} from '../handlers/index.js';
import { WorkspaceManager } from '../workspace/manager.js';
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
      const { action, iid } = payload.object_attributes;
      const project = payload.project;
      const workspaceManager = new WorkspaceManager();

      // Handle issue events
      if (action === 'open' || action === 'reopen') {
        logger.info(
          {
            event: 'issue_action',
            action,
            project_id: project.id,
            issue_iid: iid,
          },
          `Issue ${action}: #${iid}`
        );

        // Auto-create workspace for new/reopened issues
        try {
          const workspace = await workspaceManager.getOrCreate({
            type: 'issue',
            projectId: project.id,
            projectName: project.name,
            iid,
            repoUrl: project.git_http_url.replace(
              'http://',
              `http://oauth2:${getEnv().GITLAB_ACCESS_TOKEN}@`
            ),
            defaultBranch: project.default_branch,
          });
          logger.info(
            { event: 'workspace_auto_created', workspace_id: workspace.id, issue_iid: iid },
            `Workspace auto-created for Issue #${iid}`
          );
        } catch (error) {
          logger.error(
            { event: 'workspace_auto_create_failed', issue_iid: iid, error },
            `Failed to auto-create workspace for Issue #${iid}`
          );
        }

        // Auto-analyze issue when newly created (not reopened)
        if (action === 'open') {
          // Post initial comment that analysis is starting
          const gitlab = createGitLabClient({
            baseUrl: getEnv().GITLAB_URL,
            token: getEnv().GITLAB_ACCESS_TOKEN,
          });
          try {
            await gitlab.issues.createNote(
              project.id,
              iid,
              '🤖 Claude 正在分析 Issue，请稍候...'
            );

            // Analyze issue in background
            analyzeIssue(payload).catch((error) => {
              logger.error(
                { event: 'analyze_issue_error', issue_iid: iid, error },
                `Failed to analyze issue: ${error}`
              );
            });
          } catch (noteError) {
            logger.warn(
              { event: 'analyze_issue_note_failed', issue_iid: iid, error: noteError },
              'Failed to post initial analysis note'
            );
          }
        }
      } else if (action === 'close') {
        logger.info(
          {
            event: 'issue_closed',
            project_id: project.id,
            issue_iid: iid,
          },
          `Issue closed: #${iid}`
        );

        // Auto-delete workspace when issue is closed
        try {
          await workspaceManager.delete(project.name, 'issue', iid);
          logger.info(
            { event: 'workspace_auto_deleted', issue_iid: iid },
            `Workspace auto-deleted for Issue #${iid}`
          );
        } catch (error) {
          logger.warn(
            { event: 'workspace_auto_delete_failed', issue_iid: iid, error },
            `Failed to auto-delete workspace for Issue #${iid}`
          );
        }
      }
    },

    onMergeRequest: async (payload: MRWebhookPayload) => {
      const { action, iid, source_branch } = payload.object_attributes;
      const project = payload.project;
      const workspaceManager = new WorkspaceManager();

      // Get project settings (simplified)
      const projectSettings = {
        autoReviewEnabled: true,
        excludePaths: ['*.lock', 'package-lock.json', 'yarn.lock'],
      };

      const botUsername = 'claude'; // This should come from project settings

      // Handle auto review and workspace for open/reopen
      if (action === 'open' || action === 'reopen') {
        logger.info(
          {
            event: 'mr_action',
            action,
            project_id: project.id,
            mr_iid: iid,
          },
          `MR ${action}: #${iid}`
        );

        // Auto-create workspace for new/reopened MRs
        try {
          // For MRs, try to clone the source branch directly if it exists
          // This ensures the workspace starts on the MR's branch
          const cloneBranch = source_branch || project.default_branch;
          const workspace = await workspaceManager.getOrCreate({
            type: 'mr',
            projectId: project.id,
            projectName: project.name,
            iid,
            repoUrl: project.git_http_url.replace(
              'http://',
              `http://oauth2:${getEnv().GITLAB_ACCESS_TOKEN}@`
            ),
            defaultBranch: cloneBranch,
          });
          logger.info(
            { event: 'workspace_auto_created', workspace_id: workspace.id, mr_iid: iid, cloneBranch },
            `Workspace auto-created for MR #${iid} (cloned branch: ${cloneBranch})`
          );

          // If we cloned default branch but MR has a source branch, checkout to it
          if (source_branch && cloneBranch !== source_branch) {
            try {
              const git = await workspaceManager.getGit(project.name, 'mr', iid);
              await git.fetch('origin', source_branch);
              await git.checkout(source_branch);
              logger.info(
                { event: 'workspace_checkout_branch', workspace_id: workspace.id, source_branch },
                `Workspace checked out to branch ${source_branch}`
              );
            } catch (checkoutError) {
              logger.warn(
                { event: 'workspace_checkout_failed', workspace_id: workspace.id, source_branch, error: checkoutError },
                `Failed to checkout branch ${source_branch} in workspace`
              );
            }
          }
        } catch (error) {
          logger.error(
            { event: 'workspace_auto_create_failed', mr_iid: iid, error },
            `Failed to auto-create workspace for MR #${iid}`
          );
        }

        await handleAutoReview({
          payload,
          botUsername,
          maxFiles: 20,
          projectSettings,
        });
      } else if (action === 'merge' || action === 'close') {
        logger.info(
          {
            event: 'mr_closed_merged',
            action,
            project_id: project.id,
            mr_iid: iid,
          },
          `MR ${action}: #${iid}`
        );

        // Auto-delete workspace when MR is merged or closed
        try {
          await workspaceManager.delete(project.name, 'mr', iid);
          logger.info(
            { event: 'workspace_auto_deleted', mr_iid: iid },
            `Workspace auto-deleted for MR #${iid}`
          );
        } catch (error) {
          logger.warn(
            { event: 'workspace_auto_delete_failed', mr_iid: iid, error },
            `Failed to auto-delete workspace for MR #${iid}`
          );
        }
      }
    },

    onNote: async (payload: NoteWebhookPayload) => {
      const { noteable_type, note, content } = payload.object_attributes;
      const project = payload.project;
      const commentBody = note || content;

      logger.debug({
        event: 'note_received',
        noteable_type,
        note: commentBody,
        project_id: project.id,
      }, 'Note received');

      if (!commentBody) {
        return;
      }

      // Check if this is a @claude command
      if (!isClaudeCommand(commentBody)) {
        logger.debug({
          event: 'not_claude_command',
          commentBody,
        }, 'Not a @claude command');
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
