import { logInfo, logDebug, logError, logWarn } from '../utils/logger.js';
import { createGitLabClient } from '../gitlab/index.js';
import { getClaudeCLI } from '../claude/index.js';
import { WorkspaceManager } from '../workspace/manager.js';
import type { IssueWebhookPayload } from '../webhook/types.js';
import type { Issue, Note } from '../gitlab/types.js';
import { getEnv } from '../config/index.js';
import { AppError } from '../utils/errors.js';

// Pattern to match /create-mr command
const CREATE_MR_COMMAND_PATTERN = /^@claude\s*\/create-mr\s*/i;
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
  return CREATE_MR_COMMAND_PATTERN.test(trimmed) ||
    CREATE_MR_NL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function extractIssueContext(issue: Issue, notes: Note[]): string {
  let context = `Issue #${issue.iid}: ${issue.title}\n\n`;
  context += `描述：\n${issue.description || '(无)'}\n\n`;

  if (notes.length > 0) {
    context += `评论：\n`;
    for (const note of notes) {
      context += `- ${note.author.username}: ${note.body}\n`;
    }
  }

  return context;
}

function buildCreateMRPrompt(
  defaultBranch: string,
  issueContext: string
): string {
  return `你是一个资深开发者。你的任务是根据 Issue 内容实现代码变更并创建一个 Merge Request。

当前工作目录是项目仓库，默认分支为 ${defaultBranch}。

Issue 内容：
${issueContext}

请按以下步骤操作：
1. 分析 Issue 需求，确定需要修改/新增的文件
2. 使用 Edit/Write 工具修改代码
3. 如果存在测试命令（如 npm test、make test），运行并确保通过；若失败，尝试修复
4. 使用 Bash 工具执行：git add . && git commit -m "<提交信息> #${issueContext.match(/#(\d+)/)?.[1] || 'ISSUE'}"
5. 创建新分支名格式：claude/issue-<issue编号>-<简短描述>
6. 推送分支：git push origin HEAD:refs/heads/<分支名>

重要约束：
- 不要修改 .gitlab-ci.yml、Dockerfile、config/ 等关键文件
- 确保代码变更与 Issue 描述一致
- 提交信息要清晰描述变更内容
- 测试必须通过才能提交

完成后，请输出最终推送的分支名称，格式如下（只输出 JSON）：
{"branch": "分支名", "commit_message": "提交信息"}`;
}

function parseCreateMRResponse(response: string): { branch: string; commitMessage: string } | null {
  try {
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.branch) return null;

    return {
      branch: parsed.branch,
      commitMessage: parsed.commit_message || '',
    };
  } catch {
    return null;
  }
}

function generateMRTitle(issueTitle: string, issueIid: number): string {
  return `[Claude] ${issueTitle} #${issueIid}`;
}

function generateMRDescription(issueIid: number, claudeSummary: string, testResults?: string): string {
  let description = `此 MR 由 Claude 自动生成，基于 Issue #${issueIid}。\n\n`;

  if (claudeSummary) {
    description += `**Claude 的变更说明**：\n${claudeSummary}\n\n`;
  }

  if (testResults) {
    description += `**测试情况**：\n${testResults}\n\n`;
  }

  description += `**人工审阅提醒**：请确认变更符合预期后再合并。`;

  return description;
}

export interface HandleCreateMROptions {
  /** Issue webhook payload */
  payload: IssueWebhookPayload;
  /** Project settings */
  projectSettings?: {
    createMREnabled?: boolean;
  };
  /** Claude bot username */
  botUsername?: string;
}

/**
 * Handle /create-mr command from Issue comment
 */
export async function handleCreateMR(
  options: HandleCreateMROptions
): Promise<void> {
  const { payload, projectSettings = {} } = options;
  const { iid, title, state } = payload.object_attributes;
  const project = payload.project;
  const author = payload.user;

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
    await gitlab.issues.createNote(project.id, iid, '🤖 Claude 正在处理，请稍候...（这可能需要几分钟）');

    // Get issue details and notes for context
    const issue = await gitlab.issues.get(project.id, iid);
    const notes = await gitlab.issues.getNotes(project.id, iid, { sort: 'asc' });

    // Build context
    const issueContext = extractIssueContext(issue, notes);

    // Get or create workspace
    const workspaceManager = new WorkspaceManager();
    const workspace = await workspaceManager.getOrCreate({
      type: 'issue',
      projectId: project.id,
      iid,
      repoUrl: project.git_http_url.replace('http://', `http://oauth2:${env.GITLAB_ACCESS_TOKEN}@`),
      defaultBranch: project.default_branch,
    });

    logInfo(
      { event: 'workspace_ready', workspace_id: workspace.id, path: workspace.path },
      'Workspace ready for code generation'
    );

    // Build prompt and call Claude CLI
    const prompt = buildCreateMRPrompt(
      project.default_branch,
      issueContext
    );

    const cli = getClaudeCLI();

    logDebug({ event: 'claude_cli_call', issue_iid: iid }, 'Calling Claude CLI for code generation');

    const response = await cli.prompt(prompt, {
      workingDirectory: workspace.path,
      timeout: 300, // 5 minutes for code generation
    });

    // Parse response
    const result = parseCreateMRResponse(response);

    if (!result) {
      throw new AppError('无法解析 Claude 的响应，请检查 Issue 描述是否清晰', 'PARSE_ERROR');
    }

    logInfo(
      { event: 'branch_created', issue_iid: iid, branch: result.branch },
      `Branch ${result.branch} created and pushed`
    );

    // Create MR
    const mrTitle = generateMRTitle(issue.title, issue.iid);
    const mrDescription = generateMRDescription(issue.iid, result.commitMessage);

    const mr = await gitlab.client.post<{ web_url: string }>(
      `/projects/${project.id}/merge_requests`,
      {
        source_branch: result.branch,
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
      `🤖 Claude 已创建 MR！\n\n**MR 链接**：${mrLink}\n\n请审阅后合并。`
    );

    logInfo(
      { event: 'mr_created', issue_iid: iid, mr_url: mrLink },
      'MR created successfully'
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logError(
      { event: 'create_mr_failed', issue_iid: iid, error: errorMessage },
      `Create MR failed: ${errorMessage}`
    );

    // Post error message
    try {
      let userMessage = `创建 MR 失败：${errorMessage}`;

      if (errorMessage.includes('timeout') || errorMessage.includes('超时')) {
        userMessage = `创建 MR 超时：任务执行时间过长，请尝试简化需求或手动实现。`;
      } else if (errorMessage.includes('无法解析')) {
        userMessage = `创建 MR 失败：Issue 描述不够清晰，请补充具体修改点后再试。`;
      }

      await gitlab.issues.createNote(project.id, iid, `🤖 Claude：${userMessage}`);
    } catch (postError) {
      logError(
        { event: 'create_mr_error_post_failed', issue_iid: iid },
        'Failed to post error message'
      );
    }
  }
}
