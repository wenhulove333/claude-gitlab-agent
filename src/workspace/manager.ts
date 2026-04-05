import { promises as fs } from 'fs';
import { join } from 'path';
import simpleGit, { SimpleGit } from 'simple-git';
import { WorkspaceError } from '../utils/errors.js';
import { logInfo, logDebug, logWarn, logError } from '../utils/logger.js';
import { getEnv } from '../config/index.js';
import type { WorkspaceInfo, WorkspaceStatus, CreateWorkspaceOptions } from './types.js';

export class WorkspaceManager {
  private root: string;
  private maxWorkspaces: number;

  constructor() {
    const env = getEnv();
    this.root = env.WORKSPACE_ROOT;
    this.maxWorkspaces = env.MAX_WORKSPACES;
  }

  /**
   * Generate workspace ID with format: <project-name>-<issue|mr>-<number>
   * Example: myproject-issue-123, myproject-mr-456
   */
  generateId(projectName: string, type: 'issue' | 'mr', iid: number): string {
    const sanitizedName = projectName.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-');
    return `${sanitizedName}-${type}-${iid}`;
  }

  /**
   * Get workspace path
   */
  getPath(projectName: string, type: 'issue' | 'mr', iid: number): string {
    return join(this.root, this.generateId(projectName, type, iid));
  }

