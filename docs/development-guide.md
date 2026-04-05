# Claude GitLab Agent 开发规范

## 1. 项目架构

### 1.1 技术栈

- **语言**：TypeScript（Node.js 20+）
- **运行时**：Node.js 原生 ES Modules
- **Web 框架**：Hono（轻量、类型安全、支持中间件）
- **HTTP 客户端**：Ky（简洁的 fetch 封装）
- **Git 操作**：simple-git
- **任务队列**：BullMQ + Redis
- **配置管理**：dotenv + zod（运行时校验）
- **日志**：Pino
- **测试**：Vitest
- **容器**：Docker + Docker Compose

### 1.2 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                      GitLab Webhook                          │
│                   (issue, merge_request, note)                │
└─────────────────────┬───────────────────────────────────────┘
                      │ HTTP POST
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    Webhook Server                           │
│                   (Hono + 签名验证)                          │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ issue_hook   │  │ mr_hook      │  │ note_hook    │       │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘       │
└─────────┼─────────────────┼─────────────────┼───────────────┘
          │                 │                 │
          ▼                 ▼                 ▼
┌─────────────────────────────────────────────────────────────┐
│                      Task Queue                             │
│                    (BullMQ + Redis)                          │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    Task Workers                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ comment_task │  │ review_task  │  │ create_mr_task│      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘       │
└─────────┼─────────────────┼─────────────────┼───────────────┘
          │                 │                 │
          ▼                 ▼                 ▼
┌─────────────────────────────────────────────────────────────┐
│                    Service Layer                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │GitLab Service│  │Claude Service│  │Workspace Svc │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 数据流

1. **Webhook 接收**：Hono 服务器接收 GitLab Webhook 请求
2. **签名验证**：校验 `X-Gitlab-Token` 或 `X-Hub-Signature-256`
3. **事件分发**：根据 `object_kind` 分发到不同处理器
4. **任务入队**：将任务加入 BullMQ 队列
5. **异步执行**：Worker 从队列取任务，执行具体业务逻辑
6. **外部调用**：调用 GitLab API 或 Claude CLI
7. **结果发布**：通过 GitLab API 发表回复评论

---

## 2. 项目结构

```
claude-gitlab-agent/
├── src/
│   ├── index.ts                    # 应用入口
│   ├── server.ts                   # HTTP 服务器
│   │
│   ├── webhook/                    # Webhook 相关
│   │   ├── server.ts               # Webhook 服务器
│   │   ├── verify.ts               # 签名验证
│   │   ├── router.ts               # 事件路由
│   │   ├── processor.ts            # 事件处理器（集成业务逻辑）
│   │   └── types.ts                # Webhook 类型定义
│   │
│   ├── gitlab/                     # GitLab API 客户端
│   │   ├── client.ts                # API 基础客户端
│   │   ├── types.ts                 # GitLab API 类型
│   │   ├── issue.ts                 # Issue 相关 API
│   │   ├── merge-request.ts         # MR 相关 API
│   │   ├── note.ts                  # 评论相关 API
│   │   └── project.ts               # 项目相关 API
│   │
│   ├── claude/                     # Claude CLI 封装
│   │   ├── cli.ts                   # CLI 调用封装
│   │   └── types.ts                 # Claude 类型定义
│   │
│   ├── workspace/                  # 工作空间管理
│   │   ├── manager.ts               # 工作空间管理器
│   │   ├── cleaner.ts               # 清理任务
│   │   └── types.ts                 # 工作空间类型
│   │
│   ├── handlers/                   # 业务处理器
│   │   ├── index.ts                # 导出入口
│   │   ├── comment.ts              # 评论问答（支持自主代码修改）
│   │   ├── analyze-issue.ts         # Issue 创建时自动分析
│   │   ├── review.ts               # 自动代码审查
│   │   ├── create-mr.ts            # 基于 Issue 创建 MR
│   │   └── code-generation.ts      # 代码生成逻辑
│   │
│   ├── config/                     # 配置管理
│   │   ├── index.ts                 # 配置加载入口
│   │   ├── env.ts                   # 环境变量定义
│   │   └── schema.ts                # Zod 校验 schema
│   │
│   ├── metrics/                    # 可观测性
│   │   └── index.ts                 # Prometheus 指标
│   │
│   └── utils/                      # 工具函数
│       ├── logger.ts               # Pino logger
│       └── errors.ts               # 自定义错误类型
│
├── tests/
│   ├── unit/                       # 单元测试
│   └── integration/                # 集成测试
│
├── scripts/
│   └── dev-compose.yml             # 开发用 Docker Compose
│
├── docs/
│   ├── prd.md                      # 产品需求文档
│   └── development-guide.md        # 本文档
│
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── .env.example
```

