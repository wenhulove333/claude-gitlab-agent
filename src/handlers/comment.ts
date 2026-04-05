import { logInfo, logDebug, logError, logWarn } from '../utils/logger.js';
import { createGitLabClient } from '../gitlab/index.js';
import { getClaudeCLI } from '../claude/index.js';
import { WorkspaceManager } from '../workspace/manager.js';
import type { NoteWebhookPayload, IssueWebhookPayload } from '../webhook/types.js';
import type { Note } from '../gitlab/types.js';
import { getEnv } from '../config/index.js';
import simpleGit from 'simple-git';

// Pattern to match @claude command
const CLAUDE_COMMAND_PATTERN = /^@claude\s*/i;
const MAX_INSTRUCTION_LENGTH = 2000;

/**
 * Check if a comment contains a @claude command
 */
export function isClaudeCommand(comment: string): boolean {
  return CLAUDE_COMMAND_PATTERN.test(comment);
}

/**
 * Extract the instruction after @claude
 */
export function extractInstruction(comment: string): string | null {
  const match = comment.match(CLAUDE_COMMAND_PATTERN);
  if (!match) return null;

  const instruction = comment.slice(match[0].length).trim();
  if (!instruction) return null;

  return instruction.slice(0, MAX_INSTRUCTION_LENGTH);
}

/**
 * Build context for Claude CLI prompt
 */
function buildPromptContext(
  payload: NoteWebhookPayload,
  instruction: string,
  history: Note[]
): string {
  const { noteable_type } = payload.object_attributes;
  const project = payload.project;
  const user = payload.user;

  let context = `用户 ${user.username} 在 ${noteable_type} 中请求帮助。\n\n`;
  context += `项目：${project.path_with_namespace}\n`;
  context += `请求：${instruction}\n`;

  // Add issue/MR context if available
  if (noteable_type === 'Issue' && payload.issue) {
    context += `\nIssue 信息：\n`;
    context += `- 编号：#${payload.issue.iid}\n`;
    context += `- 标题：${payload.issue.title}\n`;
  } else if (noteable_type === 'MergeRequest' && payload.merge_request) {
    context += `\nMerge Request 信息：\n`;
    context += `- 编号：!${payload.merge_request.iid}\n`;
    context += `- 标题：${payload.merge_request.title}\n`;
  }

  // Add conversation history
  if (history.length > 0) {
    context += `\n对话历史：\n`;
    for (const note of history) {
      // Skip the current @claude comment itself
      if (note.body.includes('@claude') && note.author.username === user.username) {
        continue;
      }
      context += `- ${note.author.username}: ${note.body}\n`;
    }
  }

  return context;
}

/**
 * Build the full prompt for Claude CLI
 */
function buildIssuePrompt(
  payload: NoteWebhookPayload,
  instruction: string,
  history: Note[]
): string {
  const context = buildPromptContext(payload, instruction, history);

  const fullPrompt = `${context}

请回答用户的问题。

## 关于代码变更
**重要约束**：如果你需要修改代码，只能使用 Edit/Write 工具，禁止执行任何 git 命令。

如果你在回答过程中对项目代码做了修改（包括创建、编辑、删除文件），请在回答的最后输出以下格式的 JSON（只输出 JSON，不要有其他内容）：
{
  "code_changed": true,
  "summary": "本次变更的简要说明",
  "changed_files": ["file1.ts", "file2.ts"],
  "commit_message": "提交信息",
  "create_mr": true或false  // 如果需要创建 MR 则为 true
}

**判断标准**：
- 如果只是回答问题、解释代码、讨论方案 → 不输出 JSON
- 如果对代码做了修改，且需要创建 MR → create_mr: true
- 如果对代码做了修改，只需提交到当前分支 → create_mr: false
- 提交操作由系统自动完成`;

  return fullPrompt;
}

/**
 * Build prompt for MR - Claude decides whether to make code changes
 * If code is changed, it commits to the MR's source branch
 */
