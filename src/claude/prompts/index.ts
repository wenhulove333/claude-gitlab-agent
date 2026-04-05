/**
 * 统一提示词系统
 *
 * 提供集中的提示词模板管理、统一的 JSON 输出 Schema 和响应解析器
 */

// ============ 类型定义 ============

/**
 * 角色类型
 */
export type Role = 'developer' | 'reviewer' | 'analyst';

/**
 * 场景类型
 */
export type Scenario =
  | 'comment-issue'    // Issue 评论问答
  | 'comment-mr'        // MR 评论问答
  | 'analyze-issue'     // Issue 自动分析
  | 'review'           // 代码审查
  | 'create-mr';       // 创建 MR

/**
 * 统一的响应 Schema
 */
export interface ClaudeResponse {
  code_changed: boolean;
  summary: string;
  changed_files?: string[];
  commit_message?: string;
  create_mr?: boolean;
  branch?: string;
}

/**
 * 代码审查响应 Schema
 */
export interface ReviewResponse {
  blocking: Array<{
    file: string;
    line?: number;
    issue: string;
  }>;
  suggestions: Array<{
    file: string;
    line?: number;
    issue: string;
  }>;
  optimizations: Array<{
    file: string;
    line?: number;
    issue: string;
  }>;
  summary: string;
}

/**
 * Issue 信息
 */
export interface IssueContext {
  iid: number;
  title: string;
  description?: string;
}

/**
 * MR 信息
 */
export interface MRContext {
  iid: number;
  title: string;
  description?: string;
  sourceBranch?: string;
}

/**
 * 统一的提示词上下文结构
 */
export interface PromptContext {
  /** 项目路径 (namespace/project) */
  projectPath: string;
  /** 用户信息 */
  user?: {
    username: string;
  };
  /** Issue 相关上下文 */
  issue?: IssueContext;
  /** MR 相关上下文 */
  mr?: MRContext;
  /** 对话历史 */
  history?: Array<{
    author: string;
    body: string;
  }>;
  /** 额外上下文（如 diff、评论等） */
  extra?: Record<string, unknown>;
}

// ============ 角色模板 ============

const ROLE_TEMPLATES: Record<Role, string> = {
  developer: `你是一个资深开发者，擅长代码开发、调试和优化。

**重要原则**：你永远不要执行任何 git 命令（git add、git commit、git push 等）。代码提交由系统自动完成。`,
  reviewer: '你是一个专业的代码审查员，擅长发现代码中的问题并提供改进建议。',
  analyst: '你是一个资深产品经理和架构师，擅长分析需求并生成详细的设计文档。',
};

// ============ 场景任务模板 ============

const SCENARIO_TASKS: Record<Scenario, string> = {
  'comment-issue': `回答用户的问题，或根据需要使用 Edit/Write 工具修改代码。

如果需要修改代码：
1. 使用 Edit 或 Write 工具修改代码
2. **绝对不要执行任何 git 命令**
3. 系统会自动检测代码变更并创建 MR`,

  'comment-mr': `回答用户的问题，或根据需要使用 Edit/Write 工具修改代码。

如果需要修改代码：
1. 使用 Edit 或 Write 工具修改代码
2. **绝对不要执行任何 git 命令**
3. 系统会自动检测代码变更并提交到 MR 的源分支`,

  'analyze-issue': `分析 Issue 内容，生成详细的设计文档。
首先通读代码库，了解项目结构。
分析 Issue 与项目的关联性。
如果与项目相关，生成详细的设计文档。`,

  'review': `审查代码变更，从以下维度进行：
1. 逻辑错误
2. 性能问题
3. 安全隐患
4. 代码风格
5. 可读性
6. 测试覆盖`,

  'create-mr': `分析 Issue 需求，使用 Edit/Write 工具实现代码变更。

请按以下步骤操作：
1. 分析需求，确定需要修改/新增的文件
2. 使用 Edit/Write 工具修改代码（**禁止 git 命令**）
3. 如果存在测试命令（如 npm test、make test），运行并确保通过；若失败，尝试修复
4. 系统会自动创建分支、提交代码并创建 MR`,
};

// ============ 约束定义 ============

