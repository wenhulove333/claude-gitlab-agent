import { logInfo, logDebug, logError, logWarn } from '../utils/logger.js';
import { createGitLabClient } from '../gitlab/index.js';
import { getClaudeCLI } from '../claude/index.js';
import { WorkspaceManager } from '../workspace/manager.js';
import type { NoteWebhookPayload } from '../webhook/types.js';
import type { Note } from '../gitlab/types.js';
import { getEnv } from '../config/index.js';

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
function buildPrompt(
  payload: NoteWebhookPayload,
  instruction: string,
  history: Note[]
): string {
  const context = buildPromptContext(payload, instruction, history);

  const fullPrompt = `${context}

请回答用户的问题。

## 重要提醒
如果你在回答过程中对项目代码做了任何修改（包括创建、编辑、删除文件），请在回答的最后输出以下格式的 JSON（只输出 JSON，不要有其他内容）：
{
  "code_changed": true,
  "summary": "本次变更的简要说明",
  "changed_files": ["file1.ts", "file2.ts"],
  "commit_message": "提交信息"
}

如果没有任何代码变更，则不需要输出 JSON。`;

  return fullPrompt;
}

/**
 * Patterns that indicate the user wants code changes
 */
const CODE_CHANGE_PATTERNS = [
  /修改|改动|改变|调整/,
  /修复|解决|bug/,
  /添加|新增|实现|功能/,
  /重构|优化|改进/,
  /帮我|帮我做|帮我改/,
  /写.*代码|写个|写一下/,
  /代码.*修改|代码.*改动/,
  /根据.*改|按照.*改/,
  /implement|fix|add|change|modify|update|rewrite|refactor/,
  /write.*code|create.*file|edit.*file/,
];

/**
 * Check if the instruction is asking for code changes
 */
function isCodeChangeRequest(instruction: string): boolean {
  return CODE_CHANGE_PATTERNS.some((pattern) => pattern.test(instruction));
}

/**
 * Build prompt for code change requests - Claude only writes files, no git commands
 */
function buildCodeChangePrompt(
  payload: NoteWebhookPayload,
  instruction: string,
  history: Note[]
): string {
  const { noteable_type } = payload.object_attributes;
  const project = payload.project;

  let projectPath = project.path_with_namespace;
  let defaultBranch = project.default_branch;
  let issueOrMrInfo = '';

  if (noteable_type === 'Issue' && payload.issue) {
    defaultBranch = project.default_branch || 'main';
    issueOrMrInfo = `Issue 编号：#${payload.issue.iid}\n`;
  } else if (noteable_type === 'MergeRequest' && payload.merge_request) {
    defaultBranch = project.default_branch || 'main';
    issueOrMrInfo = `MR 编号：!${payload.merge_request.iid}\n`;
  }

  const conversationHistory = history.length > 0
    ? history.map((n) => `- ${n.author.username}: ${n.body}`).join('\n')
    : '(无)';

  return `你是一个资深开发者。你的任务是：根据用户需求实现代码变更。

## 项目信息
- 项目路径：${projectPath}
- 默认分支：${defaultBranch}
${issueOrMrInfo}

## 用户需求
${instruction}

## 对话历史
${conversationHistory}

## 重要约束
1. **只使用 Edit/Write 工具编写代码，不要执行任何 git 命令**
2. 不要修改 .gitlab-ci.yml、Dockerfile、config/ 等关键文件（除非需求明确要求）
3. 确保代码变更与需求描述一致
4. 如果有测试，运行测试确保通过

## 工作目录
当前工作目录是项目仓库的根目录。仓库已经在默认分支上，干净状态。

## 输出要求
完成代码编写后，请输出以下格式的 JSON（只输出 JSON，不要有其他内容）：
{
  "summary": "本次变更的简要说明",
  "changed_files": ["file1.ts", "file2.ts"],
  "commit_message": "提交信息（格式：<动词> <内容>）"
}

例如：
{
  "summary": "修复了登录按钮的空指针异常",
  "changed_files": ["src/components/LoginButton.tsx", "src/utils/auth.ts"],
  "commit_message": "Fix login button null pointer"
}`;
}

