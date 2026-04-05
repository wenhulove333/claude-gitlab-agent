import { logInfo, logDebug, logError, logWarn } from '../utils/logger.js';
import { createGitLabClient } from '../gitlab/index.js';
import { getClaudeCLI } from '../claude/index.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { buildPrompt, validateResponse, generateRetryPrompt, parseResult } from '../claude/prompts/index.js';
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
 * Build prompt for Issue comment using unified prompt system
 */
function buildIssuePromptForComment(
  payload: NoteWebhookPayload,
  instruction: string,
  history: Note[]
): string {
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

  return buildPrompt({
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
    task: instruction,
  });
}

/**
 * Build prompt for MR comment using unified prompt system
 */
function buildMRPromptForComment(
  projectPath: string,
  mrIid: number,
  mrTitle: string,
  sourceBranch: string,
  instruction: string,
  history: Note[]
): string {
  // Format history for unified prompt
  const formattedHistory = history.map((note) => ({
    author: note.author.username,
    body: note.body,
  }));

  return buildPrompt({
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
    task: instruction,
  });
}

/**
 * 调用 Claude CLI 并验证响应
 * 如果响应包含禁止的命令，会重新调用
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

    // 验证失败，追加约束提醒重新生成
    currentPrompt = generateRetryPrompt(prompt, validation.reason || '响应不符合要求');
    logWarn(
      { event: 'claude_response_invalid', retry: i + 1, reason: validation.reason },
      `Claude response validation failed, retrying...`
    );
  }

  throw new Error('Claude 响应验证失败，已达到最大重试次数');
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
    await gitlab.notes.create(project.id, noteableIid, `🤖 ${botName} 正在处理，请稍候...`, noteableType);
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

      const prompt = buildMRPromptForComment(project.path_with_namespace, noteableIid, mr.title, sourceBranch, instruction, history);
      logDebug({ event: 'claude_cli_call', prompt_length: prompt.length }, 'Calling Claude CLI for MR');

      response = await callClaudeWithValidation(cli, prompt, {
        workingDirectory,
        systemPrompt,
      });

      // 尝试解析 [RESULT] 结构化块
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
        postedResponse = `🤖 ${botName} 回复：

${responseText || '代码已修改并提交。'}

---

**代码变更**：${result?.summary || '代码变更'}

**提交信息**：${result?.commit_message || 'Update code'}

**分支**：${sourceBranch}`;
      } else {
        const responseContent = responseText || '已收到您的请求。';
        postedResponse = `🤖 ${botName} 回复：

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
    const prompt = buildIssuePromptForComment(payload, instruction, history);
    logDebug({ event: 'claude_cli_call', prompt_length: prompt.length }, 'Calling Claude CLI for Issue');

    response = await callClaudeWithValidation(cli, prompt, {
      workingDirectory,
      systemPrompt,
    });

    // Check for uncommitted changes
    const git = simpleGit(workingDirectory);
    const status = await git.status();
    const hasChanges = !status.isClean();

    // 尝试解析 [RESULT] 结构化块
    const result = parseResult(response);
    let responseText = response;
    if (result) {
      // 移除 [RESULT] 块，只保留 Markdown 内容
      responseText = response.replace(/\[RESULT\][\s\S]*?\[\/RESULT\]\s*/i, '').trim();
    }

    // 如果有结构化的 code_changed 信息，优先使用
    const codeChanged = result?.code_changed ?? hasChanges;
    const codeChangeInfo = result ? {
      summary: result.summary || '代码变更',
      changedFiles: result.changed_files || [],
      commitMessage: result.commit_message || 'Update code',
    } : null;

    // If there are code changes, create MR
    if (codeChanged) {
      logInfo({ event: 'code_changes_detected' }, 'Code changes detected, will create MR');

      const { handleCreateMR } = await import('./create-mr.js');

      const formattedResponse = `🤖 ${botName} 回复：

${responseText}

---

**代码变更**：${codeChangeInfo?.summary || '代码变更'}

**变更文件**：
${(codeChangeInfo?.changedFiles || status.modified || []).map((f: string) => `- ${f}`).join('\n')}

**提交信息**：${codeChangeInfo?.commitMessage || 'Update code'}

正在创建 MR...`;

      await gitlab.notes.create(project.id, noteableIid, formattedResponse, noteableType);

      if (payload.issue) {
        // Note: handleCreateMR will fetch the issue details itself to get labels for branch naming
        const issuePayload: IssueWebhookPayload = {
          object_kind: 'issue',
          event_type: 'Issue Hook',
          object_attributes: {
            id: 0,
            iid: payload.issue.iid,
            title: payload.issue.title,
            description: '',
            state: 'opened',
            action: 'open',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            labels: [],
          },
          project: payload.project,
          user: payload.user,
        };

        await handleCreateMR({ payload: issuePayload }).catch((err) => {
          logError({ event: 'create_mr_failed', error: String(err) }, 'Failed to create MR');
        });
      }
    } else {
      // No changes - post response
      let responseContent = responseText.trim() || '已收到您的请求。';
      const formattedResponse = `🤖 ${botName} 回复：

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
      const errorResponse = `🤖 ${botName} 回复：

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