const CONSTRAINTS = {
  /** 代码变更约束 */
  CODE_CHANGE: `**绝对禁止**：
- 禁止执行任何 git 命令（git add、git commit、git push、git checkout 等）
- 只能使用 Edit/Write 工具修改代码
- 提交操作由系统自动完成，你只需专注完成任务`,

  /** Issue 评论输出约束 */
  RESULT_OUTPUT_ISSUE: `**输出要求**：回答后，**必须**输出以下结构化信息（使用此精确格式，以便程序解析）：

[RESULT]
code_changed: true | false
summary: "本次变更的简要说明"
changed_files: ["file1.ts", "file2.ts"]
[/RESULT]

然后输出 Markdown 格式的回答内容。`,

  /** MR 评论输出约束 */
  RESULT_OUTPUT_MR: `**输出要求**：回答后，**必须**输出以下结构化信息（使用此精确格式，以便程序解析）：

[RESULT]
code_changed: true | false
summary: "本次变更的简要说明"
changed_files: ["file1.ts", "file2.ts"]
commit_message: "提交信息"
[/RESULT]

然后输出 Markdown 格式的回答内容。`,

  /** Issue 分析输出约束 */
  ANALYSIS_OUTPUT: `**输出要求**：**必须**在设计文档之前输出以下结构化信息（使用此精确格式，以便程序解析）：

[ANALYSIS]
category: new_feature | improvement | bug_fix | not_related | unknown
summary: 一句话总结（不超过50字）
[/ANALYSIS]

然后输出 Markdown 格式的设计文档，包含：
- 分类（新功能/优化改进/问题修复/与项目无关）
- 一句话总结
- 背景说明
- 详细设计方案
- 验收标准`,

  /** 代码审查输出约束（纯 Markdown） */
  REVIEW_OUTPUT: `**输出要求**：请直接输出 Markdown 格式的审查结果，包含以下部分：
- 🔴 阻塞问题（必须修复）：列出所有 blocking 问题
- 🟡 建议改进：列出所有建议改进项
- 🟢 优化建议（可选）：列出所有优化建议
- 总体评价：对代码变更的整体评价`,

  /** 创建 MR 输出约束 */
  RESULT_OUTPUT_CREATE_MR: `**输出要求**：完成后，**必须**输出以下结构化信息（使用此精确格式，以便程序解析）：

[RESULT]
summary: "变更说明（简述本次代码变更的内容）"
commit_message: "提交信息（简洁的提交描述）"
[/RESULT]`,

  /** 创建 MR 约束 */
  CREATE_MR_CONSTRAINTS: `**重要约束**：
- **禁止执行任何 git 命令**
- 不要修改 .gitlab-ci.yml、Dockerfile、config/ 等关键文件
- 确保代码变更与 Issue 描述一致
- 测试必须通过才能提交`,
};

// ============ 辅助函数 ============

/**
 * 格式化对话历史
 */
function formatHistory(history: PromptContext['history']): string {
  if (!history || history.length === 0) {
    return '(无)';
  }
  return history
    .map((h) => `- ${h.author}: ${h.body}`)
    .join('\n');
}

/**
 * 格式化 Issue 上下文
 */
function formatIssueContext(issue: PromptContext['issue']): string {
  if (!issue) return '';
  return `
- Issue 编号：#${issue.iid}
- Issue 标题：${issue.title}
${issue.description ? `- Issue 描述：${issue.description}` : ''}`;
}

/**
 * 格式化 MR 上下文
 */
function formatMRContext(mr: PromptContext['mr']): string {
  if (!mr) return '';
  return `
- MR 编号：!${mr.iid}
- MR 标题：${mr.title}
${mr.description ? `- MR 描述：${mr.description}` : ''}
${mr.sourceBranch ? `- 源分支：${mr.sourceBranch}` : ''}`;
}

// ============ 主函数 ============

export interface BuildPromptOptions {
  /** 角色 */
  role: Role;
  /** 场景 */
  scenario: Scenario;
  /** 上下文 */
  context: PromptContext;
  /** 任务描述（可选，会自动从场景获取） */
  task?: string;
  /** 额外约束（可选） */
  constraints?: string[];
}

/**
 * 构建统一的提示词
 */
