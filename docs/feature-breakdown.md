# 功能拆分方案

## 概述

按照「每个功能可独立验证」和「先 GitLab 交互基础，后 Claude Code 集成」的原则，将 PRD 功能拆分为以下阶段。

---

## Phase 1: GitLab 交互基础（不依赖 Claude Code）

### 1.1 Webhook 接收与签名验证

**功能描述**：接收 GitLab Webhook 事件，验证请求签名。

**验收标准**：
- [ ] 正确接收 GitLab `issue`、`merge_request`、`note` 事件
- [ ] 使用正确 Token 签名时返回 200，错误时返回 401
- [ ] 事件类型识别正确，payload 解析正确

**实现位置**：`internal/webhook/`

**依赖**：无

---

### 1.2 GitLab API 基础客户端

**功能描述**：封装 GitLab API v4 基础能力。

**验收标准**：
- [ ] 获取 Issue 详情（标题、描述、评论、状态）
- [ ] 获取 MR 详情（标题、描述、diff、评论）
- [ ] 在 Issue/MR 下发表评论
- [ ] 获取项目信息

**实现位置**：`internal/gitlab/`

**依赖**：无

---

### 1.3 工作空间管理

**功能描述**：管理独立工作空间（仓库克隆、状态重置、清理）。

**验收标准**：
- [ ] 首次触发时克隆仓库到 `WORKSPACE_ROOT/workspace-<type>-<project_id>-<iid>`
- [ ] 复用时执行 `git fetch && git reset --hard origin/<default_branch>` 重置状态
- [ ] 关闭事件触发时删除工作空间目录
- [ ] 超时清理（24小时空闲）正常工作
- [ ] 磁盘占用不超过 500MB/工作空间

**实现位置**：`internal/workspace/`

**依赖**：1.1, 1.2

---

## Phase 2: Claude Code 集成基础

### 2.1 Claude CLI 调用封装

**功能描述**：封装 Claude CLI 调用，支持发送提示词并获取响应。

**验收标准**：
- [ ] 调用 `claude --print` 执行简单提示词并获取输出
- [ ] 支持工作空间目录作为工作目录
- [ ] 超时机制正常工作（默认 5 分钟）
- [ ] 错误捕获正确（超时、CLI 不存在等）

**实现位置**：`internal/claude/`

**依赖**：Phase 1

---

## Phase 3: 业务功能（集成验证）

### 3.1 评论问答 `@claude`

**功能描述**：用户在 Issue/MR 评论 `@claude <指令>`，Claude 自主判断是否修改代码并自动提交。

**验收标准**：
- [ ] 正确识别 `@claude` 指令（大小写不敏感）
- [ ] 无指令时返回引导提示
- [ ] 调用 Claude CLI 获取回答
- [ ] 在原位置发表回复评论（以 `🤖 Claude 回复：` 开头）
- [ ] Claude 自主决定是否修改代码
- [ ] MR 中代码变更自动提交到源分支
- [ ] Issue 中代码变更自动创建新分支提交 MR
- [ ] 回复末尾包含 JSON 格式状态（code_changed, summary, commit_message, create_mr）
- [ ] 端到端延迟 ≤ 15 秒（P95）

**实现位置**：`src/handlers/comment.ts`

**依赖**：1.1, 1.2, 2.1

**Claude Code 介入点**：
- 代码解释、错误日志分析、单元测试生成、代码优化建议、CI/CD 配置问题回答
- 自主决定是否修改代码

---

### 3.1.1 Issue 自动分析

**功能描述**：Issue 创建时自动分析并生成设计文档。

**验收标准**：
- [ ] Issue `opened` 事件触发分析
- [ ] 不响应 `reopen` 事件
- [ ] 阅读代码库分析 Issue 关联性
- [ ] 输出 Markdown 格式设计文档
- [ ] 发布到 Issue 评论区

**实现位置**：`src/handlers/analyze-issue.ts`

**依赖**：1.1, 1.2, 2.1

---

### 3.2 自动代码审查

**功能描述**：非 Claude 创建的 MR 被打开/重新打开时，自动获取 diff 并发表审查意见。

**验收标准**：
- [ ] 仅响应 `opened`/`reopened` 事件，不响应 `update`
- [ ] 跳过 Claude 自己创建的 MR
- [ ] 获取完整 diff 内容
- [ ] 调用 Claude CLI 进行审查
- [ ] 发表结构化评论（🔴🟡🟢 严重程度标记）
- [ ] 超过 `max_review_files` 时拒绝审查
- [ ] 端到端延迟 ≤ 30 秒（P95）

