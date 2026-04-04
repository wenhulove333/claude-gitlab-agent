import { logInfo, logDebug, logError, logWarn } from '../utils/logger.js';
import { createGitLabClient } from '../gitlab/index.js';
import { getClaudeCLI } from '../claude/index.js';
import type { NoteWebhookPayload } from '../webhook/types.js';
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
  instruction: string
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

  return context;
}

/**
 * Build the full prompt for Claude CLI
 */
function buildPrompt(
  payload: NoteWebhookPayload,
  instruction: string
): string {
  const context = buildPromptContext(payload, instruction);

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

  // Post initial "processing" comment
  const env = getEnv();
  const gitlab = createGitLabClient({
    baseUrl: env.GITLAB_URL,
    token: env.GITLAB_ACCESS_TOKEN,
  });

  const noteableType = payload.object_attributes.noteable_type;
  const noteableIid = noteableType === 'Issue'
    ? payload.issue?.iid || 0
    : payload.merge_request?.iid || 0;

  try {
    // Post initial response
    await gitlab.notes.create(project.id, noteableIid, '🤖 Claude 正在处理，请稍候...', noteableType);

    // Build prompt and call Claude CLI
    const prompt = buildPrompt(payload, instruction);
    const cli = getClaudeCLI();

    logDebug({ event: 'claude_cli_call', prompt_length: prompt.length }, 'Calling Claude CLI');

    const response = await cli.prompt(prompt, {
      systemPrompt,
      timeout: 60, // 60 seconds for Q&A
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
      logError(
        { event: 'claude_error_post_failed', project_id: project.id },
        'Failed to post error response'
      );
    }
  }
}
