import { logInfo, logDebug, logError, logWarn } from '../utils/logger.js';
import { createGitLabClient } from '../gitlab/index.js';
import { getClaudeCLI } from '../claude/index.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { buildPrompt, parseCreateMRResponse, validateResponse, generateRetryPrompt } from '../claude/prompts/index.js';
import type { IssueWebhookPayload } from '../webhook/types.js';
import { getEnv, getProjectSettings } from '../config/index.js';
import { AppError } from '../utils/errors.js';
import simpleGit from 'simple-git';

// Natural language patterns that indicate MR creation intent
const CREATE_MR_NL_PATTERNS = [
  /创建\s*(一个)?\s*MR/i,
  /创建\s*(一个)?\s*merge\s*request/i,
  /帮我实现.*并提(交|个)\s*MR/i,
  /根据.*创建\s*MR/i,
  /implement.*and\s*create\s*MR/i,
  /create\s*MR\s*for/i,
];

export function isCreateMRCommand(comment: string): boolean {
  const trimmed = comment.trim();
  const botName = getEnv().BOT_NAME;
  const commandPattern = new RegExp(`^@${botName}\\s*\\/create-mr\\s*`, 'i');
  return commandPattern.test(trimmed) ||
    CREATE_MR_NL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function generateMRTitle(issueTitle: string, issueIid: number, botName: string): string {
  return `[${botName}] ${issueTitle} #${issueIid}`;
}

function generateMRDescription(issueIid: number, botName: string, claudeSummary: string, testResults?: string): string {
  let description = `此 MR 由 ${botName} 基于 Issue #${issueIid} 自动创建。\n\n`;

  if (claudeSummary) {
    description += `**${botName} 的变更**:\n${claudeSummary}\n\n`;
  }

  if (testResults) {
    description += `**测试结果**:\n${testResults}\n\n`;
  }

  description += `**人工审查提醒**：请在合并前验证变更是否符合预期。`;

  return description;
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
    timeout?: number;
    maxRetries?: number;
  } = {}
): Promise<string> {
  const { workingDirectory, timeout = 300, maxRetries = 2 } = options;
  let currentPrompt = prompt;

  for (let i = 0; i <= maxRetries; i++) {
    const response = await cli.prompt(currentPrompt, {
      workingDirectory,
      timeout,
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

export interface HandleCreateMROptions {
  /** Issue webhook payload */
  payload: IssueWebhookPayload;
  /** Project settings */
  projectSettings?: {
    createMREnabled?: boolean;
  };
  /** Bot username */
  botUsername?: string;
  /** Bot display name */
  botName?: string;
}

/**
 * Handle /create-mr command from Issue comment
 */
export async function handleCreateMR(
  options: HandleCreateMROptions
): Promise<void> {
  const { payload, projectSettings = {}, botName } = options;
  const { iid, title, state } = payload.object_attributes;
  const project = payload.project;
  const author = payload.user;

  // Get bot name from project settings if not provided
  const effectiveBotName = botName || (await getProjectSettings(project.id)).botName;

  // Check if create MR is enabled
  if (projectSettings.createMREnabled === false) {
    logWarn(
      { event: 'create_mr_disabled', project_id: project.id },
      'Create MR is disabled for this project'
    );
    return;
  }

  // Issue must be opened
  if (state !== 'opened') {
    logWarn(
      { event: 'issue_not_opened', issue_iid: iid, state },
      'Cannot create MR for closed issue'
    );
    return;
  }

  logInfo(
    {
      event: 'create_mr_started',
      project_id: project.id,
      issue_iid: iid,
      title,
      author: author.username,
    },
    `Starting Create MR for Issue #${iid}`
  );

  const env = getEnv();
  const gitlab = createGitLabClient({
    baseUrl: env.GITLAB_URL,
    token: env.GITLAB_ACCESS_TOKEN,
  });

  try {
    // Post initial response
    await gitlab.issues.createNote(project.id, iid, `🤖 ${effectiveBotName} 正在处理中，请稍候...（可能需要几分钟）`);

    // Get issue details and notes for context
    const issue = await gitlab.issues.get(project.id, iid);
    const notes = await gitlab.issues.getNotes(project.id, iid, { sort: 'asc' });

    // Extract category from issue labels for branch naming
    // Map label to branch prefix
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

    // Build context
    const workspaceManager = new WorkspaceManager();
    const workspace = await workspaceManager.getOrCreate({
      type: 'issue',
      projectId: project.id,
      projectName: project.name,
      iid,
      repoUrl: project.git_http_url.replace('http://', `http://oauth2:${env.GITLAB_ACCESS_TOKEN}@`),
      defaultBranch: project.default_branch,
    });

    logInfo(
      { event: 'workspace_ready', workspace_id: workspace.id, path: workspace.path },
      'Workspace ready for code generation'
    );

    // Build prompt and call Claude CLI
    const issueContext = `Issue #${issue.iid}: ${issue.title}\n\n描述：\n${issue.description || '(无)'}\n\n评论：\n${notes.map((n) => `- ${n.author.username}: ${n.body}`).join('\n') || '(无)'}`;
    const prompt = buildPrompt({
      role: 'developer',
      scenario: 'create-mr',
      context: {
        projectPath: project.path_with_namespace,
        issue: {
          iid: issue.iid,
          title: issue.title,
          description: issueContext,
        },
      },
    });

    const cli = getClaudeCLI();

    logDebug({ event: 'claude_cli_call', issue_iid: iid }, 'Calling Claude CLI for code generation');

    const response = await callClaudeWithValidation(cli, prompt, {
      workingDirectory: workspace.path,
      timeout: 300,
    });

    // Parse response
    const result = parseCreateMRResponse(response);

    if (!result) {
      throw new AppError('Failed to parse Claude response. Please check if the Issue description is clear', 'PARSE_ERROR');
    }

    // Check for uncommitted changes
    const git = simpleGit(workspace.path);
    const status = await git.status();
    const hasChanges = !status.isClean();

    if (!hasChanges) {
      throw new AppError('Claude did not modify any code, cannot create MR', 'NO_CHANGES');
    }

    // Generate branch name using category prefix
    const shortDesc = result.summary
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 20);
    const branchName = `${categoryPrefix}/issue-${iid}-${shortDesc}`;

    // Commit changes
    await git.add('.');
    await git.commit(result.commitMessage || `Update code #${iid}`);

    // Push to create the branch
    await git.push('origin', `HEAD:refs/heads/${branchName}`, ['--set-upstream']);

    logInfo(
      { event: 'branch_created', issue_iid: iid, branch: branchName },
      `Branch ${branchName} created and pushed`
    );

    // Create MR
    const mrTitle = generateMRTitle(issue.title, issue.iid, effectiveBotName);
    const mrDescription = generateMRDescription(issue.iid, effectiveBotName, result.summary);

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

    // Reply to issue with MR link
    const mrLink = mr.web_url;
    await gitlab.issues.createNote(
      project.id,
      iid,
      `🤖 ${effectiveBotName} 已创建 MR！\n\n**MR 链接**：${mrLink}\n\n请审查并合并。`
    );

    // Add mr-created label to the issue
    try {
      await gitlab.issues.addLabels(project.id, iid, ['mr-created']);
      logInfo(
        { event: 'issue_label_added', issue_iid: iid, label: 'mr-created' },
        `Added label 'mr-created' to Issue #${iid}`
      );
    } catch (labelError) {
      logWarn(
        { event: 'issue_label_add_failed', issue_iid: iid, error: labelError },
        `Failed to add label 'mr-created' to Issue #${iid}`
      );
    }

    logInfo(
      { event: 'mr_created', issue_iid: iid, mr_url: mrLink },
      'MR created successfully'
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logError(
      { event: 'create_mr_failed', issue_iid: iid, error: errorMessage },
      `创建 MR 失败：${errorMessage}`
    );

    // Post error message
    try {
      let userMessage = `创建 MR 失败：${errorMessage}`;

      if (errorMessage.includes('timeout') || errorMessage.includes('超时')) {
        userMessage = `创建 MR 超时：任务执行时间过长，请简化需求或手动实现。`;
      } else if (errorMessage.includes('无法解析') || errorMessage.includes('parse')) {
        userMessage = `创建 MR 失败：Issue 描述不够清晰，请补充更多细节后重试。`;
      }

      await gitlab.issues.createNote(project.id, iid, `🤖 ${effectiveBotName}：${userMessage}`);
    } catch (postError) {
      logError(
        { event: 'create_mr_error_post_failed', issue_iid: iid },
        'Failed to post error message'
      );
    }
  }
}
