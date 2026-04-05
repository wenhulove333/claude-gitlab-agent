# 提示词优化方案

## 概述

Claude GitLab Agent 通过统一提示词系统，实现用户与 AI 助手的智能交互。核心原则：

1. **机器人不得执行 git 命令** - 只能使用 Edit/Write 工具修改代码
2. **代码提交由系统自动完成** - 机器人只输出 JSON 告知变更内容
3. **机器人自主判断意图** - 区分问答和代码实现场景

---

## 机器人配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `BOT_NAME` | 机器人显示名称，也作为 @mention 命令名 | `小智` |
| `BOT_USERNAME` | GitLab bot 用户名，用于跳过自创 MR | `claude-bot` |

可在全局环境变量或 GitLab Project CI/CD Variables 中配置：
- `CLAUDE_BOT_NAME` - 机器人显示名称
- `CLAUDE_BOT_USERNAME` - GitLab 用户名

---

## 场景总览

| 场景 | 触发 | 机器人行为 | 系统行为 |
|------|------|------------|---------|
| **评论问答** | Issue/MR 评论 `@{BOT_NAME}` | 回答问题或修改代码 | 有变更 → 自动创建 MR/提交 |
| **Issue 分析** | Issue 创建 | 生成设计文档 | 打标签 |
| **代码审查** | MR 打开 | 审查代码 | 发表审查意见 |

---

## 场景详解

### 1. 评论问答 `@{BOT_NAME}`

**触发**：用户在 Issue 或 MR 下评论 `@{BOT_NAME} <指令>`

**核心逻辑**：机器人自主判断是否需要代码实现，有变更则系统自动处理。

**Issue 流程**：
```
用户评论 → 准备工作空间 → 调用 Claude CLI → 验证响应 →
  ├── 有代码变更 → 系统创建分支 → 提交 → 创建 MR → 回复用户
  └── 无代码变更 → 直接回复用户
```

**MR 流程**：
```
用户评论 → 准备工作空间 → 调用 Claude CLI → 验证响应 →
  ├── 有代码变更 → 系统提交到 MR 源分支 → 回复用户
  └── 无代码变更 → 直接回复用户
```

**提示词模板**（Issue）：
```
你是一个资深开发者，擅长代码开发、调试和优化。

**重要原则**：你永远不要执行任何 git 命令。代码提交由系统自动完成。

## 上下文信息
- 项目：{project}
- Issue 编号：#{iid}
- Issue 标题：{title}

## 任务
回答用户的问题，或根据需要使用 Edit/Write 工具修改代码。

如果需要修改代码：
1. 使用 Edit 或 Write 工具修改代码
2. **绝对不要执行任何 git 命令**
3. 系统会自动创建分支、提交代码并创建 MR

## 约束
**绝对禁止**：
- 禁止执行任何 git 命令（git add、git commit、git push 等）
- 只能使用 Edit/Write 工具修改代码
- 提交操作由系统自动完成

## 输出要求
回答后，**必须**输出以下 JSON（无论是否有代码变更）：
{
  "code_changed": true或false,
  "summary": "本次变更的简要说明"
}
```

**MR 场景的差异**：JSON 额外包含 `commit_message`，代码提交到 MR 源分支。

**代码变更检测**：
```typescript
const status = await git.status();
const hasChanges = !status.isClean();
```

**系统处理 - Issue 中有代码变更时**：
```typescript
// 1. 获取 Issue 的 labels 用于生成分支名
const issueLabels = issue.labels || [];
const categoryPrefix = labelToPrefix[issueLabels] || 'task';

// 2. 生成分支名
const branchName = `${categoryPrefix}/issue-${iid}-${shortDesc}`;

// 3. 提交并推送
await git.add('.');
await git.commit(commitMessage);
await git.push('origin', `HEAD:refs/heads/${branchName}`, ['--set-upstream']);

// 4. 创建 MR
gitlab.client.post(`/projects/${id}/merge_requests`, {
  source_branch: branchName,
  target_branch: defaultBranch,
  title: `[{BOT_NAME}] ${issueTitle}`,
  description: mrDescription,
});
```

**分支命名**：`{category}/issue-{iid}-{short-desc}`

| Issue 分类 | 分支前缀 |
|----------|---------|
| 新功能 | `feature` |
| 优化改进 | `improvement` |
| 问题修复 | `fix` |
| 与项目无关 | `wontfix` |
| 未知 | `task` |

**提交逻辑**：
- **Issue**：有变更 → 提示用户需要创建 MR（用户决定是否创建）
- **MR**：有变更 → 自动提交到源分支 `git push --force-with-lease`

---

### 2. Issue 自动分析

**触发**：Issue 创建（`opened` 事件）

**流程**：
```
Issue 创建 → 克隆仓库 → 调用 Claude CLI → 解析 category → 生成设计文档 → 打标签 → 发布评论
```

**提示词模板**：
```
你是一个资深产品经理和架构师，擅长分析需求并生成详细的设计文档。

## 上下文信息
- 项目：{project}
- Issue 编号：#{iid}

## Issue 信息
- 标题：{title}
- 描述：{description}

## 任务
分析 Issue 内容，生成详细的设计文档。
首先通读代码库，了解项目结构。
分析 Issue 与项目的关联性。
如果与项目相关，生成详细的设计文档。

## 输出要求
请直接输出 Markdown 格式的设计文档，包含：
- 分类（新功能/优化改进/问题修复/与项目无关）
- 一句话总结
- 背景说明
- 详细设计方案
- 验收标准
```

