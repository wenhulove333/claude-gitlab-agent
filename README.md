# Claude GitLab Agent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](src)

[English](README_EN.md) | [中文](README.md)

深度集成于 GitLab 的 AI 助手，通过自然语言交互完成代码审查、问答和 MR 创建。

<!-- 非功能性空行 -->

## 功能特性

### 1. @claude 智能问答

- 在 Issue 或 MR 评论中 `@claude <指令>` 触发
- Claude 自主判断是否需要修改代码，如需修改则自动提交到 MR 源分支或创建新分支提交 MR
- 支持代码解释、错误分析、代码优化、Review 请求等任意问答场景
- **会话持久化**：同一 Issue/MR 的多次交互共享 Claude 会话，保持上下文连续性
- **智能工作空间关联**：MR 评论优先使用其关联 Issue 的工作空间，确保代码一致性

### 2. 自动代码审查

- MR 创建或重新打开时自动触发
- 输出结构化审查意见（🔴 阻塞 / 🟡 建议 / 🟢 优化）

### 3. Issue 自动分析

- Issue 创建时自动触发
- Claude 阅读代码库并分析 Issue 关联性
- 生成 Markdown 格式设计文档发布到 Issue 评论

### 4. 增强特性

- **进程心跳监控**：实时监控 Claude CLI 执行状态，支持长时间运行任务
- **智能超时处理**：基于子进程活动动态判断超时，避免任务被意外终止

## 快速开始

### 环境要求

- Node.js 20+ **或** Docker + Docker Compose
- Redis 7+（Docker Compose 模式自动包含）
- GitLab Account + Personal Access Token
- Claude CLI（Docker 模式自动包含）

### 安装

```bash
# 克隆项目
git clone <repository-url>
cd claude-gitlab-agent

# 安装依赖
npm install

# 复制环境变量配置
cp .env.example .env
```

### 配置

编辑 `.env` 文件：

```env
# GitLab 配置
GITLAB_URL=https://gitlab.com
GITLAB_ACCESS_TOKEN=your-gitlab-access-token

# Claude 配置
ANTHROPIC_API_KEY=your-anthropic-api-key

# 安全配置（Webhook 验证）
WEBHOOK_SECRET=your-webhook-secret

# 工作空间配置
WORKSPACE_ROOT=/data/workspaces
WORKSPACE_TTL_HOURS=24
MAX_WORKSPACES=50

# Redis 配置
REDIS_URL=redis://localhost:6379

# Claude CLI 配置
CLI_TIMEOUT_SECONDS=120
CLI_HEARTBEAT_INTERVAL=30
USE_DOCKER_ISOLATION=false

# Bot 配置
BOT_NAME=Claude
BOT_USERNAME=claude-bot
```

### 启动

#### 本地模式

```bash
# 开发模式（需要先安装依赖）
npm install
npm run dev

# 生产模式
npm run build
npm start
```

#### Docker Compose 模式（推荐）

```bash
# 配置环境变量
cp .env.example .env
# 编辑 .env 填写必要的配置

# 启动所有服务（应用 + Redis）
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

#### 开发模式 Docker Compose

使用 `scripts/dev-compose.yml` 支持热重载开发：

```bash
docker-compose -f scripts/dev-compose.yml up -d
```

#### Docker 单独运行

```bash
# 构建镜像
docker build -t claude-gitlab-agent .

# 运行（需要 Redis）
docker run -d \
  --name claude-gitlab-agent \
  -p 3000:3000 \
  -e GITLAB_URL=https://gitlab.com \
  -e GITLAB_ACCESS_TOKEN=your-token \
  -e ANTHROPIC_API_KEY=your-key \
  -e REDIS_URL=redis://host.docker.internal:6379 \
  -v $(pwd)/workspaces:/data/workspaces \
  claude-gitlab-agent
```

### 配置 GitLab Webhook

1. 进入 GitLab 项目 → Settings → Webhooks
2. 添加 Webhook：
   - URL: `https://your-domain.com/webhook`
   - Secret Token: 与 `WEBHOOK_SECRET` 一致
   - 触发事件: Issue events, Merge request events, Comment events

## 项目结构

```
src/
├── config/          # 配置管理
├── gitlab/         # GitLab API 客户端
├── handlers/       # 业务处理器
│   ├── comment.ts  # 评论问答（支持自主代码修改 + 会话管理）
│   ├── analyze-issue.ts # Issue 创建时自动分析生成设计文档
│   └── review.ts   # 自动审查
├── webhook/        # Webhook 服务器
├── workspace/      # 工作空间管理
├── claude/         # Claude CLI 封装
│   ├── cli.ts      # Claude CLI 执行器（支持会话恢复 + 心跳监控）
│   └── prompts/    # 统一提示模板系统
├── metrics/        # Prometheus 指标
└── utils/          # 工具函数
```

## API 端点

| 端点         | 方法   | 说明                |
| ---------- | ---- | ----------------- |
| `/webhook` | POST | GitLab Webhook 接收 |
| `/health`  | GET  | 健康检查              |
| `/metrics` | GET  | Prometheus 指标     |

## 项目级配置

在 GitLab 项目中设置 CI/CD 变量：

| 变量名                          | 默认值        | 说明          |
| ---------------------------- | ---------- | ----------- |
| `CLAUDE_ENABLED`             | true       | 是否启用 Claude |
| `CLAUDE_AUTO_REVIEW_ENABLED` | true       | 是否启用自动审查    |
| `CLAUDE_BOT_USERNAME`        | claude-bot | Bot 用户名     |
| `CLAUDE_MAX_REVIEW_FILES`    | 20         | 最大审查文件数     |

## 开发

```bash
# 类型检查
npm run typecheck

# 运行测试
npm test

# 构建
npm run build
```

## 贡献

欢迎贡献代码！请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解如何参与项目。

## 安全问题

如果您发现安全漏洞，请参阅 [SECURITY.md](SECURITY.md) 了解如何报告。

## License

MIT License - 参阅 [LICENSE](LICENSE) 了解更多详情。
