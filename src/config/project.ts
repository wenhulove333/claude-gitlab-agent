import { logInfo, logDebug, logWarn } from '../utils/logger.js';
import { createGitLabClient } from '../gitlab/index.js';
import { getEnv } from '../config/index.js';

export interface ProjectSettings {
  /** Whether Claude is enabled for this project */
  claudeEnabled: boolean;
  /** Whether auto review is enabled */
  autoReviewEnabled: boolean;
  /** Whether creating MRs is enabled */
  createMREnabled: boolean;
  /** Bot display name (e.g., 小智) */
  botName: string;
  /** Bot GitLab username */
  botUsername: string;
  /** Paths to exclude from auto review */
  excludePaths: string[];
  /** Max files to review */
  maxReviewFiles: number;
  /** Max diff characters for review */
  maxReviewDiffChars: number;
}

const DEFAULT_SETTINGS: ProjectSettings = {
  claudeEnabled: true,
  autoReviewEnabled: true,
  createMREnabled: false, // Off by default for safety
  botName: '小智',
  botUsername: 'claude-bot',
  excludePaths: ['*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
  maxReviewFiles: 20,
  maxReviewDiffChars: 100000,
};

// Cache for project settings (in production, use Redis)
const settingsCache = new Map<number, { settings: ProjectSettings; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get project settings from GitLab project variables or custom attributes
 */
export async function getProjectSettings(projectId: number): Promise<ProjectSettings> {
  // Check cache first
  const cached = settingsCache.get(projectId);
  if (cached && cached.expiresAt > Date.now()) {
    logDebug({ event: 'project_settings_cache_hit', project_id: projectId }, 'Using cached project settings');
    return cached.settings;
  }

  const env = getEnv();
  const gitlab = createGitLabClient({
    baseUrl: env.GITLAB_URL,
    token: env.GITLAB_ACCESS_TOKEN,
  });

  const settings: ProjectSettings = { ...DEFAULT_SETTINGS };

  try {
    // Try to get settings from project CI/CD variables
    // These would be set as project variables in GitLab
    const variableNames = [
      'CLAUDE_ENABLED',
      'CLAUDE_AUTO_REVIEW_ENABLED',
      'CLAUDE_CREATE_MR_ENABLED',
      'CLAUDE_BOT_NAME',
      'CLAUDE_BOT_USERNAME',
      'CLAUDE_EXCLUDE_PATHS',
      'CLAUDE_MAX_REVIEW_FILES',
      'CLAUDE_MAX_REVIEW_DIFF_CHARS',
    ];

    for (const varName of variableNames) {
      try {
        const varResponse = await gitlab.client.request<{ value: string }>(
          `/projects/${projectId}/variables/${varName}`,
          { method: 'GET' }
        );

        const value = (varResponse as unknown as { value: string }).value;

        switch (varName) {
          case 'CLAUDE_ENABLED':
            settings.claudeEnabled = value === 'true';
            break;
          case 'CLAUDE_AUTO_REVIEW_ENABLED':
            settings.autoReviewEnabled = value === 'true';
            break;
          case 'CLAUDE_CREATE_MR_ENABLED':
            settings.createMREnabled = value === 'true';
            break;
          case 'CLAUDE_BOT_NAME':
            settings.botName = value;
            break;
          case 'CLAUDE_BOT_USERNAME':
            settings.botUsername = value;
            break;
          case 'CLAUDE_EXCLUDE_PATHS':
            settings.excludePaths = value.split(',').map((s) => s.trim());
            break;
          case 'CLAUDE_MAX_REVIEW_FILES':
            settings.maxReviewFiles = parseInt(value, 10) || DEFAULT_SETTINGS.maxReviewFiles;
            break;
          case 'CLAUDE_MAX_REVIEW_DIFF_CHARS':
            settings.maxReviewDiffChars = parseInt(value, 10) || DEFAULT_SETTINGS.maxReviewDiffChars;
            break;
        }
      } catch {
        // Variable doesn't exist, use default
        logDebug({ event: 'project_variable_not_found', project_id: projectId, varName }, 'Variable not found');
      }
    }

    // Cache the settings
    settingsCache.set(projectId, {
      settings,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    logInfo(
      { event: 'project_settings_loaded', project_id: projectId },
      `Loaded project settings for project ${projectId}`
    );

    return settings;
  } catch (error) {
    logWarn(
      { event: 'project_settings_load_failed', project_id: projectId, error },
      'Failed to load project settings, using defaults'
    );
    return DEFAULT_SETTINGS;
  }
}

/**
 * Clear cached settings for a project
 */
export function clearProjectSettingsCache(projectId?: number): void {
  if (projectId) {
    settingsCache.delete(projectId);
  } else {
    settingsCache.clear();
  }
}

/**
 * Get the bot name for display in messages
 * Uses project settings if available, otherwise falls back to global BOT_NAME env
 */
export async function getBotName(projectId?: number): Promise<string> {
  if (projectId) {
    const settings = await getProjectSettings(projectId);
    return settings.botName;
  }
  return getEnv().BOT_NAME;
}

/**
 * Get the bot username for GitLab API operations
 * Uses project settings if available, otherwise falls back to global BOT_USERNAME env
 */
export async function getBotUsername(projectId?: number): Promise<string> {
  if (projectId) {
    const settings = await getProjectSettings(projectId);
    return settings.botUsername;
  }
  return getEnv().BOT_USERNAME;
}

/**
 * Update project settings (creates or updates GitLab variables)
 */
export async function updateProjectSettings(
  projectId: number,
  settings: Partial<ProjectSettings>
): Promise<void> {
  const env = getEnv();
  const gitlab = createGitLabClient({
    baseUrl: env.GITLAB_URL,
    token: env.GITLAB_ACCESS_TOKEN,
  });

  const variableMap: Record<string, string> = {};

  if (settings.claudeEnabled !== undefined) {
    variableMap['CLAUDE_ENABLED'] = String(settings.claudeEnabled);
  }
  if (settings.autoReviewEnabled !== undefined) {
    variableMap['CLAUDE_AUTO_REVIEW_ENABLED'] = String(settings.autoReviewEnabled);
  }
  if (settings.createMREnabled !== undefined) {
    variableMap['CLAUDE_CREATE_MR_ENABLED'] = String(settings.createMREnabled);
  }
  if (settings.botName !== undefined) {
    variableMap['CLAUDE_BOT_NAME'] = settings.botName;
  }
  if (settings.botUsername !== undefined) {
    variableMap['CLAUDE_BOT_USERNAME'] = settings.botUsername;
  }
  if (settings.excludePaths !== undefined) {
    variableMap['CLAUDE_EXCLUDE_PATHS'] = settings.excludePaths.join(',');
  }
  if (settings.maxReviewFiles !== undefined) {
    variableMap['CLAUDE_MAX_REVIEW_FILES'] = String(settings.maxReviewFiles);
  }
  if (settings.maxReviewDiffChars !== undefined) {
    variableMap['CLAUDE_MAX_REVIEW_DIFF_CHARS'] = String(settings.maxReviewDiffChars);
  }

  for (const [key, value] of Object.entries(variableMap)) {
    try {
      await gitlab.client.request(`/projects/${projectId}/variables/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
    } catch {
      // Try to create if update fails
      try {
        await gitlab.client.request(`/projects/${projectId}/variables`, {
          method: 'POST',
          body: JSON.stringify({ key, value }),
        });
      } catch (error) {
        logWarn({ event: 'project_variable_set_failed', project_id: projectId, key, error }, 'Failed to set variable');
      }
    }
  }

  // Clear cache so next request gets fresh settings
  clearProjectSettingsCache(projectId);
}
