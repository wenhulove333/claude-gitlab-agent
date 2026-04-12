import { logInfo, logDebug, logError } from '../utils/logger.js';
import { createGitLabClient } from '../gitlab/index.js';
import { getClaudeCLI } from '../claude/index.js';
import { WorkspaceManager } from '../workspace/manager.js';
import {
  gitStatus,
  gitAdd,
  gitCommit,
  gitCreateBranch,
  gitPush,
} from '../claude/executor.js';
import type { IssueWebhookPayload } from '../webhook/types.js';
import type { Issue, Note } from '../gitlab/types.js';
import { getEnv } from '../config/index.js';
import { AppError } from '../utils/errors.js';

/**
 * Generate code based on Issue and create MR
 * Claude only writes code, git operations are handled externally
 */
export interface CodeGenerationResult {
  success: boolean;
  branchName?: string;
  commitMessage?: string;
  changedFiles?: string[];
  error?: string;
}

export interface GenerateCodeAndMROptions {
  /** Issue webhook payload */
  payload: IssueWebhookPayload;
  /** Project settings */
  projectSettings?: {
    createMREnabled?: boolean;
  };
}

/**
 * Get issue context including description and comments
 */
async function getIssueContext(
  gitlab: ReturnType<typeof createGitLabClient>,
  projectId: number,
  issueIid: number
): Promise<{ issue: Issue; notes: Note[] }> {
  const issue = await gitlab.issues.get(projectId, issueIid);
  const notes = await gitlab.issues.getNotes(projectId, issueIid, { sort: 'asc' });
  return { issue, notes };
}

/**
 * Build a prompt for Claude that tells it to ONLY write files
 */
function buildCodeGenerationPrompt(
  projectPath: string,
  defaultBranch: string,
  issueTitle: string,
  issueDescription: string,
  issueIid: number,
  conversationHistory: string
): string {
  return `你是一个资深开发者。你的任务是根据 Issue 内容实现代码变更。

## 项目信息
- 项目路径：${projectPath}
- 默认分支：${defaultBranch}
- Issue 编号：#${issueIid}

## Issue 内容
标题：${issueTitle}
描述：${issueDescription || '(无)'}

## 对话历史
${conversationHistory}

## 重要约束
1. **只使用 Edit/Write 工具编写代码，不要执行任何 git 命令**
2. 不要修改 .gitlab-ci.yml、Dockerfile、config/ 等关键文件（除非 Issue 明确要求）
3. 确保代码变更与 Issue 描述一致
4. 如果有测试，运行测试确保通过

## 工作目录
当前工作目录是项目仓库的根目录。仓库已经在默认分支上，干净状态。

## 输出要求
完成代码编写后，请输出以下格式的 JSON（只输出 JSON，不要有其他内容）：
{
  "summary": "本次变更的简要说明",
  "changed_files": ["file1.ts", "file2.ts"],
  "commit_message": "提交信息（格式：<动词> <内容> #${issueIid}）"
}

例如：
{
  "summary": "修复了登录按钮的空指针异常",
  "changed_files": ["src/components/LoginButton.tsx", "src/utils/auth.ts"],
  "commit_message": "Fix login button null pointer #${issueIid}"
}`;
}

/**
 * Parse Claude's JSON response
 */
