# Contributing to Claude GitLab Agent

Thank you for your interest in contributing to Claude GitLab Agent!

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/your-username/claude-gitlab-agent.git`
3. Install dependencies: `npm install`
4. Copy environment config: `cp .env.example .env`
5. Make your changes

## Development

```bash
# Run in development mode with hot reload
npm run dev

# Run type checks
npm run typecheck

# Run tests
npm test

# Build for production
npm run build
```

## Docker Development

```bash
# Start with hot reload support
docker-compose -f scripts/dev-compose.yml up -d

# View logs
docker-compose logs -f
```

## Pull Request Process

1. **Create a feature branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** following the coding standards:
   - Use TypeScript
   - Run `npm run typecheck` before committing
   - Add tests for new functionality
   - Keep changes focused and atomic

3. **Commit your changes** with clear messages:
   - Use clear, descriptive commit messages
   - Reference issues when applicable (e.g., "Fix issue #123")

4. **Push to your fork** and create a Pull Request

5. **Fill out the PR template**:
   - Describe what the change does
   - Explain why this change is needed
   - List any breaking changes
   - Add screenshots for UI changes

## Coding Standards

- **TypeScript**: Use strict mode, avoid `any` types
- **Error Handling**: Always handle errors with appropriate error messages
- **Logging**: Use the provided logger utility (`src/utils/logger.ts`)
- **GitLab API**: Use the existing GitLab client (`src/gitlab/`)
- **Tests**: Place tests in `tests/` directory, follow naming `*.test.ts`

## Project Structure

```
src/
├── config/          # Configuration management
├── gitlab/          # GitLab API client
├── handlers/        # Business logic handlers
├── webhook/         # Webhook server
├── workspace/       # Workspace management
├── claude/          # Claude CLI wrapper
├── metrics/         # Prometheus metrics
└── utils/           # Utilities
```

## Reporting Issues

- Use GitLab Issues
- Search existing issues before creating new ones
- Include environment details (Node.js version, Docker version, etc.)
- Provide minimal reproduction steps

## Questions?

Feel free to open a discussion or reach out to the maintainers.
