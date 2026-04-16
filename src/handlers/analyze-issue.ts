import { logInfo, logError, logDebug } from '../utils/logger.js';
import { createGitLabClient } from '../gitlab/index.js';
import { getClaudeCLI } from '../claude/index.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { buildSystemPrompt, parseIssueCategory, parseStructuredIssueAnalysis } from '../claude/prompts/index.js';
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

/**
 * Analyzes a newly created Issue using Claude
 *
 * This function:
 * 1. Sets up a workspace with the project repository
 * 2. Sends the issue to Claude for analysis
 * 3. Posts the analysis result as a comment on the issue
 * 4. Categorizes and labels the issue based on the analysis
 *
 * @param options - Analysis options including webhook payload and optional workspace path
 * @returns Result object with success status and category
 */
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

  const systemPrompt = buildSystemPrompt({
    role: 'analyst',
    scenario: 'analyze-issue',
    context: {
      projectPath: project.path_with_namespace,
      issue: {
        iid,
        title,
        description: description || '(无)',
      },
    },
  });

  const cli = getClaudeCLI();

  try {
    const response = await cli.prompt('', {
      timeout: 120,
      workingDirectory,
      systemPrompt,
    });

    // Try to parse structured data
    let category: string;
    let summary: string;

    const structured = parseStructuredIssueAnalysis(response);
    if (structured) {
      category = structured.category;
      summary = structured.summary;
      logDebug({ event: 'issue_analysis_parsed', issue_iid: iid, category, summary, hasAnalysis: true }, 'Parsed structured issue analysis');
    } else {
      // Fallback to regex parsing
      category = parseIssueCategory(response);
      summary = '';
      logDebug({ event: 'issue_analysis_parsed', issue_iid: iid, category, responsePreview: response.slice(0, 200), hasAnalysis: false }, 'Failed to parse structured analysis, using fallback');
    }

    // Remove [ANALYSIS] block, keep only the design doc part for posting
    const designDocContent = response.replace(/\[ANALYSIS\][\s\S]*?\[\/ANALYSIS\]\s*/i, '');
    const designDoc = `## 📋 Issue 分析报告\n\n${designDocContent.trim()}`;

    await gitlab.issues.createNote(project.id, iid, designDoc);

    // Add category as label
    const labelMap: Record<string, string> = {
      new_feature: 'feature',
      improvement: 'improvement',
      bug_fix: 'bug',
      not_related: 'wontfix',
      query: 'question',
      unknown: 'needs-triage',
    };
    const label = labelMap[category] || 'needs-triage';

    try {
      await gitlab.client.put(`/projects/${project.id}/issues/${iid}`, {
        labels: label,
      });
    } catch (labelError) {
      // Label update failure doesn't affect main flow, just log warning
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

    // Reply error to comment
    try {
      const errorResponse = `🤖 ${getEnv().BOT_NAME} 分析失败：

错误：${errorMessage}

调用大模型失败，请重新创建新的议题。`;
      await gitlab.issues.createNote(project.id, iid, errorResponse);
    } catch (noteError) {
      logError({ event: 'analyze_issue_error_reply_failed', issue_iid: iid, error: String(noteError) }, 'Failed to post error reply to issue');
    }

    return { success: false, error: errorMessage };
  }
}