/**
 * Parse code change response JSON
 */
function parseCodeChangeResponse(response: string): {
  summary: string;
  changedFiles: string[];
  commitMessage: string;
} | null {
  try {
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.summary || !parsed.changed_files || !parsed.commit_message) {
      return null;
    }

    return {
      summary: parsed.summary,
      changedFiles: parsed.changed_files,
      commitMessage: parsed.commit_message,
    };
  } catch {
    return null;
  }
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

  // Check if this is a code change request
  const isCodeChange = isCodeChangeRequest(instruction);
  logInfo(
    { event: 'request_type_detected', isCodeChange, instruction: instruction.slice(0, 50) },
    `Request type: ${isCodeChange ? 'code change' : 'Q&A'}`
  );

  try {
    // Build prompt based on request type
    const prompt = isCodeChange
      ? buildCodeChangePrompt(payload, instruction, history)
      : buildPrompt(payload, instruction, history);

    const cli = getClaudeCLI();

    // Use longer timeout for code generation
    const timeout = isCodeChange ? 180 : 60;

    logDebug({ event: 'claude_cli_call', prompt_length: prompt.length, isCodeChange }, 'Calling Claude CLI');

    const response = await cli.prompt(prompt, {
      systemPrompt,
      timeout,
      workingDirectory,
    });

    // Handle code change response
    if (isCodeChange) {
      const parsed = parseCodeChangeResponse(response);
      if (!parsed) {
        // If can't parse JSON, just post the raw response
        const formattedResponse = `🤖 Claude 回复：

${response}`;
        await gitlab.notes.create(
          project.id,
          noteableIid,
          formattedResponse,
          noteableType
        );
        logInfo(
          { event: 'claude_code_response_raw', response_length: response.length },
          'Code change response posted as raw text'
        );
        return;
      }

      // Post the summary
      const summaryResponse = `🤖 Claude 已完成代码编写！

**变更说明**：${parsed.summary}

**变更文件**：
${parsed.changedFiles.map((f) => `- ${f}`).join('\n')}

**提交信息**：${parsed.commitMessage}

正在提交代码...`;

      await gitlab.notes.create(
        project.id,
        noteableIid,
        summaryResponse,
        noteableType
      );

      logInfo(
        {
          event: 'claude_code_completed',
          changedFiles: parsed.changedFiles,
          commitMessage: parsed.commitMessage,
        },
        'Code change completed, summary posted'
      );
    } else {
      // Handle Q&A response - check if Claude made code changes
      // First, extract any JSON from the response
      const jsonMatch = response.match(/\{[\s\S]*?\}/);
      let responseText = response;
      let codeChangeInfo: { summary: string; changedFiles: string[]; commitMessage: string } | null = null;

      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.code_changed === true && parsed.commit_message) {
            codeChangeInfo = {
              summary: parsed.summary || '代码变更',
              changedFiles: parsed.changed_files || [],
              commitMessage: parsed.commit_message,
            };
            // Remove the JSON from the response text
            responseText = response.replace(jsonMatch[0], '').trim();
          }
        } catch {
          // Not valid JSON, treat as regular response
        }
      }

      // Post the response
      const formattedResponse = `🤖 Claude 回复：

${responseText}${codeChangeInfo ? `\n\n**代码变更**：${codeChangeInfo.summary}\n\n**变更文件**：\n${codeChangeInfo.changedFiles.map((f) => `- ${f}`).join('\n')}\n\n**提交信息**：${codeChangeInfo.commitMessage}` : ''}`;

      await gitlab.notes.create(
        project.id,
        noteableIid,
        formattedResponse,
        noteableType
      );

      if (codeChangeInfo) {
        logInfo(
          {
            event: 'claude_qa_with_code_change',
            summary: codeChangeInfo.summary,
            changedFiles: codeChangeInfo.changedFiles,
          },
          'Q&A response with code changes detected'
        );
      } else {
        logInfo(
          {
            event: 'claude_comment_response_sent',
            project_id: project.id,
            noteable_type: noteableType,
            response_length: response.length,
          },
          'Claude comment response sent successfully'
        );
      }
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