  /**
   * Check if workspace exists
   */
  async exists(projectName: string, type: 'issue' | 'mr', iid: number): Promise<boolean> {
    const path = this.getPath(projectName, type, iid);
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get workspace status
   */
  async getStatus(projectName: string, type: 'issue' | 'mr', iid: number): Promise<WorkspaceStatus> {
    const path = this.getPath(projectName, type, iid);

    try {
      await fs.stat(path);
      const git: SimpleGit = simpleGit(path);

      let isClean = false;
      let lastCommit: string | undefined;

      try {
        const status = await git.status();
        isClean = status.isClean();
        const log = await git.log({ n: 1 });
        lastCommit = log.latest?.hash;
      } catch {
        // Not a git repo or no commits
      }

      return {
        exists: true,
        path,
        isClean,
        lastCommit,
      };
    } catch {
      return {
        exists: false,
        path,
        isClean: false,
      };
    }
  }

  /**
   * Create or reuse workspace
   */
  async getOrCreate(options: CreateWorkspaceOptions): Promise<WorkspaceInfo> {
    const { type, projectId, projectName, iid, repoUrl, defaultBranch } = options;
    const workspaceId = this.generateId(projectName, type, iid);
    const path = this.getPath(projectName, type, iid);

    logInfo(
      { event: 'workspace_get_or_create', workspaceId, type, projectId, projectName, iid },
      `Getting or creating workspace: ${workspaceId}`
    );

    // Check if workspace already exists
    const existing = await this.exists(projectName, type, iid);
    if (existing) {
      logDebug({ event: 'workspace_reuse', workspaceId }, 'Reusing existing workspace');
      if (type === 'mr') {
        // For MRs, don't reset to defaultBranch - keep current branch (source branch)
        // Just fetch to update all refs
        const git: SimpleGit = simpleGit(path);
        await git.fetch();
        const info = await this.getInfo(projectName, type, projectId, iid);
        info.lastUsedAt = new Date();
        logInfo({ event: 'workspace_reused_mr', workspaceId }, 'Workspace reused for MR, skipped reset to default');
        return info;
      }
      return this.resetWorkspace(projectName, type, projectId, iid, defaultBranch);
    }

    // Check workspace limit
    await this.enforeWorkspaceLimit();

    // Create new workspace
    logDebug({ event: 'workspace_create', workspaceId, repoUrl }, 'Creating new workspace');
    await fs.mkdir(path, { recursive: true });

    // Clone repository
    const git: SimpleGit = simpleGit(path);
    try {
      await git.clone(repoUrl, path, ['--depth=1', '--branch', defaultBranch]);
    } catch (error) {
      // If clone fails due to branch issues, try cloning without specifying branch
      logWarn({ event: 'workspace_clone_with_branch_failed', workspaceId, defaultBranch, error: String(error) }, 'Clone with branch failed, trying without branch');
      try {
        await git.clone(repoUrl, path, ['--depth=1']);
      } catch (retryError) {
        // Keep the directory even if clone fails (empty repo case)
        logWarn({ event: 'workspace_clone_failed', workspaceId, error: String(retryError) }, 'Clone failed, workspace directory created but repo not cloned');
      }
    }

    const info: WorkspaceInfo = {
      id: workspaceId,
      type,
      projectId,
      projectName,
      iid,
      path,
      createdAt: new Date(),
      lastUsedAt: new Date(),
    };

    logInfo({ event: 'workspace_created', workspaceId }, 'Workspace created successfully');
    return info;
  }

  /**
   * Reset workspace to clean state (git fetch + reset)
   */
  async resetWorkspace(
    projectName: string,
    type: 'issue' | 'mr',
    projectId: number,
    iid: number,
    defaultBranch: string
  ): Promise<WorkspaceInfo> {
    const workspaceId = this.generateId(projectName, type, iid);
    const path = this.getPath(projectName, type, iid);

    logDebug({ event: 'workspace_reset', workspaceId, defaultBranch }, 'Resetting workspace to clean state');

    const git: SimpleGit = simpleGit(path);

    try {
      // Fetch latest and reset
      await git.fetch('origin', defaultBranch);
      await git.reset(['--hard', `origin/${defaultBranch}`]);

      // Update last used time
      const info = await this.getInfo(projectName, type, projectId, iid);
      info.lastUsedAt = new Date();

      logInfo({ event: 'workspace_reset_complete', workspaceId }, 'Workspace reset complete');
      return info;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logError({ event: 'workspace_reset_failed', workspaceId, error: errorMessage }, 'Failed to reset workspace');
      throw new WorkspaceError(`Failed to reset workspace: ${errorMessage}`);
    }
  }

  /**
   * Get workspace info
   */
  async getInfo(projectName: string, type: 'issue' | 'mr', projectId: number, iid: number): Promise<WorkspaceInfo> {
    const workspaceId = this.generateId(projectName, type, iid);
    const path = this.getPath(projectName, type, iid);

    const stat = await fs.stat(path);

    return {
      id: workspaceId,
      type,
      projectId,
      projectName,
      iid,
      path,
      createdAt: stat.birthtime,
      lastUsedAt: stat.mtime,
    };
  }

  /**
   * Delete workspace
   */
  async delete(projectName: string, type: 'issue' | 'mr', iid: number): Promise<void> {
    const workspaceId = this.generateId(projectName, type, iid);
    const path = this.getPath(projectName, type, iid);

    logInfo({ event: 'workspace_delete', workspaceId }, 'Deleting workspace');

    try {
      await fs.rm(path, { recursive: true, force: true });
      logInfo({ event: 'workspace_deleted', workspaceId }, 'Workspace deleted successfully');
    } catch (error) {
      logWarn({ event: 'workspace_delete_failed', workspaceId, error }, 'Failed to delete workspace');
      throw new WorkspaceError(`Failed to delete workspace: ${error}`);
    }
  }

  /**
   * Enforce workspace limit
   */
  private async enforeWorkspaceLimit(): Promise<void> {
    const workspaces = await this.listWorkspaces();

    if (workspaces.length >= this.maxWorkspaces) {
      logWarn(
        { event: 'workspace_limit_reached', count: workspaces.length, limit: this.maxWorkspaces },
        'Workspace limit reached, will clean up oldest'
      );

      // Sort by last used time and delete oldest
      const sorted = workspaces.sort((a, b) => a.lastUsedAt.getTime() - b.lastUsedAt.getTime());
      const toDelete = sorted.slice(0, Math.ceil(this.maxWorkspaces * 0.2)); // Delete 20%

      for (const ws of toDelete) {
        await this.delete(ws.projectName, ws.type, ws.iid).catch(() => {});
      }
    }
  }

  /**
   * List all workspaces
   */
  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      const workspaces: WorkspaceInfo[] = [];

      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.includes('-issue-') || entry.name.includes('-mr-')) {
          // Parse directory name: <project-name>-<issue|mr>-<number>
          const parts = entry.name.split('-');
          if (parts.length >= 3) {
            const typeStr = parts[parts.length - 2] as 'issue' | 'mr';
            const iidStr = parts[parts.length - 1];
            const type = typeStr === 'issue' || typeStr === 'mr' ? typeStr : null;
            const iid = parseInt(iidStr, 10);
            const projectName = parts.slice(0, -2).join('-');

            if (type && !isNaN(iid)) {
              try {
                // We don't have projectId here, use 0 as placeholder
                const info = await this.getInfo(projectName, type, 0, iid);
                workspaces.push(info);
              } catch {
                // Skip invalid workspaces
              }
            }
          }
        }
      }

      return workspaces;
    } catch (error) {
      return [];
    }
  }

  /**
   * Get workspace git instance
   */
  async getGit(projectName: string, type: 'issue' | 'mr', iid: number): Promise<SimpleGit> {
    const exists = await this.exists(projectName, type, iid);
    if (!exists) {
      throw new WorkspaceError(`Workspace does not exist: ${this.generateId(projectName, type, iid)}`);
    }

    const path = this.getPath(projectName, type, iid);
    return simpleGit(path);
  }
}