function buildMRPrompt(
  instruction: string,
  history: Note[],
  mrTitle: string,
  sourceBranch: string
): string {
  const conversationHistory = history.length > 0
    ? history.map((n) => `- ${n.author.username}: ${n.body}`).join('\n')
    : '(无)';

  return `你是一个资深开发者。请回答用户的问题，并在需要时修改代码。

## MR 信息
- MR 标题：${mrTitle}
- 源分支：${sourceBranch}

## 用户问题
${instruction}

## 对话历史
${conversationHistory}

## 关于代码变更
**重要约束**：如果你需要修改代码，只能使用 Edit/Write 工具，禁止执行任何 git 命令。

如果你在回答过程中对项目代码做了修改（包括创建、编辑、删除文件），请在回答的最后输出以下格式的 JSON（只输出 JSON，不要有其他内容）：
{
  "code_changed": true,
  "summary": "本次变更的简要说明",
  "commit_message": "提交信息（简洁描述变更内容）"
}

**判断标准**：
- 如果只是回答问题、解释代码、讨论方案 → 不输出 JSON
- 如果对代码做了修改 → 输出上述 JSON

## 提交说明
- 如果输出了 JSON，代码将被自动提交到 MR 的源分支 "${sourceBranch}"
- 请勿在代码中使用 git 命令，提交操作由系统自动完成
- 提交信息应简洁清晰

请回答用户的问题。`;
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
        `🤖 Claude：工作空间准备失败：${errorMessage}\n\n请稍后重试。`,
        noteableType
      );
    } catch {}
    return;
  }

  // Post initial "processing" comment
  try {
    await gitlab.notes.create(project.id, noteableIid, '🤖 Claude 正在处理，请稍候...', noteableType);
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

      const prompt = buildMRPrompt(instruction, history, mr.title, sourceBranch);
      logDebug({ event: 'claude_cli_call', prompt_length: prompt.length }, 'Calling Claude CLI for MR');

      response = await cli.prompt(prompt, {
        systemPrompt,
        workingDirectory,
      });

      // Check for uncommitted changes and commit/push
      const status = await git.status();
      const hasChanges = !status.isClean();

      if (hasChanges) {
        let commitMessage = 'Update code';
        const jsonMatch = response.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.commit_message) {
              commitMessage = parsed.commit_message;
            }
          } catch {
            // Not valid JSON
          }
        }

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
      const jsonMatch = response.match(/\{[\s\S]*?\}/);
      const responseText = jsonMatch ? response.replace(jsonMatch[0], '').trim() : response;
      const parsed = jsonMatch ? (() => { try { return JSON.parse(jsonMatch[0]); } catch { return null; } })() : null;

      let postedResponse = '';
      if (parsed?.code_changed) {
        postedResponse = `🤖 Claude 回复：

${responseText}

---

**代码变更**：${parsed.summary || '代码变更'}

**提交信息**：${parsed.commit_message || 'Update code'}

**分支**：${sourceBranch}`;
      } else {
        postedResponse = `🤖 Claude 回复：

${responseText}`;
      }

      await gitlab.notes.create(project.id, noteableIid, postedResponse, noteableType);

      logInfo(
        { event: 'claude_mr_completed', codeChanged: hasChanges },
        `MR comment processed, code_changed=${hasChanges}`
      );
      return;
    }

    // Issue: Claude decides autonomously
    const prompt = buildIssuePrompt(payload, instruction, history);
    logDebug({ event: 'claude_cli_call', prompt_length: prompt.length }, 'Calling Claude CLI for Issue');

    response = await cli.prompt(prompt, {
      systemPrompt,
      workingDirectory,
    });

    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    let responseText = response;
    let codeChangeInfo: { summary: string; changedFiles: string[]; commitMessage: string; createMR: boolean; branch?: string } | null = null;

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.code_changed === true && parsed.commit_message) {
          codeChangeInfo = {
            summary: parsed.summary || '代码变更',
            changedFiles: parsed.changed_files || [],
            commitMessage: parsed.commit_message,
            createMR: parsed.create_mr === true,
            branch: parsed.branch,
          };
          responseText = response.replace(jsonMatch[0], '').trim();
        }
      } catch {
        // Not valid JSON
      }
    }

    if (codeChangeInfo?.createMR && codeChangeInfo.branch) {
      const { handleCreateMR } = await import('./create-mr.js');

      logInfo(
        { event: 'create_mr_triggered', summary: codeChangeInfo.summary, branch: codeChangeInfo.branch },
        'MR creation triggered from Issue'
      );

      const formattedResponse = `🤖 Claude 回复：

${responseText}

---

**代码变更**：${codeChangeInfo.summary}

**变更文件**：
${codeChangeInfo.changedFiles.map((f) => `- ${f}`).join('\n')}

**提交信息**：${codeChangeInfo.commitMessage}

**分支**：${codeChangeInfo.branch}

正在创建 MR...`;

      await gitlab.notes.create(project.id, noteableIid, formattedResponse, noteableType);

      if (payload.issue) {
        const issuePayload: IssueWebhookPayload = {
          object_kind: 'issue',
          event_type: 'Issue Hook',
          object_attributes: {
            id: (payload.issue as any).id || 0,
            iid: payload.issue!.iid,
            title: payload.issue!.title,
            description: (payload.issue as any).description || '',
            state: ((payload.issue as any).state as any) || 'opened',
            action: 'open',
            created_at: ((payload.issue as any).created_at as string) || new Date().toISOString(),
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
      const formattedResponse = `🤖 Claude 回复：

${responseText}${codeChangeInfo ? `\n\n**代码变更**：${codeChangeInfo.summary}\n\n**变更文件**：\n${codeChangeInfo.changedFiles.map((f) => `- ${f}`).join('\n')}\n\n**提交信息**：${codeChangeInfo.commitMessage}` : ''}`;

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
      const errorResponse = `🤖 Claude 回复：

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