export function buildPrompt(options: BuildPromptOptions): string {
  const { role, scenario, context, task, constraints = [] } = options;

  // 1. 角色
  let prompt = ROLE_TEMPLATES[role] + '\n\n';

  // 2. 上下文信息
  prompt += '## 上下文信息\n';
  prompt += `- 项目：${context.projectPath}\n`;

  if (context.user) {
    prompt += `- 用户：${context.user.username}\n`;
  }

  if (context.issue) {
    prompt += formatIssueContext(context.issue) + '\n';
  }

  if (context.mr) {
    prompt += formatMRContext(context.mr) + '\n';
  }

  // 3. 对话历史
  if (context.history && context.history.length > 0) {
    prompt += '## 对话历史\n';
    prompt += formatHistory(context.history) + '\n\n';
  }

  // 4. 任务
  prompt += '## 任务\n';
  prompt += SCENARIO_TASKS[scenario] + '\n';
  if (task) {
    prompt += `\n用户请求：${task}\n`;
  }
  prompt += '\n';

  // 5. 约束
  if (constraints.length > 0) {
    prompt += '## 约束\n';
    for (const c of constraints) {
      prompt += c + '\n';
    }
    prompt += '\n';
  }

  // 6. 根据场景添加特定约束
  switch (scenario) {
    case 'comment-issue':
      prompt += CONSTRAINTS.CODE_CHANGE + '\n\n';
      prompt += CONSTRAINTS.RESULT_OUTPUT_ISSUE + '\n';
      break;

    case 'comment-mr':
      prompt += CONSTRAINTS.CODE_CHANGE + '\n\n';
      prompt += CONSTRAINTS.RESULT_OUTPUT_MR + '\n';
      break;

    case 'analyze-issue':
      prompt += CONSTRAINTS.ANALYSIS_OUTPUT + '\n';
      break;

    case 'review':
      prompt += CONSTRAINTS.REVIEW_OUTPUT + '\n';
      break;

    case 'create-mr':
      prompt += CONSTRAINTS.CREATE_MR_CONSTRAINTS + '\n\n';
      prompt += CONSTRAINTS.RESULT_OUTPUT_CREATE_MR + '\n';
      break;
  }

  return prompt;
}

// ============ 响应解析器 ============

/**
 * 从响应中提取 JSON
 */
function extractJSON(response: string): string | null {
  // Try to find JSON object in response
  const jsonMatch = response.match(/\{[\s\S]*?\}/);
  return jsonMatch ? jsonMatch[0] : null;
}

// ============ 响应验证器 ============

/**
 * 禁止的命令模式
 */
