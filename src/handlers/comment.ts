import { logInfo, logDebug, logError, logWarn } from '../utils/logger.js';
import { createGitLabClient, extractIssueReferences } from '../gitlab/index.js';
import { getClaudeCLI } from '../claude/index.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { buildSystemPrompt, validateResponse, generateRetryPrompt, parseResult } from '../claude/prompts/index.js';
import type { NoteWebhookPayload } from '../webhook/types.js';
import type { Note } from '../gitlab/types.js';
import { getEnv } from '../config/index.js';
import simpleGit from 'simple-git';

const MAX_INSTRUCTION_LENGTH = 2000;

/**
 * Get the command patterns for both BOT_NAME and BOT_USERNAME
 */
function getCommandPatterns(): RegExp[] {
  const env = getEnv();
  return [
    new RegExp(`^@${env.BOT_NAME}\\s*`, 'i'),
    new RegExp(`^@${env.BOT_USERNAME}\\s*`, 'i'),
  ];
}

/**
 * Check if a comment contains a @bot command
 */
export function isClaudeCommand(comment: string): boolean {
  return getCommandPatterns().some((pattern) => pattern.test(comment));
}

/**
 * Extract the instruction after @bot
 */
export function extractInstruction(comment: string): string | null {
  const patterns = getCommandPatterns();
  for (const pattern of patterns) {
    const match = comment.match(pattern);
    if (match) {
      const instruction = comment.slice(match[0].length).trim();
      if (instruction) {
        return instruction.slice(0, MAX_INSTRUCTION_LENGTH);
      }
    }
  }
  return null;
}

/**
 * Build system prompt for Issue comment using unified prompt system
 * Returns: { systemPrompt, userPrompt }
 */
function buildIssuePromptForComment(
  payload: NoteWebhookPayload,
  instruction: string,
  history: Note[]
): { systemPrompt: string; userPrompt: string } {
  const project = payload.project;
  const user = payload.user;

  // Format history for unified prompt
  const env = getEnv();
  const atBotName = `@${env.BOT_NAME}`;
  const atBotUsername = `@${env.BOT_USERNAME}`;
  const formattedHistory = history
    .filter((note) => {
      // Skip the current @bot comment itself
      const isBotMention = note.body.includes(atBotName) || note.body.includes(atBotUsername);
      return !(isBotMention && note.author.username === user.username);
    })
    .map((note) => ({
      author: note.author.username,
      body: note.body,
    }));

  const systemPrompt = buildSystemPrompt({
    role: 'developer',
    scenario: 'comment-issue',
    context: {
      projectPath: project.path_with_namespace,
      user: { username: user.username },
      issue: payload.issue ? {
        iid: payload.issue.iid,
        title: payload.issue.title,
      } : undefined,
      history: formattedHistory.length > 0 ? formattedHistory : undefined,
    },
  });

  return { systemPrompt, userPrompt: instruction };
}

/**
 * Build system prompt for MR comment using unified prompt system
 * Returns: { systemPrompt, userPrompt }
 */
function buildMRPromptForComment(
  projectPath: string,
  mrIid: number,
  mrTitle: string,
  sourceBranch: string,
  instruction: string,
  history: Note[]
): { systemPrompt: string; userPrompt: string } {
  // Format history for unified prompt
  const formattedHistory = history.map((note) => ({
    author: note.author.username,
    body: note.body,
  }));

  const systemPrompt = buildSystemPrompt({
    role: 'developer',
    scenario: 'comment-mr',
    context: {
      projectPath,
      mr: {
        iid: mrIid,
        title: mrTitle,
        sourceBranch,
      },
      history: formattedHistory.length > 0 ? formattedHistory : undefined,
    },
  });

  return { systemPrompt, userPrompt: instruction };
}

/**
 * Call Claude CLI and validate response
 * If response contains forbidden commands, it will retry
 */
