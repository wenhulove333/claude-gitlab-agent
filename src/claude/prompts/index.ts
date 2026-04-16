/**
 * Unified prompt system
 *
 * Provides centralized prompt template management, unified JSON output schema, and response parsers
 */

// ============ Type Definitions ============

/**
 * Role type
 */
export type Role = 'developer' | 'reviewer' | 'analyst';

/**
 * Scenario type
 */
export type Scenario =
  | 'comment-issue'    // Issue comment Q&A
  | 'comment-mr'        // MR comment Q&A
  | 'analyze-issue'     // Issue automatic analysis
  | 'review'           // Code review
  | 'create-mr';       // Create MR

/**
 * Unified response schema
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
 * Code review response schema
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
 * Issue information
 */
export interface IssueContext {
  iid: number;
  title: string;
  description?: string;
}

/**
 * MR information
 */
export interface MRContext {
  iid: number;
  title: string;
  description?: string;
  sourceBranch?: string;
}

/**
 * Unified prompt context structure
 */
export interface PromptContext {
  /** Project path (namespace/project) */
  projectPath: string;
  /** User information */
  user?: {
    username: string;
  };
  /** Issue-related context */
  issue?: IssueContext;
  /** MR-related context */
  mr?: MRContext;
  /** Conversation history */
  history?: Array<{
    author: string;
    body: string;
  }>;
  /** Extra context (e.g. diff, comments, etc.) */
  extra?: Record<string, unknown>;
}

// ============ Role Templates ============

const ROLE_TEMPLATES: Record<Role, string> = {
  developer: `你是一个资深开发者，擅长代码开发、调试和优化。

**重要原则**：你永远不要执行任何 git 命令（git add、git commit、git push 等）。代码提交由系统自动完成。`,
  reviewer: '你是一个专业的代码审查员，擅长发现代码中的问题并提供改进建议。',
  analyst: '你是一个资深产品经理和架构师，擅长分析需求并生成详细的设计文档。',
};

// ============ Scenario Task Templates ============