**Category 解析**：
```typescript
type IssueCategory = 'new_feature' | 'improvement' | 'bug_fix' | 'not_related' | 'unknown';
```

**标签映射**：
| Category | GitLab Label |
|----------|--------------|
| new_feature | `feature` |
| improvement | `improvement` |
| bug_fix | `bug` |
| not_related | `wontfix` |
| unknown | `needs-triage` |

---

### 3. 代码审查

**触发**：MR 打开或重新打开（非 Claude 创建）

**流程**：
```
MR 打开 → 获取 diff → 发表"正在review" → 调用 Claude CLI → 发表审查意见
```

**提示词模板**：
```
你是一个专业的代码审查员，擅长发现代码中的问题并提供改进建议。

## 上下文信息
- 项目：{project}
- MR 编号：!{iid}
- MR 标题：{title}
- MR 描述：{description}

## 任务
审查代码变更，从以下维度进行：
1. 逻辑错误
2. 性能问题
3. 安全隐患
4. 代码风格
5. 可读性
6. 测试覆盖

## 代码变更
{diff}

## 输出要求
请直接输出 Markdown 格式的审查结果，包含以下部分（不要输出 JSON）：
- 🔴 阻塞问题（必须修复）：列出所有 blocking 问题
- 🟡 建议改进：列出所有建议改进项
- 🟢 优化建议（可选）：列出所有优化建议
- 总体评价：对代码变更的整体评价
```

**输出格式**：
- 🔴 阻塞问题（必须修复）
- 🟡 建议改进
- 🟢 优化建议（可选）

---

## 响应验证

### 验证场景

| 场景 | 是否验证 | 说明 |
|------|---------|------|
| 评论问答 (comment-issue/mr) | ✅ 是 | 需要禁止 git 命令 |
| 创建 MR (create-mr) | ✅ 是 | 需要禁止 git 命令 |
| Issue 分析 (analyze-issue) | ❌ 否 | 纯分析，无代码修改 |
| 代码审查 (review) | ❌ 否 | 纯审查，无代码修改 |

### 验证逻辑

```typescript
const FORBIDDEN_PATTERNS = [
  /git\s+(add|commit|push|pull|fetch|checkout|branch|merge|rebase|reset|revert|clone)/gi,
  /Bash.*git/gi,
  /```bash\n.*git/gi,
  /```shell\n.*git/gi,
  /`git\s+/gi,
];

function validateResponse(response: string): { valid: boolean; reason?: string } {
  for (const pattern of FORBIDDEN_PATTERNS) {
    pattern.lastIndex = 0; // 重置正则状态
    if (pattern.test(response)) {
      return { valid: false, reason: '响应包含禁止的 git 命令' };
    }
  }
  return { valid: true };
}
```

### 重试机制

```typescript
async function callClaudeWithValidation(cli, prompt, options = {}) {
  const { maxRetries = 2 } = options;

  for (let i = 0; i <= maxRetries; i++) {
    const response = await cli.prompt(prompt);
    const validation = validateResponse(response);

    if (validation.valid) {
      return response;
    }

    // 追加约束提醒重新生成
    prompt += `\n\n**重要提醒**：${validation.reason}。请重新回答，不要执行任何 git 命令。`;
  }

  throw new Error('Claude 响应验证失败，已达到最大重试次数');
}
```

---

## 文件结构

```
src/claude/prompts/
└── index.ts          # 统一提示词模块

src/handlers/
├── comment.ts        # 评论问答 (comment-issue, comment-mr)
├── analyze-issue.ts   # Issue 自动分析
├── review.ts         # 代码审查
└── create-mr.ts     # 创建 MR
```

---

## 验证清单

### 功能
- [ ] Issue 评论 `@claude 解释代码` → 仅回复，不修改
- [ ] Issue 评论 `@claude 帮我实现这个功能` → Claude 判断需代码实现 → 系统自动创建 MR
- [ ] MR 评论 `@claude 加个日志` → Claude 判断需代码实现 → 系统提交到源分支
- [ ] Issue 创建 → 自动分析并打标签
- [ ] MR 打开 → 自动审查并发表意见

### 约束
- [ ] Claude 尝试执行 git 命令 → 验证失败，重新生成
- [ ] 响应包含禁止模式 → 重试机制触发
- [ ] 分支名符合规范 → `{category}/issue-{iid}-{desc}`

### 约束
- [ ] Claude 尝试执行 git 命令 → 验证失败，重新生成
- [ ] 响应包含禁止模式 → 重试机制触发
- [ ] 分支名符合规范 → `{category}/issue-{iid}-{desc}`

---

## 术语表

| 术语 | 说明 |
|------|------|
| `Edit` | Claude Code 工具，修改文件中的代码片段 |
| `Write` | Claude Code 工具，写入或覆盖文件 |
| `force-with-lease` | Git 推送选项，比 force 更安全 |
| `category` | Issue 分析结果的分类（新功能/优化/修复/无关） |
