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

请回答用户的问题。`;

  return fullPrompt;
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
    // Build prompt and call Claude CLI
    const prompt = buildPrompt(payload, instruction, history);
    const cli = getClaudeCLI();

    logDebug({ event: 'claude_cli_call', prompt_length: prompt.length }, 'Calling Claude CLI');

    const response = await cli.prompt(prompt, {
      systemPrompt,
      timeout: 60, // 60 seconds for Q&A
      workingDirectory,
    });

    // Format response
    const formattedResponse = `🤖 Claude 回复：

${response}`;

    // Post the response
    await gitlab.notes.create(
      project.id,
      noteableIid,
      formattedResponse,
      noteableType
    );

    logInfo(
      {
        event: 'claude_comment_response_sent',
        project_id: project.id,
        noteable_type: noteableType,
        response_length: response.length,
      },
      'Claude comment response sent successfully'
    );
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
