# Claude GitLab Agent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](src)

[English](README_EN.md) | [中文](README.md)

AI-powered assistant deeply integrated into GitLab, enabling teams to interact with Claude via natural language for code review, Q&A, and MR creation.

## Features

### 1. @claude Intelligent Q&A

- Triggered by mentioning `@claude <instruction>` in Issue or MR comments
- Claude autonomously decides whether code modifications are needed
- Supports code explanation, error analysis, optimization suggestions, review requests, and more

### 2. Automatic Code Review

- Automatically triggered when MR is created or reopened
- Outputs structured review feedback (🔴 Blocking / 🟡 Suggestion / 🟢 Optimization)

### 3. Issue Auto-Analysis

- Automatically triggered when Issue is created
- Claude reads codebase and analyzes Issue relevance
- Generates Markdown design document posted to Issue comments

### 4. Create MR from Issue

- Triggered by `@claude /create-mr` or equivalent natural language
- Claude analyzes Issue, generates code, creates branch and MR

## Quick Start

### Requirements

- Node.js 20+ **or** Docker + Docker Compose
- Redis 7+ (automatically included in Docker Compose mode)
- GitLab Account + Personal Access Token
- Claude CLI (automatically included in Docker mode)

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd claude-gitlab-agent

# Install dependencies
npm install

# Copy environment config
cp .env.example .env
```

### Configuration

Edit `.env` file:

```env
# GitLab Configuration
GITLAB_URL=https://gitlab.com
GITLAB_ACCESS_TOKEN=your-gitlab-access-token

# Claude Configuration
ANTHROPIC_API_KEY=your-anthropic-api-key

# Security (Webhook Verification)
WEBHOOK_SECRET=your-webhook-secret
```

### Running

#### Local Mode

```bash
# Development mode (requires dependencies installed)
npm install
npm run dev

# Production mode
npm run build
npm start
```

#### Docker Compose Mode (Recommended)

```bash
# Configure environment
cp .env.example .env
# Edit .env with your configuration

# Start all services (app + Redis)
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

#### Docker Compose Dev Mode

Use `scripts/dev-compose.yml` for hot reload development:

```bash
docker-compose -f scripts/dev-compose.yml up -d
```

#### Docker Standalone

```bash
# Build image
docker build -t claude-gitlab-agent .

# Run (requires Redis)
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

### Configure GitLab Webhook

1. Go to GitLab project → Settings → Webhooks
2. Add Webhook:
   - URL: `https://your-domain.com/webhook`
   - Secret Token: match `WEBHOOK_SECRET`
   - Triggers: Issue events, Merge request events, Comment events

## Project Structure

```
src/
├── config/          # Configuration management
├── gitlab/          # GitLab API client
├── handlers/        # Business logic handlers
│   ├── comment.ts  # Comment Q&A (with autonomous code modification)
│   ├── analyze-issue.ts # Issue auto-analysis and design doc generation
│   ├── review.ts   # Automatic code review
│   └── create-mr.ts # Create MR from Issue
├── webhook/         # Webhook server
├── workspace/       # Workspace management
├── claude/         # Claude CLI wrapper
├── metrics/         # Prometheus metrics
└── utils/           # Utilities
```

## API Endpoints

| Endpoint    | Method | Description                |
|-------------|--------|----------------------------|
| `/webhook`  | POST   | GitLab Webhook receiver    |
| `/health`   | GET    | Health check               |
| `/metrics`  | GET    | Prometheus metrics         |

## Project-Level Configuration

Configure CI/CD variables in GitLab project:

| Variable                       | Default     | Description                  |
| ------------------------------ | ----------- | ---------------------------- |
| `CLAUDE_ENABLED`               | true        | Enable Claude                |
| `CLAUDE_AUTO_REVIEW_ENABLED`  | true        | Enable auto review           |
| `CLAUDE_CREATE_MR_ENABLED`    | false       | Allow MR creation            |
| `CLAUDE_BOT_USERNAME`          | claude-bot  | Bot username                 |
| `CLAUDE_MAX_REVIEW_FILES`     | 20          | Max files to review          |

## Development

```bash
# Type check
npm run typecheck

# Run tests
npm test

# Build
npm run build
```

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for how to get involved.

## Security

If you discover a security vulnerability, please see [SECURITY.md](SECURITY.md) for reporting guidelines.

## License

MIT License - see [LICENSE](LICENSE) for details.