---

## 3. 代码规范

### 3.1 TypeScript 规范

- **严格模式**：启用 `strict: true`
- **ES Modules**：使用 `import/export`，不使用 CommonJS
- **类型定义**：
  - 所有函数参数和返回值必须有类型
  - 使用 `interface` 定义对象类型
  - 使用 `type` 定义联合类型、交叉类型
  - 禁止使用 `any`，必须使用 `unknown` 替代
- **命名**：
  - 类型/接口：`PascalCase`
  - 变量/函数：`camelCase`
  - 常量：`UPPER_SNAKE_CASE`
  - 文件名：`kebab-case.ts`

### 3.2 错误处理

```typescript
// 使用自定义错误类
class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// 具体错误类型
class GitLabAPIError extends AppError {
  constructor(message: string, public response: Response) {
    super(message, 'GITLAB_API_ERROR', 502);
  }
}

class WebhookVerificationError extends AppError {
  constructor(message: string) {
    super(message, 'WEBHOOK_VERIFICATION_FAILED', 401);
  }
}

class WorkspaceError extends AppError {
  constructor(message: string) {
    super(message, 'WORKSPACE_ERROR', 500);
  }
}

class ClaudeCLIError extends AppError {
  constructor(message: string, public exitCode: number) {
    super(message, 'CLAUDE_CLI_ERROR', 500);
  }
}
```

### 3.3 日志规范

```typescript
import { logger } from './utils/logger';

// 结构化日志输出
logger.info({ event: 'webhook_received', event_type: 'issue' }, 'Webhook received');
logger.error({ event: 'task_failed', task_type: 'review', error: err.message }, 'Task failed');

// 日志字段约定
interface LogFields {
  event: string;           // 事件名称
  [key: string]: unknown;  // 额外上下文
}
```

### 3.4 日志级别使用

| 级别 | 使用场景 |
|------|---------|
| `debug` | 详细调试信息（payload 内容、变量值） |
| `info` | 正常流程（任务开始/结束、Webhook 接收） |
| `warn` | 警告情况（配置缺失、限流触发） |
| `error` | 错误（API 失败、CLI 错误） |

### 3.5 函数设计

```typescript
// 单一职责原则
// ✅ 好的设计
async function getIssue(projectId: number, issueIid: number): Promise<Issue> {
  const client = getGitLabClient();
  return client.getIssue(projectId, issueIid);
}

// ❌ 避免：职责过多
async function getIssueAndVerifyAndNotify(projectId: number, issueIid: number): Promise<void> {
  // ...
}

// 异步函数必须正确处理错误
async function fetchWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await sleep(Math.pow(2, i) * 100); // 指数退避
    }
  }
  throw new Error('Unreachable');
}
```

### 3.6 Git 操作规范

```typescript
import simpleGit, { SimpleGit } from 'simple-git';

// 所有 Git 操作必须指定工作目录
const git: SimpleGit = simpleGit('/path/to/workspace');
await git.clone(url, directory, ['--depth=1']);
await git.fetch('origin', 'main');
await git.reset(['--hard', 'origin/main']);
```

---

## 4. API 设计

### 4.1 Webhook 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/webhook` | POST | GitLab Webhook 接收端点 |
| `/health` | GET | 健康检查 |

### 4.2 Webhook 事件类型

```typescript
type GitLabEventType =
  | 'issue'
  | 'merge_request'
  | 'note';

interface WebhookPayload {
  object_kind: GitLabEventType;
  event_type: string;
  project: Project;
  // ... 事件特定字段
}
```

### 4.3 GitLab API 封装

```typescript
// 基础客户端
class GitLabClient {
  constructor(private baseUrl: string, private token: string) {}

  async request<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/v4${path}`, {
      ...options,
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      throw new GitLabAPIError(`GitLab API error: ${response.statusText}`, response);
    }

    return response.json() as T;
  }
}

