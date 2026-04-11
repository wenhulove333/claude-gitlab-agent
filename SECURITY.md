# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT** create a public GitLab issue for security vulnerabilities
2. Send a private vulnerability report to the maintainers
3. Include as much detail as possible:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Any suggested fixes

## Security Best Practices

When deploying Claude GitLab Agent:

- **Never commit** `.env` files or access tokens to version control
- **Use Webhook secrets** for validating GitLab webhook requests
- **Restrict access** to Redis instances
- **Rotate API keys** regularly
- **Monitor** the `/metrics` endpoint for unusual activity
- **Use HTTPS** in production environments

## Sensitive Data Handling

This application handles sensitive credentials:
- GitLab Personal Access Token
- Anthropic API Key
- Webhook Secret

All sensitive configuration is managed through environment variables and is never logged or exposed through APIs.
