import { logInfo, logError } from '../utils/logger.js';
import { createGitLabClient } from '../gitlab/index.js';
import { getClaudeCLI } from '../claude/index.js';
import type { IssueWebhookPayload } from '../webhook/types.js';
import { getEnv } from '../config/index.js';

export interface AnalyzeIssueResult {
  success: boolean;
  isRelated: boolean;
  category: 'new_feature' | 'improvement' | 'bug_fix' | 'not_related' | 'unknown';
  categoryLabel: string;
  summary?: string;
  error?: string;
}

type IssueCategory = 'new_feature' | 'improvement' | 'bug_fix' | 'not_related' | 'unknown';

const CATEGORY_LABELS: Record<IssueCategory, string> = {
  new_feature: '🆕 新功能',
  improvement: '✨ 优化改进',
  bug_fix: '🐛 问题修复',
  not_related: '❌ 无关需求',
  unknown: '📝 其他',
};

export async function analyzeIssue(
  payload: IssueWebhookPayload
): Promise<AnalyzeIssueResult> {
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

  let notes: { author: { username: string }; body: string }[] = [];
  try {
    notes = await gitlab.issues.getNotes(project.id, iid, { sort: 'asc' });
  } catch {
    // 刚创建的 issue 还没有评论
  }

  const prompt = buildAnalysisPrompt(
    project.path_with_namespace,
    iid,
    title,
    description || '(无)',
    notes
  );

  const cli = getClaudeCLI();

  try {
    const response = await cli.prompt(prompt, { timeout: 120 });

    const parsed = parseAnalysisResponse(response);
    if (!parsed) {
      logError({ event: 'analyze_issue_parse_failed', issue_iid: iid }, 'Failed to parse analysis response');
      return { success: false, isRelated: true, category: 'unknown', categoryLabel: CATEGORY_LABELS.unknown };
    }

    const designDoc = buildDesignDocument(
      parsed.isRelated,
      parsed.category,
      parsed.summary,
      parsed.background,
      parsed.proposal,
      parsed.acceptance_criteria
    );

    await gitlab.issues.createNote(project.id, iid, designDoc);

    logInfo(
      { event: 'analyze_issue_completed', issue_iid: iid, category: parsed.category },
      `Issue analysis completed for #${iid}, category: ${parsed.category}`
    );

    return {
      success: true,
      isRelated: parsed.isRelated,
      category: parsed.category,
      categoryLabel: CATEGORY_LABELS[parsed.category],
      summary: parsed.summary,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logError({ event: 'analyze_issue_failed', issue_iid: iid, error: errorMessage }, `Issue analysis failed: ${errorMessage}`);
    return { success: false, isRelated: true, category: 'unknown', categoryLabel: CATEGORY_LABELS.unknown, error: errorMessage };
  }
}

function buildAnalysisPrompt(
  projectPath: string,
  issueIid: number,
  title: string,
  description: string,
  notes: { author: { username: string }; body: string }[]
): string {
  const conversationHistory = notes.length > 0
    ? notes.map((n) => `- ${n.author.username}: ${n.body}`).join('\n')
    : '(无)';

  return `你是一个资深产品经理和架构师。你的任务是对 Issue 进行分类并生成详细的设计文档。

## 第一步：通读代码库
在开始分析之前，请先了解当前项目的代码结构：
1. 使用 Bash 工具执行 \`find . -type f \\( -name "*.ts" -o -name "*.js" -o -name "*.java" -o -name "*.py" \\) | head -50\` 查看项目文件结构
2. 使用 Read 工具阅读关键文件（package.json、README.md，主要模块等）
3. 使用 Bash 工具执行 \`ls -la\` 和 \`cat README.md 2>/dev/null || echo "无 README"\` 了解项目概况

## 第二步：分析 Issue 与项目的关联性
分析这个 Issue 是否与当前代码库相关：
- 如果 Issue 涉及的功能、模块、概念在代码库中完全找不到对应，说明这个 Issue 与本项目无关
- 如果 Issue 描述的问题、需求在代码库中有明确的对应，则继续分析

## Issue 信息
- 项目：${projectPath}
- Issue 编号：#${issueIid}
- 标题：${title}
- 描述：${description}
- 对话历史：${conversationHistory}

## 第三步：分类
根据分析结果判断：
- **new_feature**: 新功能需求
- **improvement**: 优化改进（性能、用户体验、代码质量等）
- **bug_fix**: 问题修复（错误、功能缺失、安全漏洞等）
- **not_related**: 与本项目无关的需求

## 第四步：生成设计文档（如相关）
如果 Issue 与本项目相关，请为这个 Issue 生成详细的设计文档。

## 输出格式
请严格按照以下 JSON 格式输出（只输出 JSON，不要有其他内容）：
{
  "is_related": true或false,
  "category": "new_feature|improvement|bug_fix|not_related",
  "summary": "一句话总结这个 Issue 的核心内容（如果不相关，说明原因）",
  "background": "背景说明：为什么要做这个？解决什么问题？（如果不相关则为空）",
  "proposal": "详细设计方案：具体怎么实现？技术选型？架构设计？（如果不相关则为空）",
  "acceptance_criteria": ["验收标准1", "验收标准2", "验收标准3"]
}

## 示例
如果是一个与项目无关的需求：
{"is_related": false, "category": "not_related", "summary": "这个 Issue 要求实现一个宠物预约系统，与当前项目的电商平台功能无关", "background": "", "proposal": "", "acceptance_criteria": []}

如果是一个与项目相关的需求：
{"is_related": true, "category": "new_feature", "summary": "为电商平台添加用户登录功能", "background": "用户无法登录系统，需要提供登录功能", "proposal": "1. 实现用户名密码登录\\n2. 集成 Google OAuth 登录\\n3. 使用 JWT 进行身份验证", "acceptance_criteria": ["用户可以使用用户名密码成功登录", "用户可以使用 Google 账号登录"]}

请先通读代码，然后分析并输出 JSON：`;
}

function parseAnalysisResponse(response: string): {
  isRelated: boolean;
  category: IssueCategory;
  summary: string;
  background: string;
  proposal: string;
  acceptance_criteria: string[];
} | null {
  try {
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.category || !parsed.summary) return null;

    const validCategories: IssueCategory[] = ['new_feature', 'improvement', 'bug_fix', 'not_related', 'unknown'];
    if (!validCategories.includes(parsed.category)) {
      parsed.category = 'unknown';
    }

    const isRelated = parsed.is_related !== false && parsed.category !== 'not_related';
    return {
      isRelated,
      category: parsed.category,
      summary: parsed.summary,
      background: parsed.background || '',
      proposal: parsed.proposal || '',
      acceptance_criteria: Array.isArray(parsed.acceptance_criteria) ? parsed.acceptance_criteria : [],
    };
  } catch {
    return null;
  }
}

function buildDesignDocument(
  isRelated: boolean,
  category: IssueCategory,
  summary: string,
  background: string,
  proposal: string,
  acceptanceCriteria: string[]
): string {
  if (!isRelated) {
    return `## 📋 Issue 分析报告

### 分类：❌ 与本项目无关

---

### 📝 结论
${summary}

---

*此报告由 Claude 自动生成*`;
  }

  return `## 📋 Issue 分析报告

### 分类：${CATEGORY_LABELS[category]}

---

### 📝 一句话总结
${summary}

---

### 📌 背景
${background || '(未提供)'}

---

### 💡 详细设计
${proposal}

---

### ✅ 验收标准
${acceptanceCriteria.length > 0 ? acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n') : '(未提供)'}

---

*此报告由 Claude 自动生成*`;
}
