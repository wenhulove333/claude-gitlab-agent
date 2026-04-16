import { logInfo, logDebug, logError, logWarn } from '../utils/logger.js';
import { createGitLabClient } from '../gitlab/index.js';
import { getClaudeCLI } from '../claude/index.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { buildSystemPrompt, validateResponse, generateRetryPrompt, parseResult } from '../claude/prompts/index.js';
import type { NoteWebhookPayload, IssueWebhookPayload } from '../webhook/types.js';
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
  try {
    const workspaceManager = new WorkspaceManager();
    const workspaceType = noteableType === 'Issue' ? 'issue' : 'mr';
    const exists = await workspaceManager.exists(project.name, workspaceType, noteableIid);
    if (exists) {
      const status = await workspaceManager.getStatus(project.name, workspaceType, noteableIid);
      if (status.exists) {
        workingDirectory = status.path;
        logDebug(
          { event: 'workspace_selected', workspacePath: workingDirectory, noteableType, noteableIid },
          `Using workspace for ${noteableType} #${noteableIid}`
        );
      }
    }

    // If workspace doesn't exist, create it
    if (!workingDirectory) {
      logInfo(
        { event: 'workspace_not_found', noteableType, noteableIid, projectName: project.name },
        `Workspace not found for ${noteableType} #${noteableIid}, creating...`
      );
      const workspace = await workspaceManager.getOrCreate({
        type: workspaceType,
        projectId: project.id,
        projectName: project.name,
        iid: noteableIid,
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
    logWarn({ event: 'workspace_setup_failed', noteableType, noteableIid, error: errorMessage }, 'Failed to setup workspace');
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
        { event: 'mr_processing', mrIid: noteableIid, sourceBranch },
        `Processing MR comment: ${sourceBranch}`
      );

      // Switch to source branch if needed
      const git = simpleGit(workingDirectory);
      try {
        const currentBranch = (await git.branch()).current;
        if (currentBranch !== sourceBranch) {
          logInfo(
            { event: 'workspace_switch_branch', from: currentBranch, to: sourceBranch },
            `Switching workspace to MR source branch`
          );
          await git.fetch('origin', sourceBranch);
          await git.checkout(['-B', sourceBranch, `origin/${sourceBranch}`]).catch(async () => {
            await git.checkout(sourceBranch);
          });
        }
      } catch (branchError) {
        logWarn(
          { event: 'branch_switch_failed', error: String(branchError) },
          'Failed to switch to source branch, continuing with current branch'
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

      // Get issue details for labels and branch naming
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

      // Generate branch name
      const shortDesc = summary
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 20);
      const branchName = `${categoryPrefix}/issue-${payload.issue.iid}-${shortDesc}`;

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