const FORBIDDEN_PATTERNS = [
  /git\s+(add|commit|push|pull|fetch|checkout|branch|merge|rebase|reset|revert|clone)/gi,
  /Bash.*git/gi,
  /```bash\n.*git/gi,
  /```shell\n.*git/gi,
  /`git\s+/gi,
];

/**
 * 验证 Claude 响应是否符合约束
 */
export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * 验证 Claude 响应是否包含禁止的命令
 */
export function validateResponse(response: string): ValidationResult {
  for (const pattern of FORBIDDEN_PATTERNS) {
    // 重置正则状态
    pattern.lastIndex = 0;
    if (pattern.test(response)) {
      return {
        valid: false,
        reason: 'Claude 响应包含禁止的 git 命令，请使用 Edit/Write 工具修改代码，不要执行任何 git 命令',
      };
    }
  }
  return { valid: true };
}

/**
 * 生成重试提示
 */
export function generateRetryPrompt(originalPrompt: string, reason: string): string {
  return `${originalPrompt}

---

**重要提醒**：${reason}。请重新回答，只使用 Edit/Write 工具修改代码，不要执行任何 git 命令。`;
}

/**
 * 解析通用响应
 */
export function parseResponse(response: string): ClaudeResponse {
  const jsonStr = extractJSON(response);

  if (!jsonStr) {
    return {
      code_changed: false,
      summary: response.trim(),
    };
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      code_changed: parsed.code_changed ?? false,
      summary: parsed.summary ?? '',
      changed_files: parsed.changed_files,
      commit_message: parsed.commit_message,
      create_mr: parsed.create_mr,
      branch: parsed.branch,
    };
  } catch {
    return {
      code_changed: false,
      summary: response.trim(),
    };
  }
}

/**
 * 解析代码审查响应
 */
export function parseReviewResponse(response: string): ReviewResponse | null {
  const jsonStr = extractJSON(response);

  if (!jsonStr) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonStr);
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
 * 解析创建 MR 响应
 */
export function parseCreateMRResponse(response: string): { summary: string; commitMessage: string } | null {
  // 尝试解析 [RESULT] 结构化块
  const result = parseResult(response);
  if (result) {
    return {
      summary: result.summary || '',
      commitMessage: result.commit_message || '',
    };
  }

  // 回退到 JSON 格式
  const jsonStr = extractJSON(response);
  if (!jsonStr) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      summary: parsed.summary || '',
      commitMessage: parsed.commit_message || '',
    };
  } catch {
    return null;
  }
}

/**
 * Issue 分析返回的 category 类型
 */
export type IssueCategory = 'new_feature' | 'improvement' | 'bug_fix' | 'not_related' | 'unknown';

/**
 * 从 Issue 分析响应中解析 category
 * Claude 会输出 Markdown 格式，分类在第一部分
 */
export function parseIssueCategory(response: string): IssueCategory {
  // 匹配常见的分类格式（支持 Markdown 粗体）
  const patterns = [
    // 新功能
    [/分类[：:]\s*新功能/i, /category[：:]\s*new feature/i, /\*\*分类\*\*[：:]\s*新功能/i, /#+\s*分类[：:]\s*新功能/i],
    // 优化改进
    [/分类[：:]\s*优化改进/i, /category[：:]\s*improvement/i, /\*\*分类\*\*[：:]\s*优化改进/i, /#+\s*分类[：:]\s*优化改进/i],
    // 问题修复
    [/分类[：:]\s*问题修复/i, /category[：:]\s*bug fix/i, /\*\*分类\*\*[：:]\s*问题修复/i, /#+\s*分类[：:]\s*问题修复/i],
    // 与项目无关
    [/分类[：:]\s*与项目无关/i, /category[：:]\s*not related/i, /\*\*分类\*\*[：:]\s*与项目无关/i, /#+\s*分类[：:]\s*与项目无关/i],
  ];

  for (let i = 0; i < patterns.length; i++) {
    for (const pattern of patterns[i]) {
      if (pattern.test(response)) {
        return ['new_feature', 'improvement', 'bug_fix', 'not_related'][i] as IssueCategory;
      }
    }
  }

  return 'unknown';
}

// ============ 辅助函数 - 保留向后兼容 ============

/**
 * @deprecated 使用 buildPrompt 替代
 * 构建评论问答的 Issue 提示词
 */
export function buildIssuePrompt(
  projectPath: string,
  issueIid: number,
  issueTitle: string,
  issueDescription: string,
  instruction: string,
  history: PromptContext['history']
): string {
  return buildPrompt({
    role: 'developer',
    scenario: 'comment-issue',
    context: {
      projectPath,
      issue: { iid: issueIid, title: issueTitle, description: issueDescription },
      history,
    },
    task: instruction,
  });
}

/**
 * @deprecated 使用 buildPrompt 替代
 * 构建评论问答的 MR 提示词
 */
export function buildMRPrompt(
  projectPath: string,
  mrIid: number,
  mrTitle: string,
  sourceBranch: string,
  instruction: string,
  history: PromptContext['history']
): string {
  return buildPrompt({
    role: 'developer',
    scenario: 'comment-mr',
    context: {
      projectPath,
      mr: { iid: mrIid, title: mrTitle, sourceBranch },
      history,
    },
    task: instruction,
  });
}

/**
 * @deprecated 使用 buildPrompt 替代
 * 构建 Issue 分析提示词
 */
export function buildAnalyzeIssuePrompt(
  projectPath: string,
  issueIid: number,
  issueTitle: string,
  issueDescription: string
): string {
  return `你是一个资深产品经理和架构师，擅长分析需求并生成详细的设计文档。

## 上下文信息
- 项目：${projectPath}
- Issue 编号：#${issueIid}

## Issue 信息
- 标题：${issueTitle}
- 描述：${issueDescription || '(无)'}

## 任务
分析 Issue 内容，生成详细的设计文档。
首先通读代码库，了解项目结构。
分析 Issue 与项目的关联性。
如果与项目相关，生成详细的设计文档。

## 输出要求
**必须**在设计文档之前输出以下结构化信息（使用此精确格式，以便程序解析）：

[ANALYSIS]
category: new_feature | improvement | bug_fix | not_related | unknown
summary: 一句话总结（不超过50字）
[/ANALYSIS]

然后输出 Markdown 格式的设计文档，包含：
- 分类（新功能/优化改进/问题修复/与项目无关）
- 一句话总结
- 背景说明
- 详细设计方案
- 验收标准`;
}

/**
 * 解析结构化的 Issue 分析结果
 */
export interface StructuredIssueAnalysis {
  category: IssueCategory;
  summary: string;
}

export function parseStructuredIssueAnalysis(response: string): StructuredIssueAnalysis | null {
  const match = response.match(/\[ANALYSIS\][\s\S]*?\[\/ANALYSIS\]/i);
  if (!match) {
    return null;
  }

  const block = match[0];

  // 解析 category
  let category: IssueCategory = 'unknown';
  const categoryMatch = block.match(/category:\s*(new_feature|improvement|bug_fix|not_related|unknown)/i);
  if (categoryMatch) {
    category = categoryMatch[1] as IssueCategory;
  }

  // 解析 summary
  let summary = '';
  const summaryMatch = block.match(/summary:\s*(.+)/i);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  }

  return { category, summary };
}

/**
 * 评论/创建MR 结果解析
 */
export interface CommentResult {
  code_changed: boolean;
  summary: string;
  changed_files?: string[];
  commit_message?: string;
}

/**
 * 解析 [RESULT] 结构化块
 */
export function parseResult(response: string): CommentResult | null {
  const match = response.match(/\[RESULT\][\s\S]*?\[\/RESULT\]/i);
  if (!match) {
    return null;
  }

  const block = match[0];

  // 解析 code_changed
  let code_changed = false;
  const codeChangedMatch = block.match(/code_changed:\s*(true|false)/i);
  if (codeChangedMatch) {
    code_changed = codeChangedMatch[1].toLowerCase() === 'true';
  }

  // 解析 summary
  let summary = '';
  const summaryMatch = block.match(/summary:\s*(.+)/i);
  if (summaryMatch) {
    summary = summaryMatch[1].trim().replace(/^"|"$/g, '');
  }

  // 解析 changed_files（可选）
  let changed_files: string[] | undefined;
  const changedFilesMatch = block.match(/changed_files:\s*(\[.*?\])/i);
  if (changedFilesMatch) {
    try {
      changed_files = JSON.parse(changedFilesMatch[1]);
    } catch {
      // 解析失败，忽略
    }
  }

  // 解析 commit_message（可选）
  let commit_message: string | undefined;
  const commitMessageMatch = block.match(/commit_message:\s*(.+)/i);
  if (commitMessageMatch) {
    commit_message = commitMessageMatch[1].trim().replace(/^"|"$/g, '');
  }

  return { code_changed, summary, changed_files, commit_message };
}

/**
 * @deprecated 使用 buildPrompt 替代
 * 构建代码审查提示词
 */
export function buildReviewPrompt(
  projectPath: string,
  mrIid: number,
  mrTitle: string,
  mrDescription: string,
  diffText: string
): string {
  return `你是一个专业的代码审查员，擅长发现代码中的问题并提供改进建议。

## 上下文信息
- 项目：${projectPath}
- MR 编号：!${mrIid}
- MR 标题：${mrTitle}
- MR 描述：${mrDescription || '(无)'}

## 任务
审查代码变更，从以下维度进行：
1. 逻辑错误
2. 性能问题
3. 安全隐患
4. 代码风格
5. 可读性
6. 测试覆盖

## 代码变更
${diffText}

## 输出要求
请直接输出 Markdown 格式的审查结果，包含以下部分（不要输出 JSON）：
- 🔴 阻塞问题（必须修复）：列出所有 blocking 问题
- 🟡 建议改进：列出所有建议改进项
- 🟢 优化建议（可选）：列出所有优化建议
- 总体评价：对代码变更的整体评价`;
}

/**
 * @deprecated 使用 buildPrompt 替代
 * 构建创建 MR 提示词
 */
export function buildCreateMRPrompt(
  projectPath: string,
  _defaultBranch: string,
  issueIid: number,
  issueTitle: string,
  issueDescription: string,
  comments: string
): string {
  const issueContext = `Issue #${issueIid}: ${issueTitle}\n\n描述：\n${issueDescription || '(无)'}\n\n评论：\n${comments || '(无)'}`;

  return buildPrompt({
    role: 'developer',
    scenario: 'create-mr',
    context: {
      projectPath,
      issue: { iid: issueIid, title: issueTitle, description: issueContext },
    },
  });
}

// ============ 导出 ============

export { CONSTRAINTS };