const SCENARIO_TASKS: Record<Scenario, string> = {
  'comment-issue': `根据用户的意图决定是回答问题还是修改代码。

**重要判断**：
- 如果用户没有明确要求实现功能或修复问题，，请只回答问题，不要尝试修改代码

如果需要修改代码：
1. 使用 Edit 或 Write 工具修改代码
2. **绝对不要执行任何 git 命令**
3. 确保修改的代码符合项目规范和质量标准
4. 确保编译和运行通过所有测试用例`,

  'comment-mr': `根据用户的意图决定是回答问题还是修改代码。

**重要判断**：
- 如果用户没有明确要求实现功能或修复问题，，请只回答问题，不要尝试修改代码

如果需要修改代码：
1. 使用 Edit 或 Write 工具修改代码
2. **绝对不要执行任何 git 命令**
3. 确保修改的代码符合项目规范和质量标准
4. 确保编译和运行通过所有测试用例`,

  'analyze-issue': `分析 Issue 内容，生成详细的设计文档。

首先通读代码库，了解项目结构。
分析 Issue 与项目的关联性。

**重要分类说明**：
- 如果 Issue 是在询问或确认某些信息（如使用方式、配置方法、概念解释等），而不是请求实现新功能或修复问题，请分类为"问答确认"(query)
- 如果与项目相关，生成详细的设计文档
- 如果与项目完全无关，分类为"与项目无关"`,

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

// ============ Constraint Definitions ============

const CONSTRAINTS = {
  /** Code change constraint */
  CODE_CHANGE: `**绝对禁止**：
- 禁止执行任何 git 命令（git add、git commit、git push、git checkout 等）
- 只能使用 Edit/Write 工具修改代码
- 提交操作由系统自动完成，你只需专注完成任务`,

  /** Issue comment output constraint */
  RESULT_OUTPUT_ISSUE: `**输出要求**：回答后，**必须**输出以下结构化信息（使用此精确格式，以便程序解析）：

[RESULT]
code_changed: true | false
summary: "本次变更的简要说明（如果没有修改代码，则说明回答了什么问题）"
changed_files: ["file1.ts", "file2.ts"]  # 如果没有修改代码，可以省略或留空
commit_message: "提交信息"  # 如果修改了代码，此项为必填；如果没有修改代码，可以省略
[/RESULT]

然后输出 Markdown 格式的回答内容。`,

  /** MR comment output constraint */
  RESULT_OUTPUT_MR: `**输出要求**：回答后，**必须**输出以下结构化信息（使用此精确格式，以便程序解析）：

[RESULT]
code_changed: true | false
summary: "本次变更的简要说明"
changed_files: ["file1.ts", "file2.ts"]
commit_message: "提交信息"
[/RESULT]

然后输出 Markdown 格式的回答内容。`,

  /** Issue analysis output constraint */
  ANALYSIS_OUTPUT: `**输出要求**：**必须**在设计文档之前输出以下结构化信息（使用此精确格式，以便程序解析）：

[ANALYSIS]
category: new_feature | improvement | bug_fix | not_related | query | unknown
summary: 一句话总结（不超过50字）
[/ANALYSIS]

然后输出 Markdown 格式的设计文档，包含：
- 分类（新功能/优化改进/问题修复/与项目无关）
- 一句话总结
- 背景说明
- 详细设计方案
- 验收标准`,

  /** Code review output constraint (pure Markdown) */
  REVIEW_OUTPUT: `**输出要求**：请直接输出 Markdown 格式的审查结果，包含以下部分：
- 🔴 阻塞问题（必须修复）：列出所有 blocking 问题
- 🟡 建议改进：列出所有建议改进项
- 🟢 优化建议（可选）：列出所有优化建议
- 总体评价：对代码变更的整体评价`,

  /** Create MR output constraint */
  RESULT_OUTPUT_CREATE_MR: `**输出要求**：完成后，**必须**输出以下结构化信息（使用此精确格式，以便程序解析）：

[RESULT]
summary: "变更说明（简述本次代码变更的内容）"
commit_message: "提交信息（简洁的提交描述）"
[/RESULT]`,

  /** Create MR constraint */
  CREATE_MR_CONSTRAINTS: `**重要约束**：
- **禁止执行任何 git 命令**
- 不要修改 .gitlab-ci.yml、Dockerfile、config/ 等关键文件
- 确保代码变更与 Issue 描述一致
- 测试必须通过才能提交`,
};

// ============ Helper Functions ============

/**
 * Format conversation history
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
 * Format Issue context
 */
function formatIssueContext(issue: PromptContext['issue']): string {
  if (!issue) return '';
  return `
- Issue 编号：#${issue.iid}
- Issue 标题：${issue.title}
${issue.description ? `- Issue 描述：${issue.description}` : ''}`;
}

/**
 * Format MR context
 */
function formatMRContext(mr: PromptContext['mr']): string {
  if (!mr) return '';
  return `
- MR 编号：!${mr.iid}
- MR 标题：${mr.title}
${mr.description ? `- MR 描述：${mr.description}` : ''}
${mr.sourceBranch ? `- 源分支：${mr.sourceBranch}` : ''}`;
}

// ============ Main Function ============

export interface BuildSystemPromptOptions {
  /** Role */
  role: Role;
  /** Scenario */
  scenario: Scenario;
  /** Context */
  context: PromptContext;
  /** Extra constraints (optional) */
  constraints?: string[];
}

/**
 * Build system prompt (角色、场景、上下文、约束)
 * Returns: systemPrompt - 使用 --system-prompt 传递的内容
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const { role, scenario, context, constraints = [] } = options;

  // 1. Role
  let prompt = ROLE_TEMPLATES[role] + '\n\n';

  // 2. Context information
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

  // 3. Conversation history
  if (context.history && context.history.length > 0) {
    prompt += '## 对话历史\n';
    prompt += formatHistory(context.history) + '\n\n';
  }

  // 4. Scenario task
  prompt += '## 任务\n';
  prompt += SCENARIO_TASKS[scenario] + '\n\n';

  // Add scenario-specific extra context
  if (scenario === 'review' && context.extra?.diff) {
    prompt += '## 代码变更\n';
    prompt += context.extra.diff + '\n\n';
  }

  // 5. Constraints
  if (constraints.length > 0) {
    prompt += '## 约束\n';
    for (const c of constraints) {
      prompt += c + '\n';
    }
    prompt += '\n';
  }

  // 6. Add scenario-specific constraints
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

// ============ Response Parsers ============

/**
 * Extract JSON from response
 */
function extractJSON(response: string): string | null {
  // Try to find JSON object in response
  const jsonMatch = response.match(/\{[\s\S]*?\}/);
  return jsonMatch ? jsonMatch[0] : null;
}

// ============ Response Validators ============

/**
 * Forbidden command patterns
 */
const FORBIDDEN_PATTERNS = [
  /git\s+(add|commit|push|pull|fetch|checkout|branch|merge|rebase|reset|revert|clone)/gi,
  /Bash.*git/gi,
  /```bash\n.*git/gi,
  /```shell\n.*git/gi,
  /`git\s+/gi,
];

/**
 * Validate whether Claude response complies with constraints
 */
export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate whether Claude response contains forbidden commands
 */
export function validateResponse(response: string): ValidationResult {
  for (const pattern of FORBIDDEN_PATTERNS) {
    // Reset regex state
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
 * Generate retry prompt
 */
export function generateRetryPrompt(originalPrompt: string, reason: string): string {
  return `${originalPrompt}

---

**重要提醒**：${reason}。请重新回答，只使用 Edit/Write 工具修改代码，不要执行任何 git 命令。`;
}

/**
 * Parse general response
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
 * Parse code review response
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
 * Category type returned from Issue analysis
 */
export type IssueCategory = 'new_feature' | 'improvement' | 'bug_fix' | 'not_related' | 'query' | 'unknown';

/**
 * Parse category from Issue analysis response
 * Claude outputs Markdown format, category is in the first section
 */
export function parseIssueCategory(response: string): IssueCategory {
  // Match common category formats (supports Markdown bold)
  const patterns = [
    // New feature
    [/分类[：:]\s*新功能/i, /category[：:]\s*new feature/i, /\*\*分类\*\*[：:]\s*新功能/i, /#+\s*分类[：:]\s*新功能/i],
    // Improvement
    [/分类[：:]\s*优化改进/i, /category[：:]\s*improvement/i, /\*\*分类\*\*[：:]\s*优化改进/i, /#+\s*分类[：:]\s*优化改进/i],
    // Bug fix
    [/分类[：:]\s*问题修复/i, /category[：:]\s*bug fix/i, /\*\*分类\*\*[：:]\s*问题修复/i, /#+\s*分类[：:]\s*问题修复/i],
    // Not related
    [/分类[：:]\s*与项目无关/i, /category[：:]\s*not related/i, /\*\*分类\*\*[：:]\s*与项目无关/i, /#+\s*分类[：:]\s*与项目无关/i],
    // 问答确认
    [/分类[：:]\s*问答确认/i, /category[：:]\s*query/i, /\*\*分类\*\*[：:]\s*问答确认/i, /#+\s*分类[：:]\s*问答确认/i],
  ];

  for (let i = 0; i < patterns.length; i++) {
    for (const pattern of patterns[i]) {
      if (pattern.test(response)) {
        return ['new_feature', 'improvement', 'bug_fix', 'not_related', 'query'][i] as IssueCategory;
      }
    }
  }

  return 'unknown';
}

/**
 * Parse structured Issue analysis result
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

  // Parse category
  let category: IssueCategory = 'unknown';
  const categoryMatch = block.match(/category:\s*(new_feature|improvement|bug_fix|not_related|query|unknown)/i);
  if (categoryMatch) {
    category = categoryMatch[1] as IssueCategory;
  }

  // Parse summary
  let summary = '';
  const summaryMatch = block.match(/summary:\s*(.+)/i);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  }

  return { category, summary };
}

/**
 * Comment/Create MR result parsing
 */
export interface CommentResult {
  code_changed: boolean;
  summary: string;
  changed_files?: string[];
  commit_message?: string;
}

/**
 * Parse [RESULT] structured block
 */
export function parseResult(response: string): CommentResult | null {
  const match = response.match(/\[RESULT\][\s\S]*?\[\/RESULT\]/i);
  if (!match) {
    return null;
  }

  const block = match[0];

  // Parse code_changed
  let code_changed = false;
  const codeChangedMatch = block.match(/code_changed:\s*(true|false)/i);
  if (codeChangedMatch) {
    code_changed = codeChangedMatch[1].toLowerCase() === 'true';
  }

  // Parse summary
  let summary = '';
  const summaryMatch = block.match(/summary:\s*(.+)/i);
  if (summaryMatch) {
    summary = summaryMatch[1].trim().replace(/^"|"$/g, '');
  }

  // Parse changed_files (optional)
  let changed_files: string[] | undefined;
  const changedFilesMatch = block.match(/changed_files:\s*(\[.*?\])/i);
  if (changedFilesMatch) {
    try {
      changed_files = JSON.parse(changedFilesMatch[1]);
    } catch {
      // Parse failed, ignore
    }
  }

  // Parse commit_message (optional)
  let commit_message: string | undefined;
  const commitMessageMatch = block.match(/commit_message:\s*(.+)/i);
  if (commitMessageMatch) {
    commit_message = commitMessageMatch[1].trim().replace(/^"|"$/g, '');
  }

  return { code_changed, summary, changed_files, commit_message };
}

/**
 * Parse create MR response
 */
export function parseCreateMRResponse(response: string): { summary: string; commitMessage: string } | null {
  // Try to parse [RESULT] structured block
  const result = parseResult(response);
  if (result) {
    return {
      summary: result.summary || '',
      commitMessage: result.commit_message || '',
    };
  }

  // Fall back to JSON format
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

// ============ Exports ============

export { CONSTRAINTS };