async function callClaudeWithValidation(
  cli: ReturnType<typeof getClaudeCLI>,
  prompt: string,
  options: {
    workingDirectory?: string;
    systemPrompt?: string;
    maxRetries?: number;
  } = {}
): Promise<string> {
  const { workingDirectory, systemPrompt, maxRetries = 2 } = options;
  let currentPrompt = prompt;

  for (let i = 0; i <= maxRetries; i++) {
    const response = await cli.prompt(currentPrompt, {
      workingDirectory,
      systemPrompt,
    });

    const validation = validateResponse(response);
    if (validation.valid) {
      return response;
    }

    // Validation failed, append constraints reminder to retry generation
    currentPrompt = generateRetryPrompt(prompt, validation.reason || 'Response does not meet requirements');
    logWarn(
      { event: 'claude_response_invalid', retry: i + 1, reason: validation.reason },
      `Claude response validation failed, retrying...`
    );
  }

  throw new Error('Claude response validation failed, maximum retries reached');
}

export interface HandleCommentOptions {
  /** Note webhook payload */
  payload: NoteWebhookPayload;
  /** Additional system prompt */
  systemPrompt?: string;
}

/**
 * Handle a comment that contains @claude command
 */
export async function handleClaudeComment(
  options: HandleCommentOptions
): Promise<void> {
  const { payload, systemPrompt } = options;
  const { noteable_type } = payload.object_attributes;
  const project = payload.project;
  const noteId = payload.object_attributes.id;

  const commentBody = payload.object_attributes.note || payload.object_attributes.content;
  const instruction = extractInstruction(commentBody);

  if (!instruction) {
    logWarn(
      { event: 'claude_comment_empty', project_id: project.id },
      'Received @claude without instruction'
    );
    return;
  }

  logInfo(
    {
      event: 'claude_comment_received',
      project_id: project.id,
      noteable_type,
      note_id: noteId,
      instruction_length: instruction.length,
    },
    `Received @claude command: ${instruction.slice(0, 100)}...`
  );

  // Get env and create gitlab client early (needed for workspace setup and error reporting)
  const env = getEnv();
  const gitlab = createGitLabClient({
    baseUrl: env.GITLAB_URL,
    token: env.GITLAB_ACCESS_TOKEN,
  });
  const botName = env.BOT_NAME;

  const noteableType = payload.object_attributes.noteable_type;
  const noteableIid = noteableType === 'Issue'
    ? payload.issue?.iid || 0
    : payload.merge_request?.iid || 0;

  // Determine workspace path based on noteable type
  let workingDirectory: string | undefined;
  let workspaceType: 'issue' | 'mr' = noteableType === 'Issue' ? 'issue' : 'mr';
  let workspaceIid: number = noteableIid;

  // For MRs, try to use associated issue's workspace first
  if (noteableType === 'MergeRequest') {
    try {
      const mr = await gitlab.mergeRequests.get(project.id, noteableIid);
      const referencedIssueIids = extractIssueReferences(mr.description || '');
      if (referencedIssueIids.length > 0) {
        const workspaceManager = new WorkspaceManager();
        const issueIid = referencedIssueIids[0];
        const issueWorkspaceExists = await workspaceManager.exists(project.name, 'issue', issueIid);
        if (issueWorkspaceExists) {
          workspaceType = 'issue';
          workspaceIid = issueIid;
          logInfo(
            { event: 'mr_comment_use_issue_workspace', mr_iid: noteableIid, issue_iid: issueIid },
            `MR comment #${noteableIid} will use workspace from Issue #${issueIid}`
          );
        }
      }
    } catch (error) {
      logWarn(
        { event: 'mr_comment_get_details_failed', mr_iid: noteableIid, error },
        `Failed to get MR details for comment, will use MR workspace`
      );
    }
  }

  try {
    const workspaceManager = new WorkspaceManager();
    const exists = await workspaceManager.exists(project.name, workspaceType, workspaceIid);
    if (exists) {
      const status = await workspaceManager.getStatus(project.name, workspaceType, workspaceIid);
      if (status.exists) {
        workingDirectory = status.path;
        logDebug(
          { event: 'workspace_selected', workspacePath: workingDirectory, workspaceType, workspaceIid },
          `Using workspace for ${workspaceType} #${workspaceIid}`
        );
      }
    }

    // If workspace doesn't exist, create it
    if (!workingDirectory) {
      logInfo(
        { event: 'workspace_not_found', workspaceType, workspaceIid, projectName: project.name },
        `Workspace not found for ${workspaceType} #${workspaceIid}, creating...`
      );
      const workspace = await workspaceManager.getOrCreate({
        type: workspaceType,
        projectId: project.id,
        projectName: project.name,
        iid: workspaceIid,
        repoUrl: project.git_http_url.replace(
          'http://',
          `http://oauth2:${env.GITLAB_ACCESS_TOKEN}@`
        ),
        defaultBranch: project.default_branch,
      });
      workingDirectory = workspace.path;
      logInfo(
        { event: 'workspace_created_for_comment', workspacePath: workingDirectory },
        `Workspace created for comment`
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logWarn({ event: 'workspace_setup_failed', workspaceType, workspaceIid, error: errorMessage }, 'Failed to setup workspace');
    // Post error to user and return
    try {
      await gitlab.notes.create(
        project.id,
        noteableIid,
        `🤖 ${botName}：工作空间准备失败：${errorMessage}\n\n请稍后重试。`,
        noteableType
      );
    } catch {}
    return;
  }

  // Post initial "processing" comment
  try {
    await gitlab.notes.create(project.id, noteableIid, `🤖 ${botName} 正在处理中，请稍候...`, noteableType);
  } catch (postError) {
    const postErrorMsg = postError instanceof Error ? postError.message : String(postError);
    logWarn({ event: 'initial_comment_post_failed', error: postErrorMsg }, 'Failed to post initial processing comment');
  }

  // Fetch conversation history
  let history: Note[] = [];
  try {
    if (noteableType === 'Issue') {
      history = await gitlab.issues.getNotes(project.id, noteableIid, { sort: 'asc' });
    } else {
      history = await gitlab.mergeRequests.getNotes(project.id, noteableIid);
    }
    logDebug({ event: 'history_fetched', noteableType, count: history.length }, 'Fetched conversation history');
  } catch (error) {
    logWarn({ event: 'history_fetch_failed', error }, 'Failed to fetch conversation history');
  }

  try {
    const cli = getClaudeCLI();
    let response: string;

    // MR: Claude decides autonomously, auto-commits if code changed
    if (noteableType === 'MergeRequest') {
      const mr = await gitlab.mergeRequests.get(project.id, noteableIid);
      const sourceBranch = mr.source_branch;

      logInfo(
        { event: 'mr_processing', mrIid: noteableIid, sourceBranch, workspaceType, workspaceIid },
        `Processing MR comment: ${sourceBranch}`
      );

      // Reset workspace to remote source branch to ensure local matches remote
      const git = simpleGit(workingDirectory);
      try {
        const currentBranch = (await git.branch()).current;
        logInfo(
          { event: 'workspace_reset_branch', from: currentBranch, to: sourceBranch },
          `Resetting workspace to MR source branch`
        );
        await git.fetch('origin', sourceBranch);
        await git.reset(['--hard', `origin/${sourceBranch}`]);
        if (currentBranch !== sourceBranch) {
          await git.checkout(['-B', sourceBranch, `origin/${sourceBranch}`]).catch(async () => {
            await git.checkout(sourceBranch);
          });
        }
      } catch (branchError) {
        logWarn(
          { event: 'branch_reset_failed', error: String(branchError) },
          'Failed to reset to source branch, continuing with current branch'
        );
      }

      const { systemPrompt: builtSystemPrompt, userPrompt } = buildMRPromptForComment(project.path_with_namespace, noteableIid, mr.title, sourceBranch, instruction, history);
      logDebug({ event: 'claude_cli_call', system_prompt_length: builtSystemPrompt.length, user_prompt_length: userPrompt.length }, 'Calling Claude CLI for MR');

      response = await callClaudeWithValidation(cli, userPrompt, {
        workingDirectory,
        systemPrompt: systemPrompt || builtSystemPrompt,
      });

      // Try to parse [RESULT] structured block
      const result = parseResult(response);
      const responseText = result
        ? response.replace(/\[RESULT\][\s\S]*?\[\/RESULT\]\s*/i, '').trim()
        : response;
      const codeChanged = result?.code_changed ?? false;

      // Check for uncommitted changes and commit/push
      const status = await git.status();
      const hasChanges = !status.isClean();

      if (hasChanges || codeChanged) {
        const commitMessage = result?.commit_message || 'Update code';

        logInfo(
          { event: 'git_commit_push', branch: sourceBranch, commitMessage },
          `Committing and pushing changes to MR branch`
        );

        await git.add('.');
        await git.commit(commitMessage);
        await git.push('origin', sourceBranch, ['--force-with-lease']);

        logInfo({ event: 'git_push_completed', branch: sourceBranch }, 'Changes pushed to MR branch');
      } else {
        logInfo({ event: 'no_changes_to_commit' }, 'No changes to commit');
      }

      // Post response
      let postedResponse = '';
      if (codeChanged) {
        postedResponse = `🤖 ${botName}：

${responseText || '代码已修改并提交。'}

---

**代码变更**：${result?.summary || '代码变更'}

**提交信息**：${result?.commit_message || '更新代码'}

**分支**：${sourceBranch}`;
      } else {
        const responseContent = responseText || '已收到您的请求。';
        postedResponse = `🤖 ${botName}：

${responseContent}`;
      }

      await gitlab.notes.create(project.id, noteableIid, postedResponse, noteableType);

      logInfo(
        { event: 'claude_mr_completed', codeChanged },
        `MR comment processed, code_changed=${codeChanged}`
      );
      return;
    }

    // Issue: Claude decides autonomously
    const { systemPrompt: builtSystemPrompt, userPrompt } = buildIssuePromptForComment(payload, instruction, history);
    logDebug({ event: 'claude_cli_call', system_prompt_length: builtSystemPrompt.length, user_prompt_length: userPrompt.length }, 'Calling Claude CLI for Issue');

    response = await callClaudeWithValidation(cli, userPrompt, {
      workingDirectory,
      systemPrompt: systemPrompt || builtSystemPrompt,
    });

    // Check for uncommitted changes
    const git = simpleGit(workingDirectory);
    const status = await git.status();
    const hasChanges = !status.isClean();

    // Try to parse [RESULT] structured block
    const result = parseResult(response);
    let responseText = response;
    if (result) {
      // Remove [RESULT] block, keep only Markdown content
      responseText = response.replace(/\[RESULT\][\s\S]*?\[\/RESULT\]\s*/i, '').trim();
    }

    // If there is structured code_changed info, prefer to use it
    const codeChanged = result?.code_changed ?? hasChanges;

    if (codeChanged && payload.issue) {
      const commitMessage = result?.commit_message || 'Update code';
      const summary = result?.summary || '代码变更';

      logInfo(
        { event: 'git_commit_push', issue_iid: payload.issue.iid, commitMessage },
        `Committing and pushing changes for Issue #${payload.issue.iid}`
      );

      // Get issue details for labels (always needed for category prefix)
      const issue = await gitlab.issues.get(project.id, payload.issue.iid);

      // Extract category from issue labels for branch naming
      const labelToPrefix: Record<string, string> = {
        feature: 'feature',
        improvement: 'improvement',
        bug: 'fix',
        wontfix: 'wontfix',
        'needs-triage': 'task',
      };
      const issueLabels = issue.labels || [];
      const categoryPrefix = issueLabels
        .map((l: string) => labelToPrefix[l] || 'task')
        .find((p: string) => p !== 'task') || 'task';

      // Determine branch name: use result.branch_name if provided, otherwise generate
      let branchName: string;
      if (result?.branch_name) {
        const rawBranchName = result.branch_name;
        // Check if branch name already has a category prefix
        const hasCategoryPrefix = ['feature/', 'improvement/', 'fix/', 'wontfix/', 'task/'].some(
          prefix => rawBranchName.startsWith(prefix)
        );

        if (hasCategoryPrefix) {
          branchName = rawBranchName;
          logInfo(
            { event: 'use_branch_from_result', branchName },
            `Using branch name from RESULT (already has category prefix): ${branchName}`
          );
        } else {
          branchName = `${categoryPrefix}/${rawBranchName}`;
          logInfo(
            { event: 'use_branch_from_result_with_prefix', rawBranchName, branchName, categoryPrefix },
            `Using branch name from RESULT with added category prefix: ${branchName}`
          );
        }
      } else {
        // Generate branch name
        const shortDesc = summary
          .toLowerCase()
          .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '-')
          .replace(/-+/g, '-')
          .slice(0, 20);
        branchName = `${categoryPrefix}/issue-${payload.issue.iid}-${shortDesc}`;
      }

      // Checkout the branch (create if doesn't exist)
      try {
        // First try to checkout existing branch
        await git.checkout(branchName).catch(async () => {
          // If branch doesn't exist, create it from default branch
          await git.checkout(['-b', branchName, `origin/${project.default_branch}`]);
        });
        logInfo({ event: 'branch_checked_out', branchName }, `Checked out branch: ${branchName}`);
      } catch (branchError) {
        logWarn(
          { event: 'branch_checkout_failed', branchName, error: String(branchError) },
          `Failed to checkout branch ${branchName}, will try to push to new branch directly`
        );
      }

      // Create branch, commit and push
      await git.add('.');
      await git.commit(commitMessage);
      await git.push('origin', `HEAD:refs/heads/${branchName}`, ['--set-upstream']);

      logInfo({ event: 'git_push_completed', branch: branchName }, 'Changes pushed to new branch');

      // Create MR
      const mrTitle = `[${botName}] ${payload.issue.title} #${payload.issue.iid}`;
      const mrDescription = `此 MR 由 ${botName} 基于 Issue #${payload.issue.iid} 的评论自动创建。

**${botName} 的变更**:
${summary}

**变更文件**:
${(result?.changed_files || status.modified || []).map((f: string) => `- ${f}`).join('\n')}

**人工审查提醒**：请在合并前验证变更是否符合预期。`;

      const mr = await gitlab.client.post<{ web_url: string }>(
        `/projects/${project.id}/merge_requests`,
        {
          source_branch: branchName,
          target_branch: project.default_branch,
          title: mrTitle,
          description: mrDescription,
          remove_source_branch: false,
        }
      );

      // Post response with MR link
      const formattedResponse = `🤖 ${botName}：

${responseText || '代码已修改并提交。'}

---

**代码变更**：${summary}

**提交信息**：${commitMessage}

**分支**：${branchName}

**MR 链接**：${mr.web_url}`;

      await gitlab.notes.create(project.id, noteableIid, formattedResponse, noteableType);

      logInfo(
        { event: 'claude_issue_completed', codeChanged, mr_url: mr.web_url },
        `Issue comment processed, code_changed=${codeChanged}, MR created`
      );
    } else {
      // No changes - post response
      let responseContent = responseText.trim() || '已收到您的请求。';
      const formattedResponse = `🤖 ${botName}：

${responseContent}`;

      await gitlab.notes.create(project.id, noteableIid, formattedResponse, noteableType);

      logInfo(
        { event: 'claude_comment_response_sent', project_id: project.id, noteable_type: noteableType },
        'Claude comment response sent successfully'
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logError(
      { event: 'claude_comment_failed', project_id: project.id, error: errorMessage },
      `Failed to process @claude comment: ${errorMessage}`
    );

    // Post error message
    try {
      const errorResponse = `🤖 ${botName}：

处理失败：${errorMessage}

请稍后重试。`;

      await gitlab.notes.create(
        project.id,
        noteableIid,
        errorResponse,
        noteableType
      );
    } catch (postError) {
      const postErrorMessage = postError instanceof Error ? postError.message : String(postError);
      logError(
        { event: 'claude_error_post_failed', project_id: project.id, noteableIid, noteableType, error: postErrorMessage },
        `Failed to post error response: ${postErrorMessage}`
      );
    }
  }
}
