import { logInfo, logError, logDebug } from '../utils/logger.js';
import { createGitLabClient } from '../gitlab/index.js';
import { getClaudeCLI } from '../claude/index.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { buildAnalyzeIssuePrompt, parseIssueCategory, parseStructuredIssueAnalysis } from '../claude/prompts/index.js';
import type { IssueWebhookPayload } from '../webhook/types.js';
import { getEnv } from '../config/index.js';

export interface AnalyzeIssueResult {
  success: boolean;
  category?: string;
  error?: string;
}

export interface AnalyzeIssueOptions {
  /** Issue webhook payload */
  payload: IssueWebhookPayload;
  /** Optional pre-created workspace path */
  workspacePath?: string;
}

export async function analyzeIssue(
  options: AnalyzeIssueOptions
): Promise<AnalyzeIssueResult> {
  const { payload, workspacePath } = options;
  const { iid, title, description } = payload.object_attributes;
  const project = payload.project;

  logInfo(
    { event: 'analyze_issue_started', project_id: project.id, issue_iid: iid, title },
    `Starting issue analysis for #${iid}`
  );

  const env = getEnv();
  const gitlab = createGitLabClient({
    baseUrl: env.GITLAB_URL,
    token: env.GITLAB_ACCESS_TOKEN,
  });

  // Get workspace path if not provided
  let workingDirectory = workspacePath;
  if (!workingDirectory) {
    const workspaceManager = new WorkspaceManager();
    try {
      const workspace = await workspaceManager.getOrCreate({
        type: 'issue',
        projectId: project.id,
        projectName: project.name,
        iid,
        repoUrl: project.git_http_url.replace('http://', `http://oauth2:${env.GITLAB_ACCESS_TOKEN}@`),
        defaultBranch: project.default_branch,
      });
      workingDirectory = workspace.path;
    } catch (error) {
      logError({ event: 'workspace_setup_failed', issue_iid: iid, error: String(error) }, 'Failed to setup workspace for analysis');
      // Continue without workspace - analysis might still work for simple issues
    }
  }

  const prompt = buildAnalyzeIssuePrompt(
    project.path_with_namespace,
    iid,
    title,
    description || '(无)'
  );

  const cli = getClaudeCLI();

  try {
    const response = await cli.prompt(prompt, {
      timeout: 120,
      workingDirectory,
    });

    // 尝试解析结构化数据
    let category: string;
    let summary: string;

    const structured = parseStructuredIssueAnalysis(response);
    if (structured) {
      category = structured.category;
      summary = structured.summary;
      logDebug({ event: 'issue_analysis_parsed', issue_iid: iid, category, summary, hasAnalysis: true }, 'Parsed structured issue analysis');
    } else {
      // 回退到正则解析
      category = parseIssueCategory(response);
      summary = '';
      logDebug({ event: 'issue_analysis_parsed', issue_iid: iid, category, responsePreview: response.slice(0, 200), hasAnalysis: false }, 'Failed to parse structured analysis, using fallback');
    }

    // 移除 [ANALYSIS] 块，只保留设计文档部分用于发布
    const designDocContent = response.replace(/\[ANALYSIS\][\s\S]*?\[\/ANALYSIS\]\s*/i, '');
    const designDoc = `## 📋 Issue 分析报告\n\n${designDocContent.trim()}`;

    await gitlab.issues.createNote(project.id, iid, designDoc);

    // 添加 category 作为标签
    const labelMap: Record<string, string> = {
      new_feature: 'feature',
      improvement: 'improvement',
      bug_fix: 'bug',
      not_related: 'wontfix',
      unknown: 'needs-triage',
    };
    const label = labelMap[category] || 'needs-triage';

    try {
      await gitlab.client.put(`/projects/${project.id}/issues/${iid}`, {
        labels: label,
      });
    } catch (labelError) {
      // 标签添加失败不影响主流程，只记录警告
      logError({ event: 'label_update_failed', issue_iid: iid, label, error: String(labelError) }, 'Failed to update issue label');
    }

    logInfo(
      { event: 'analyze_issue_completed', issue_iid: iid, category },
      `Issue analysis completed for #${iid}, category: ${category}`
    );

    return { success: true, category };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logError({ event: 'analyze_issue_failed', issue_iid: iid, error: errorMessage }, `Issue analysis failed: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}
