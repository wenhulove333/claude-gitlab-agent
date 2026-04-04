import { logInfo, logDebug, logError } from '../utils/logger.js';
import { createGitLabClient } from '../gitlab/index.js';
import { getClaudeCLI } from '../claude/index.js';
import type { MRWebhookPayload } from '../webhook/types.js';
import type { Diff } from '../gitlab/types.js';
import { getEnv } from '../config/index.js';

export interface ReviewResult {
  /** Blocking issues */
  blocking: Array<{
    file: string;
    line?: number;
    issue: string;
  }>;
  /** Suggested improvements */
  suggestions: Array<{
    file: string;
    line?: number;
    issue: string;
  }>;
  /** Optional optimizations */
  optimizations: Array<{
    file: string;
    line?: number;
    issue: string;
  }>;
  /** Overall summary */
  summary: string;
}

/**
 * Format diff for Claude review
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
 * Build review prompt for Claude CLI
 */
function buildReviewPrompt(
  projectPath: string,
  mrIid: number,
  mrTitle: string,
  mrDescription: string,
  diffs: Diff[]
): string {
  const diffText = formatDiffForReview(diffs);

  return `你是一个专业的代码审查员。请审查以下 Merge Request 的代码变更。

项目：${projectPath}
MR 编号：#${mrIid}
MR 标题：${mrTitle}
MR 描述：${mrDescription || '(无)'}

代码变更：
${diffText}

请从以下维度审查：
1. 逻辑错误
2. 性能问题
3. 安全隐患
4. 代码风格
5. 可读性
6. 测试覆盖

请按以下 JSON 格式输出审查结果（只输出 JSON，不要有其他内容）：
{
  "blocking": [
    {"file": "文件路径", "line": 行号, "issue": "问题描述"}
  ],
  "suggestions": [
    {"file": "文件路径", "line": 行号, "issue": "建议描述"}
  ],
  "optimizations": [
    {"file": "文件路径", "line": 行号, "issue": "优化建议"}
  ],
  "summary": "总体评价"
}`;
}

/**
 * Parse Claude's JSON response
 */
function parseReviewResponse(response: string): ReviewResult | null {
  try {
    // Try to extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      blocking: parsed.blocking || [],
      suggestions: parsed.suggestions || [],
      optimizations: parsed.optimizations || [],
      summary: parsed.summary || '',
    };
  } catch {
    return null;
  }
}

/**
 * Format review result as GitLab comment
 */
function formatReviewComment(result: ReviewResult): string {
  let comment = '🔍 **Claude 自动代码审查**\n\n';

  if (result.blocking.length > 0) {
    comment += '## 🔴 阻塞问题（必须修复）\n\n';
    for (const item of result.blocking) {
      const location = item.line ? `${item.file}:${item.line}` : item.file;
      comment += `- **${location}**: ${item.issue}\n`;
    }
    comment += '\n';
  }

  if (result.suggestions.length > 0) {
    comment += '## 🟡 建议改进\n\n';
    for (const item of result.suggestions) {
      const location = item.line ? `${item.file}:${item.line}` : item.file;
      comment += `- **${location}**: ${item.issue}\n`;
    }
    comment += '\n';
  }

  if (result.optimizations.length > 0) {
    comment += '## 🟢 优化建议（可选）\n\n';
    for (const item of result.optimizations) {
      const location = item.line ? `${item.file}:${item.line}` : item.file;
      comment += `- **${location}**: ${item.issue}\n`;
    }
    comment += '\n';
  }

  if (result.summary) {
    comment += `---\n\n${result.summary}`;
  }

  return comment;
}

/**
 * Format "no issues" comment
 */
function formatNoIssuesComment(): string {
  return '✅ **Claude 自动代码审查**\n\n未发现明显问题，代码质量良好。';
}

export interface HandleReviewOptions {
  /** MR webhook payload */
  payload: MRWebhookPayload;
  /** Claude bot username to skip self-authored MRs */
  botUsername?: string;
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
    botUsername = 'claude-bot',
    maxFiles = 20,
    projectSettings = {},
  } = options;

  const { action, iid, title, description } = payload.object_attributes;
  const project = payload.project;
  const author = payload.user;

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

  // Skip if author is the bot itself
  if (author.username === botUsername) {
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
      const comment = `🤖 **Claude 自动代码审查**\n\n此 MR 变更文件过多（${diffs.length} 个），超过自动审查上限（${maxFiles} 个），请人工审查或分批处理。`;
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
      await gitlab.mergeRequests.createNote(project.id, iid, formatNoIssuesComment());
      return;
    }

    // Build prompt and call Claude CLI
    const prompt = buildReviewPrompt(
      project.path_with_namespace,
      iid,
      title,
      description,
      filteredDiffs
    );

    const cli = getClaudeCLI();

    logDebug({ event: 'claude_review_call', mr_iid: iid }, 'Calling Claude for review');

    const response = await cli.prompt(prompt, {
      timeout: 120, // 2 minutes for review
    });

    // Parse response
    const result = parseReviewResponse(response);

    if (!result) {
      // Fallback: post raw response
      await gitlab.mergeRequests.createNote(
        project.id,
        iid,
        `🤖 **Claude 自动代码审查**\n\n${response.slice(0, 5000)}`
      );
    } else if (
      result.blocking.length === 0 &&
      result.suggestions.length === 0 &&
      result.optimizations.length === 0
    ) {
      await gitlab.mergeRequests.createNote(project.id, iid, formatNoIssuesComment());
    } else {
      const comment = formatReviewComment(result);
      await gitlab.mergeRequests.createNote(project.id, iid, comment);
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
      const errorComment = `🤖 **Claude 自动代码审查**\n\n审查失败：${errorMessage}`;
      await gitlab.mergeRequests.createNote(project.id, iid, errorComment);
    } catch (postError) {
      logError(
        { event: 'review_error_post_failed', mr_iid: iid },
        'Failed to post error comment'
      );
    }
  }
}
