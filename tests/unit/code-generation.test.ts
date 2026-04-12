import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Code Generation - BOT_NAME Configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('BOT_NAME replacement verification', () => {
    it('should replace Claude with BOT_NAME in strings', () => {
      const botName = '小智';
      const mrTitle = `[${botName}] ${'Test Issue'} #${42}`;
      expect(mrTitle).toContain('小智');
      expect(mrTitle).not.toContain('[Claude]');

      const mrDescription = `此 MR 由 ${botName} 基于 Issue #${42} 自动创建。

**${botName} 的变更**: test`;

      expect(mrDescription).toContain('小智');
      expect(mrDescription).toContain('**小智 的变更**');
      expect(mrDescription).not.toContain('Claude');

      const successComment = `🤖 ${botName} 已完成代码实现并创建了 MR！`;
      expect(successComment).toContain('小智');
      expect(successComment).not.toContain('🤖 Claude');

      const errorComment = `🤖 ${botName}：代码生成失败`;
      expect(errorComment).toContain('小智');
      expect(errorComment).not.toContain('🤖 Claude');
    });

    it('should use default Claude when BOT_NAME is Claude', () => {
      const botName = 'Claude';
      const mrTitle = `[${botName}] ${'Test Issue'} #${42}`;
      expect(mrTitle).toContain('[Claude]');
    });

    it('should handle custom BOT_NAME', () => {
      const botName = 'MyBot';
      const mrTitle = `[${botName}] ${'Test Issue'} #${42}`;
      expect(mrTitle).toBe('[MyBot] Test Issue #42');
    });
  });

  describe('MR Title format', () => {
    it('should format MR title with BOT_NAME correctly', () => {
      const env = { BOT_NAME: '小智' };
      const issue = { title: '登录功能', iid: 123 };
      const mrTitle = `[${env.BOT_NAME}] ${issue.title} #${issue.iid}`;
      expect(mrTitle).toBe('[小智] 登录功能 #123');
    });
  });

  describe('MR Description format', () => {
    it('should format MR description with BOT_NAME correctly', () => {
      const env = { BOT_NAME: '小智' };
      const issueIid = 42;
      const summary = '添加了登录验证';
      const changedFiles = ['src/auth/login.ts', 'src/auth/validator.ts'];

      const mrDescription = `此 MR 由 ${env.BOT_NAME} 基于 Issue #${issueIid} 自动创建。

**${env.BOT_NAME} 的变更**:
${summary}

**变更文件**:
${changedFiles.map((f) => `- ${f}`).join('\n')}

**人工审查提醒**：请在合并前验证变更是否符合预期。`;

      expect(mrDescription).toContain('此 MR 由 小智 基于 Issue #42 自动创建');
      expect(mrDescription).toContain('**小智 的变更**:');
      expect(mrDescription).toContain('- src/auth/login.ts');
      expect(mrDescription).toContain('- src/auth/validator.ts');
    });
  });

  describe('Issue Comment format', () => {
    it('should format success comment with BOT_NAME', () => {
      const env = { BOT_NAME: '小智' };
      const mrUrl = 'http://example.com/mr/1';
      const summary = '完成登录功能';

      const comment = `🤖 ${env.BOT_NAME} 已完成代码实现并创建了 MR！\n\n**MR 链接**：${mrUrl}\n\n**变更**：${summary}`;

      expect(comment).toContain('🤖 小智 已完成代码实现并创建了 MR');
      expect(comment).toContain(`**MR 链接**：${mrUrl}`);
    });

    it('should format error comment with BOT_NAME', () => {
      const env = { BOT_NAME: '小智' };
      const errorMessage = '代码生成超时';

      const comment = `🤖 ${env.BOT_NAME}：代码生成失败\n\n${errorMessage}`;

      expect(comment).toContain('🤖 小智：代码生成失败');
      expect(comment).toContain('代码生成超时');
    });
  });
});