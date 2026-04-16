import { logger } from '../utils/logger.js';
import { createGitLabClient, extractIssueReferences } from '../gitlab/index.js';
import { getEnv } from '../config/index.js';
import {
  isClaudeCommand,
  extractInstruction,
  handleClaudeComment,
  handleAutoReview,
  analyzeIssue,
} from '../handlers/index.js';
import { WorkspaceManager } from '../workspace/manager.js';
import type {
  IssueWebhookPayload,
  MRWebhookPayload,
  NoteWebhookPayload,
} from './types.js';
import type { WebhookHandler } from './router.js';

const MR_CREATED_LABEL = 'mr-created';
const TO_BE_VERIFIED_LABEL = 'to-be-verified';
const PASS_LABEL = 'pass';

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
        let workspacePath: string | undefined;
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
          workspacePath = workspace.path;
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
              `🤖 ${getEnv().BOT_NAME} 正在分析 Issue，请稍候...`
            );

            // Analyze issue in background, passing workspace path if available
            analyzeIssue({ payload, workspacePath }).catch((error) => {
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

        // Replace to-be-verified with pass label when issue is closed
        try {
          const env = getEnv();
          const gitlab = createGitLabClient({
            baseUrl: env.GITLAB_URL,
            token: env.GITLAB_ACCESS_TOKEN,
          });

          // Get current issue labels
          const issue = await gitlab.issues.get(project.id, iid);
          const currentLabels = issue.labels || [];

          // Check if issue has to-be-verified label
          if (currentLabels.includes(TO_BE_VERIFIED_LABEL)) {
            // Remove to-be-verified and add pass
            await gitlab.issues.removeLabels(project.id, iid, [TO_BE_VERIFIED_LABEL]);
            await gitlab.issues.addLabels(project.id, iid, [PASS_LABEL]);
            logger.info(
              { event: 'issue_labels_updated', issue_iid: iid, removed: TO_BE_VERIFIED_LABEL, added: PASS_LABEL },
              `Replaced '${TO_BE_VERIFIED_LABEL}' with '${PASS_LABEL}' on Issue #${iid}`
            );
          }
        } catch (labelError) {
          logger.warn(
            { event: 'issue_labels_update_failed', issue_iid: iid, error: labelError },
            `Failed to update labels on Issue #${iid}`
          );
        }

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

      const botUsername = getEnv().BOT_USERNAME;

      // Get MR details and referenced issues first
      let referencedIssueIids: number[] = [];
      try {
        const env = getEnv();
        const gitlab = createGitLabClient({
          baseUrl: env.GITLAB_URL,
          token: env.GITLAB_ACCESS_TOKEN,
        });
        const mr = await gitlab.mergeRequests.get(project.id, iid);
        referencedIssueIids = extractIssueReferences(mr.description || '');
      } catch (error) {
        logger.warn(
          { event: 'mr_get_details_failed', mr_iid: iid, error },
          `Failed to get MR details for #${iid}`
        );
      }

      // Determine workspace to use: prefer first referenced issue, otherwise MR itself
      let workspaceType: 'issue' | 'mr' = 'mr';
      let workspaceIid: number = iid;
      if (referencedIssueIids.length > 0) {
        const issueIid = referencedIssueIids[0];
        const issueWorkspaceExists = await workspaceManager.exists(project.name, 'issue', issueIid);
        if (issueWorkspaceExists) {
          workspaceType = 'issue';
          workspaceIid = issueIid;
          logger.info(
            { event: 'mr_use_issue_workspace', mr_iid: iid, issue_iid: issueIid },
            `MR #${iid} will use workspace from Issue #${issueIid}`
          );
        }
      }

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

        // Add mr-created label to referenced issues when MR is opened
        if (action === 'open' && referencedIssueIids.length > 0) {
          try {
            const env = getEnv();
            const gitlab = createGitLabClient({
              baseUrl: env.GITLAB_URL,
              token: env.GITLAB_ACCESS_TOKEN,
            });

            logger.info(
              { event: 'mr_issue_references_found', mr_iid: iid, issue_iids: referencedIssueIids },
              `Found ${referencedIssueIids.length} issue references in MR #${iid}`
            );

            for (const issueIid of referencedIssueIids) {
              try {
                await gitlab.issues.addLabels(project.id, issueIid, [MR_CREATED_LABEL]);
                logger.info(
                  { event: 'issue_label_added', issue_iid: issueIid, mr_iid: iid, label: MR_CREATED_LABEL },
                  `Added label '${MR_CREATED_LABEL}' to Issue #${issueIid}`
                );
              } catch (labelError) {
                logger.warn(
                  { event: 'issue_label_add_failed', issue_iid: issueIid, mr_iid: iid, error: labelError },
                  `Failed to add label to Issue #${issueIid}`
                );
              }
            }
          } catch (error) {
            logger.warn(
              { event: 'mr_issue_reference_processing_failed', mr_iid: iid, error },
              `Failed to process issue references for MR #${iid}`
            );
          }
        }

        // Auto-create workspace for MR - delete existing first if exists, then create fresh
        try {
          const cloneBranch = source_branch || project.default_branch;

          const workspace = await workspaceManager.getOrCreate({
            type: workspaceType,
            projectId: project.id,
            projectName: project.name,
            iid: workspaceIid,
            repoUrl: project.git_http_url.replace(
              'http://',
              `http://oauth2:${getEnv().GITLAB_ACCESS_TOKEN}@`
            ),
            defaultBranch: workspaceType === 'issue' ? project.default_branch : cloneBranch,
          });
          logger.info(
            { event: 'workspace_auto_created', workspace_id: workspace.id, mr_iid: iid, workspace_type: workspaceType, workspace_iid: workspaceIid, workspace_path: workspace.path },
            `Workspace for MR #${iid} using ${workspaceType} #${workspaceIid}`
          );

          // If using issue workspace, checkout to MR's source branch
          if (workspaceType === 'issue' && source_branch) {
            try {
              const git = await workspaceManager.getGit(project.name, workspaceType, workspaceIid);
              await git.fetch('origin', source_branch);
              await git.checkout(['-b', source_branch, 'FETCH_HEAD']);
              logger.info(
                { event: 'workspace_checkout_branch', workspace_id: workspace.id, source_branch },
                `Issue workspace checked out to MR branch ${source_branch}`
              );
            } catch (checkoutError) {
              logger.warn(
                { event: 'workspace_checkout_failed', workspace_id: workspace.id, source_branch, error: checkoutError },
                `Failed to checkout branch ${source_branch} in issue workspace`
              );
            }
          } else if (workspaceType === 'mr') {
            // If we cloned default branch but MR has a source branch, checkout to it
            if (source_branch && cloneBranch !== source_branch) {
              try {
                const git = await workspaceManager.getGit(project.name, 'mr', iid);
                await git.fetch('origin', source_branch);
                await git.checkout(['-b', source_branch, 'FETCH_HEAD']);
                logger.info(
                  { event: 'workspace_checkout_branch', workspace_id: workspace.id, source_branch },
                  `MR workspace checked out to branch ${source_branch}`
                );
              } catch (checkoutError) {
                logger.warn(
                  { event: 'workspace_checkout_failed', workspace_id: workspace.id, source_branch, error: checkoutError },
                  `Failed to checkout branch ${source_branch} in MR workspace`
                );
              }
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
      } else if (action === 'merge') {
        logger.info(
          {
            event: 'mr_merged',
            project_id: project.id,
            mr_iid: iid,
          },
          `MR merged: #${iid}`
        );

        // Add to-be-verified label to referenced issues when MR is merged
        try {
          const env = getEnv();
          const gitlab = createGitLabClient({
            baseUrl: env.GITLAB_URL,
            token: env.GITLAB_ACCESS_TOKEN,
          });

          // Get full MR details to parse issue references from description
          const mr = await gitlab.mergeRequests.get(project.id, iid);
          const referencedIssueIids = extractIssueReferences(mr.description || '');

          if (referencedIssueIids.length > 0) {
            logger.info(
              { event: 'mr_merged_issue_references', mr_iid: iid, issue_iids: referencedIssueIids },
              `Found ${referencedIssueIids.length} issue references in merged MR #${iid}`
            );

            for (const issueIid of referencedIssueIids) {
              try {
                await gitlab.issues.addLabels(project.id, issueIid, [TO_BE_VERIFIED_LABEL]);
                logger.info(
                  { event: 'issue_label_added', issue_iid: issueIid, mr_iid: iid, label: TO_BE_VERIFIED_LABEL },
                  `Added label '${TO_BE_VERIFIED_LABEL}' to Issue #${issueIid} after MR merge`
                );
              } catch (labelError) {
                logger.warn(
                  { event: 'issue_label_add_failed', issue_iid: issueIid, mr_iid: iid, error: labelError },
                  `Failed to add label to Issue #${issueIid}`
                );
              }
            }
          }
        } catch (error) {
          logger.warn(
            { event: 'mr_merged_issue_processing_failed', mr_iid: iid, error },
            `Failed to process issue references for merged MR #${iid}`
          );
        }

        // Auto-delete MR workspace only if we're not using issue's workspace
        if (workspaceType === 'mr') {
          try {
            await workspaceManager.delete(project.name, 'mr', iid);
            logger.info(
              { event: 'workspace_auto_deleted', mr_iid: iid },
              `Workspace auto-deleted for merged MR #${iid}`
            );
          } catch (error) {
            logger.warn(
              { event: 'workspace_auto_delete_failed', mr_iid: iid, error },
              `Failed to auto-delete workspace for MR #${iid}`
            );
          }
        } else {
          logger.info(
            { event: 'workspace_keep_issue_workspace', mr_iid: iid, issue_iid: workspaceIid },
            `Keeping issue workspace #${workspaceIid} for merged MR #${iid}`
          );
        }
      } else if (action === 'close') {
        logger.info(
          {
            event: 'mr_closed',
            project_id: project.id,
            mr_iid: iid,
          },
          `MR closed: #${iid}`
        );

        // Add to-be-verified label to referenced issues when MR is closed
        try {
          const env = getEnv();
          const gitlab = createGitLabClient({
            baseUrl: env.GITLAB_URL,
            token: env.GITLAB_ACCESS_TOKEN,
          });

          // Get full MR details to parse issue references from description
          const mr = await gitlab.mergeRequests.get(project.id, iid);
          const referencedIssueIids = extractIssueReferences(mr.description || '');

          if (referencedIssueIids.length > 0) {
            logger.info(
              { event: 'mr_closed_issue_references', mr_iid: iid, issue_iids: referencedIssueIids },
              `Found ${referencedIssueIids.length} issue references in closed MR #${iid}`
            );

            for (const issueIid of referencedIssueIids) {
              try {
                await gitlab.issues.addLabels(project.id, issueIid, [TO_BE_VERIFIED_LABEL]);
                logger.info(
                  { event: 'issue_label_added', issue_iid: issueIid, mr_iid: iid, label: TO_BE_VERIFIED_LABEL },
                  `Added label '${TO_BE_VERIFIED_LABEL}' to Issue #${issueIid} after MR close`
                );
              } catch (labelError) {
                logger.warn(
                  { event: 'issue_label_add_failed', issue_iid: issueIid, mr_iid: iid, error: labelError },
                  `Failed to add label to Issue #${issueIid}`
                );
              }
            }
          }
        } catch (error) {
          logger.warn(
            { event: 'mr_closed_issue_processing_failed', mr_iid: iid, error },
            `Failed to process issue references for closed MR #${iid}`
          );
        }

        // Auto-delete MR workspace only if we're not using issue's workspace
        if (workspaceType === 'mr') {
          try {
            await workspaceManager.delete(project.name, 'mr', iid);
            logger.info(
              { event: 'workspace_auto_deleted', mr_iid: iid },
              `Workspace auto-deleted for closed MR #${iid}`
            );
          } catch (error) {
            logger.warn(
              { event: 'workspace_auto_delete_failed', mr_iid: iid, error },
              `Failed to auto-delete workspace for MR #${iid}`
            );
          }
        } else {
          logger.info(
            { event: 'workspace_keep_issue_workspace', mr_iid: iid, issue_iid: workspaceIid },
            `Keeping issue workspace #${workspaceIid} for closed MR #${iid}`
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