function parseCodeGenerationResponse(response: string): {
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

/**
 * Main function: Generate code and create MR
 */
export async function generateCodeAndCreateMR(
  options: GenerateCodeAndMROptions
): Promise<CodeGenerationResult> {
  const { payload, projectSettings = {} } = options;
  const { iid, title, state } = payload.object_attributes;
  const project = payload.project;
  const author = payload.user;

  // Check if create MR is enabled
  if (projectSettings.createMREnabled === false) {
    return { success: false, error: 'Create MR feature is disabled' };
  }

  // Issue must be opened
  if (state !== 'opened') {
    return { success: false, error: `Issue status is ${state}, cannot create MR` };
  }

  logInfo(
    {
      event: 'code_generation_started',
      project_id: project.id,
      issue_iid: iid,
      title,
      author: author.username,
    },
    `Starting code generation for Issue #${iid}`
  );

  const env = getEnv();
  const gitlab = createGitLabClient({
    baseUrl: env.GITLAB_URL,
    token: env.GITLAB_ACCESS_TOKEN,
  });

  // Generate branch name
  const shortDesc = title.slice(0, 30).replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-');
  const branchName = `claude/issue-${iid}-${shortDesc}`;

  try {
    // Get issue context
    const { issue, notes } = await getIssueContext(gitlab, project.id, iid);

    // Build conversation history
    const conversationHistory = notes
      .filter((n) => n.author.username !== author.username || !n.body.includes('@claude'))
      .map((n) => `- ${n.author.username}: ${n.body}`)
      .join('\n') || '(无)';

    // Prepare workspace
    const workspaceManager = new WorkspaceManager();
    const workspace = await workspaceManager.getOrCreate({
      type: 'issue',
      projectId: project.id,
      projectName: project.name,
      iid,
      repoUrl: project.git_http_url.replace(
        'http://',
        `http://oauth2:${env.GITLAB_ACCESS_TOKEN}@`
      ),
      defaultBranch: project.default_branch,
    });

    logInfo(
      { event: 'workspace_ready', workspace_path: workspace.path },
      'Workspace ready'
    );

    // Build prompt
    const prompt = buildCodeGenerationPrompt(
      project.path_with_namespace,
      project.default_branch,
      issue.title,
      issue.description || '',
      issue.iid,
      conversationHistory
    );

    // Call Claude
    const cli = getClaudeCLI();
    logDebug({ event: 'claude_code_generation', issue_iid: iid }, 'Calling Claude for code generation');

    const response = await cli.prompt(prompt, {
      workingDirectory: workspace.path,
      timeout: 300, // 5 minutes
    });

    // Parse response
    const parsed = parseCodeGenerationResponse(response);
    if (!parsed) {
      throw new AppError('Failed to parse Claude response', 'PARSE_ERROR');
    }

    logInfo(
      { event: 'code_generated', changed_files: parsed.changedFiles },
      'Code generated successfully'
    );

    // === External git operations ===

    // Check git status first
    const statusResult = await gitStatus(workspace.path);
    if (!statusResult.success) {
      throw new AppError(`Git status failed: ${statusResult.error}`, 'GIT_ERROR');
    }

    const changedFiles = statusResult.output.trim().split('\n').filter(Boolean);
    if (changedFiles.length === 0) {
      throw new AppError('Claude did not generate any code changes', 'NO_CHANGES');
    }

    // Create new branch
    const branchResult = await gitCreateBranch(workspace.path, branchName);
    if (!branchResult.success) {
      throw new AppError(`Failed to create branch: ${branchResult.error}`, 'GIT_ERROR');
    }

    // Stage changes
    const addResult = await gitAdd(workspace.path);
    if (!addResult.success) {
      throw new AppError(`Git add failed: ${addResult.error}`, 'GIT_ERROR');
    }

    // Commit
    const commitResult = await gitCommit(workspace.path, parsed.commitMessage);
    if (!commitResult.success) {
      throw new AppError(`Git commit failed: ${commitResult.error}`, 'GIT_ERROR');
    }

    // Push
    const pushResult = await gitPush(workspace.path, branchName);
    if (!pushResult.success) {
      throw new AppError(`Git push failed: ${pushResult.error}`, 'GIT_ERROR');
    }

    logInfo(
      { event: 'branch_pushed', branchName },
      'Branch pushed successfully'
    );

    // Create MR via GitLab API
    const mrTitle = `[Claude] ${issue.title} #${issue.iid}`;
    const mrDescription = `This MR was automatically generated by Claude based on Issue #${issue.iid}.

**Claude's Changes**:
${parsed.summary}

**Changed Files**:
${parsed.changedFiles.map((f) => `- ${f}`).join('\n')}

**Manual Review Reminder**: Please verify the changes meet expectations before merging.`;

    const mr = await gitlab.client.post<{ web_url: string; iid: number }>(
      `/projects/${project.id}/merge_requests`,
      {
        source_branch: branchName,
        target_branch: project.default_branch,
        title: mrTitle,
        description: mrDescription,
        remove_source_branch: false,
      }
    );

    logInfo(
      { event: 'mr_created', mr_url: mr.web_url },
      'MR created successfully'
    );

    // Reply to issue
    await gitlab.issues.createNote(
      project.id,
      iid,
      `🤖 Claude has completed code implementation and created an MR!\n\n**MR Link**: ${mr.web_url}\n\n**Changes**: ${parsed.summary}`
    );

    return {
      success: true,
      branchName,
      commitMessage: parsed.commitMessage,
      changedFiles: parsed.changedFiles,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logError(
      { event: 'code_generation_failed', issue_iid: iid, error: errorMessage },
      `Code generation failed: ${errorMessage}`
    );

    // Try to post error comment
    try {
      await gitlab.issues.createNote(
        project.id,
        iid,
        `🤖 Claude: Code generation failed\n\n${errorMessage}`
      );
    } catch {
      // ignore
    }

    return { success: false, error: errorMessage };
  }
}