// 使用示例
const issue = await gitlab.request<Issue>(`/projects/${projectId}/issues/${issueIid}`);
const notes = await gitlab.request<Note[]>(`/projects/${projectId}/issues/${issueIid}/notes`);
```

---

## 5. 配置管理

### 5.1 环境变量定义

```typescript
// config/schema.ts
import { z } from 'zod';

export const envSchema = z.object({
  // 服务配置
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // GitLab 配置
  GITLAB_URL: z.string().url().default('https://gitlab.com'),
  GITLAB_ACCESS_TOKEN: z.string().min(1),

  // Claude 配置
  ANTHROPIC_API_KEY: z.string().min(1),

  // 安全配置
  WEBHOOK_SECRET: z.string().optional(),

  // 工作空间配置
  WORKSPACE_ROOT: z.string().default('/data/workspaces'),
  WORKSPACE_TTL_HOURS: z.coerce.number().default(24),
  MAX_WORKSPACES: z.coerce.number().default(50),

  // Redis 配置
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Claude CLI 配置
  CLI_TIMEOUT_SECONDS: z.coerce.number().default(120),
  CLI_HEARTBEAT_INTERVAL: z.coerce.number().default(30),
  USE_DOCKER_ISOLATION: z.coerce.boolean().default(false),
});

// 校验后的类型
export type Env = z.infer<typeof envSchema>;
```

### 5.2 配置加载

```typescript
// config/index.ts
import { envSchema, type Env } from './schema';

let cachedConfig: Env | null = null;

export function getConfig(): Env {
  if (cachedConfig) return cachedConfig;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Invalid environment variables: ${result.error.format()}`);
  }

  cachedConfig = result.data;
  return cachedConfig;
}
```

---

## 6. 测试规范

### 6.1 测试框架

使用 **Vitest** 作为测试框架。

### 6.2 单元测试

```typescript
// tests/unit/claude-cli.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ClaudeCLI } from '../../src/claude/cli';

describe('ClaudeCLI', () => {
  it('should call claude --print with correct arguments', async () => {
    const cli = new ClaudeCLI();
    // mock child_process
    const result = await cli.execute({
      prompt: 'Hello, world!',
      workspace: '/tmp/test',
    });
    expect(result).toBe('Hello!');
  });
});
```

### 6.3 集成测试

```typescript
// tests/integration/webhook.test.ts
import { describe, it, expect } from 'vitest';

describe('Webhook Server', () => {
  it('should return 200 for valid webhook', async () => {
    const payload = { object_kind: 'issue', /* ... */ };
    const signature = await generateSignature(payload);

    const response = await fetch('/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gitlab-Token': 'test-token',
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
  });
});
```

### 6.4 测试覆盖率要求

- 核心业务逻辑：≥ 80%
- 工具函数：≥ 90%
- Webhook 路由：100%

---

## 7. Docker 容器规范

### 7.1 开发环境

```yaml
# scripts/dev-compose.yml
version: '3.8'

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile.dev
    volumes:
      - .:/app
      - /app/node_modules
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=development
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

### 7.2 Docker 隔离（生产）

Claude CLI 在独立容器中运行，限制资源。

---

## 8. 代码审查清单

提交 PR 前检查：

- [ ] TypeScript 编译无错误（`npm run build`）
- [ ] 所有测试通过（`npm test`）
- [ ] 日志输出合理（无敏感信息）
- [ ] 错误处理完整
- [ ] 注释更新（如有必要）
- [ ] CHANGELOG 更新（如有必要）

---

## 9. Git 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <subject>

feat(webhook): add signature verification
fix(claude): handle timeout error
docs(config): add environment variable description
test(workspace): add unit tests for cleaner
refactor(gitlab): extract API client to separate module
```

---

## 10. 开发流程

1. **分支命名**：`feature/<功能名>` 或 `fix/<问题名>`
2. **开发**：在功能分支开发
3. **测试**：本地验证
4. **提交**：使用 Conventional Commits
5. **PR**：创建 Pull Request
6. **审查**：代码审查通过后合并

---

## 11. 注意事项

1. **禁止在代码中硬编码敏感信息**，使用环境变量
2. **禁止提交 `.env` 文件**，仅提交 `.env.example`
3. **所有异步操作必须 await**，不允许忽略 Promise
4. **Git 操作必须指定工作目录**
5. **日志需包含上下文字段**，便于追踪
6. **错误信息不泄露敏感信息**（如 Token）