**实现位置**：`internal/handler/review.go`

**依赖**：1.1, 1.2, 2.1

**Claude Code 介入点**：
- 逻辑错误检测、性能问题检测、安全隐患检测、代码风格建议、可读性分析、测试覆盖建议

---

### 3.3 基于 Issue 创建 MR

**功能描述**：Issue 中 `@claude /create-mr` 或等效自然语言，Claude 生成代码并创建 MR。

**验收标准**：
- [ ] 精确命令 `/create-mr` 和自然语言意图均可触发
- [ ] Issue 必须为 `opened` 状态
- [ ] 分支命名：`claude/issue-<iid>-<short_desc>`
- [ ] 提交信息包含 `#<issue_iid>`
- [ ] MR 标题格式：`[Claude] <Issue 标题>`
- [ ] MR 描述包含变更说明、测试情况、人工复核提醒
- [ ] 在 Issue 下回复 MR 链接
- [ ] 项目需 `create_mr_enabled=true` 配置
- [ ] 端到端延迟 ≤ 5 分钟（P90）
- [ ] 失败场景正确处理（描述不清晰、仓库不可访问、超时、测试失败等）

**实现位置**：`internal/handler/create_mr.go`

**依赖**：Phase 1 + Phase 2

**Claude Code 介入点**：
- 分析 Issue 内容
- 确定需要修改/新增的文件
- 使用 Edit/Write 工具修改代码
- 运行测试并确保通过
- git add/commit/push 操作
- 生成变更说明

---

## Phase 4: 配套功能

### 4.1 健康检查端点

**验收标准**：
- [ ] `GET /health` 返回 200，JSON 包含 `status: "ok"`

**实现位置**：`internal/server/`

---

### 4.2 Prometheus 指标暴露

**验收标准**：
- [ ] `claude_webhook_requests_total{event_type}`
- [ ] `claude_task_duration_seconds{task_type}`
- [ ] `claude_task_success_total` / `failed_total`
- [ ] `claude_workspace_count`

**实现位置**：`internal/metrics/`

---

### 4.3 项目级配置管理

**验收标准**：
- [ ] 支持通过 GitLab 项目自定义属性配置 `claude_enabled`、`auto_review_enabled`、`create_mr_enabled`
- [ ] 配置读取正确生效

**实现位置**：`internal/config/project.go`

---

## 功能依赖关系图

```
Phase 1: GitLab 交互基础
├── 1.1 Webhook 接收与签名验证
├── 1.2 GitLab API 基础客户端
└── 1.3 工作空间管理
    └── 依赖: 1.1, 1.2

Phase 2: Claude Code 集成基础
└── 2.1 Claude CLI 调用封装
    └── 依赖: Phase 1

Phase 3: 业务功能
├── 3.1 评论问答 @claude
│   └── 依赖: 1.1, 1.2, 2.1
├── 3.1.1 Issue 自动分析
│   └── 依赖: 1.1, 1.2, 2.1
├── 3.2 自动代码审查
│   └── 依赖: 1.1, 1.2, 2.1
└── 3.3 基于 Issue 创建 MR
    └── 依赖: Phase 1 + Phase 2

Phase 4: 配套功能
├── 4.1 健康检查端点
├── 4.2 Prometheus 指标暴露
└── 4.3 项目级配置管理
```

---

## 验证顺序建议

1. **第一轮独立验证**：
   - 1.1 Webhook 接收（用 curl 手动发 Webhook 测试）
   - 1.2 GitLab API 客户端（写单元测试 mock HTTP）
   - 1.3 工作空间管理（手动创建/删除目录测试）
   - 2.1 Claude CLI 封装（直接调用 claude --print 测试）
   - 4.1 健康检查（curl /health）

2. **第二轮集成验证**：
   - 3.1 评论问答（创建测试 Issue，真实触发）
   - 3.2 自动代码审查（创建测试 MR，真实触发）
   - 4.2 + 4.3

3. **第三轮端到端验证**：
   - 3.3 基于 Issue 创建 MR（完整流程）
   - 性能测试
   - 安全测试

---

## 风险与注意事项

1. **Phase 1 必须独立验证通过再进入 Phase 2**，否则问题定位困难
2. **Phase 3.3 创建 MR 是高风险操作**，需要项目配置 `create_mr_enabled=true`
3. **每个功能完成后应立即验证**，不要等到所有代码写完再测试
4. **Claude Code 介入点** 主要在 3.1、3.2、3.3 的 CLI 调用环节
