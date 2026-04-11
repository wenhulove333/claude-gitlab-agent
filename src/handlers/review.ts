import { logInfo, logDebug, logError, logWarn } from '../utils/logger.js';
import { createGitLabClient } from '../gitlab/index.js';
import { getClaudeCLI } from '../claude/index.js';
import { buildReviewPrompt } from '../claude/prompts/index.js';
import type { MRWebhookPayload } from '../webhook/types.js';
import type { Diff } from '../gitlab/types.js';
import { getEnv, getProjectSettings } from '../config/index.js';

/**
 * Format diff for Claude review
 * @param diffs - Array of file diffs from MR
 * @returns Formatted diff string for review prompt
 */
function formatDiffForReview(diffs: Diff[]): string {
  let output = '';

  for (const diff of diffs) {
    output += `\n=== ${diff.new_path} ===\n`;
    if (diff.deleted_file) {
      output += '(文件已删除)\n';
    } else if (diff.new_file) {
      output += '(新文件)\n';
    }
    output += diff.diff + '\n';
  }

  return output;
}

/**
 * Format "no issues" comment when review passes with no problems found
 * @param botName - Display name of the bot
 * @returns Formatted comment string
 */
function formatNoIssuesComment(botName: string): string {
  return `✅ **${botName} 自动代码审查**\n\n未发现明显问题，代码质量良好。`;
}

export interface HandleReviewOptions {
  /** MR webhook payload */
  payload: MRWebhookPayload;
  /** Bot username to skip self-authored MRs */
  botUsername?: string;
  /** Bot display name */
  botName?: string;
  /** Maximum files to review */
  maxFiles?: number;
  /** Project settings override */
  projectSettings?: {
    autoReviewEnabled?: boolean;
    excludePaths?: string[];
  };
}

/**
 * Handle automatic code review for MR
 */
export async function handleAutoReview(
  options: HandleReviewOptions
): Promise<void> {
  const {
    payload,
    botUsername,
    botName,
    maxFiles = 20,
    projectSettings = {},
  } = options;

  const { action, iid, title, description } = payload.object_attributes;
  const project = payload.project;
  const author = payload.user;

  // Get bot name from project settings if not provided
  const effectiveBotName = botName || (await getProjectSettings(project.id)).botName;
  const effectiveBotUsername = botUsername || (await getProjectSettings(project.id)).botUsername;

  // Check if auto review is enabled
  if (projectSettings.autoReviewEnabled === false) {
    logDebug(
      { event: 'auto_review_disabled', project_id: project.id },
      'Auto review is disabled for this project'
    );
    return;
  }

  // Only respond to opened or reopened MRs
  if (action !== 'open' && action !== 'reopen') {
    logDebug(
      { event: 'mr_ignored', action, mr_iid: iid },
      'MR action ignored (not open/reopen)'
    );
    return;
  }

  // Skip if author is the bot itself (match by username or display name)
  if (author.username === effectiveBotUsername || author.username === effectiveBotName) {
    logDebug(
      { event: 'mr_skipped_self_authored', mr_iid: iid, author: author.username },
      'Skipping self-authored MR'
    );
    return;
  }

  logInfo(
    {
      event: 'auto_review_started',
      project_id: project.id,
      mr_iid: iid,
      title,
      author: author.username,
    },
    `Starting auto review for MR !${iid}`
  );

  const env = getEnv();
  const gitlab = createGitLabClient({
    baseUrl: env.GITLAB_URL,
    token: env.GITLAB_ACCESS_TOKEN,
  });

  try {
    // Get MR changes
    const diffs = await gitlab.mergeRequests.getDiff(project.id, iid);

    // Check file count limit
    if (diffs.length > maxFiles) {
      const comment = `🤖 **${effectiveBotName} 自动代码审查**\n\n此 MR 变更文件过多（${diffs.length} 个），超过自动审查上限（${maxFiles} 个），请人工审查或分批处理。`;
      await gitlab.mergeRequests.createNote(project.id, iid, comment);
      logInfo(
        { event: 'mr_too_large', mr_iid: iid, file_count: diffs.length },
        'MR too large for auto review'
      );
      return;
    }

    // Filter excluded paths
    let filteredDiffs = diffs;
    if (projectSettings.excludePaths && projectSettings.excludePaths.length > 0) {
      filteredDiffs = diffs.filter((diff) => {
        for (const pattern of projectSettings.excludePaths!) {
          if (diff.new_path.includes(pattern) || diff.old_path.includes(pattern)) {
            return false;
          }
        }
        return true;
      });
    }

    if (filteredDiffs.length === 0) {
      await gitlab.mergeRequests.createNote(project.id, iid, formatNoIssuesComment(effectiveBotName));
      return;
    }

    // Post initial comment that review is starting
    try {
      await gitlab.mergeRequests.createNote(
        project.id,
        iid,
        `🤖 ${effectiveBotName} 正在review代码，请稍候...`
      );
    } catch (noteError) {
      logWarn({ event: 'review_start_note_failed', mr_iid: iid }, 'Failed to post review start note');
    }

    // Build prompt and call Claude CLI
    const diffText = formatDiffForReview(filteredDiffs);
    const prompt = buildReviewPrompt(
      project.path_with_namespace,
      iid,
      title,
      description,
      diffText
    );

    const cli = getClaudeCLI();

    logDebug({ event: 'claude_review_call', mr_iid: iid }, 'Calling Claude for review');

    const response = await cli.prompt(prompt, {
      timeout: 120, // 2 minutes for review
    });

    // Since Claude now outputs Markdown directly, just post the response
    const trimmedResponse = response.trim();
    if (!trimmedResponse) {
      await gitlab.mergeRequests.createNote(project.id, iid, formatNoIssuesComment(effectiveBotName));
    } else {
      await gitlab.mergeRequests.createNote(
        project.id,
        iid,
        `🤖 **${effectiveBotName} 自动代码审查**\n\n${trimmedResponse}`
      );
    }

    logInfo(
      { event: 'auto_review_completed', mr_iid: iid },
      'Auto review completed successfully'
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logError(
      { event: 'auto_review_failed', mr_iid: iid, error: errorMessage },
      `Auto review failed: ${errorMessage}`
    );

    try {
      const errorComment = `🤖 **${effectiveBotName} 自动代码审查**\n\n审查失败：${errorMessage}`;
      await gitlab.mergeRequests.createNote(project.id, iid, errorComment);
    } catch (postError) {
      logError(
        { event: 'review_error_post_failed', mr_iid: iid },
        'Failed to post error comment'
      );
    }
  }
}
