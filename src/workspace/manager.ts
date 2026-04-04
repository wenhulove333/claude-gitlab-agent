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
   * Generate workspace ID
   */
  generateId(type: 'issue' | 'mr', projectId: number, iid: number): string {
    return `workspace-${type}-${projectId}-${iid}`;
  }

  /**
   * Get workspace path
   */
  getPath(type: 'issue' | 'mr', projectId: number, iid: number): string {
    return join(this.root, this.generateId(type, projectId, iid));
  }

  /**
   * Check if workspace exists
   */
  async exists(type: 'issue' | 'mr', projectId: number, iid: number): Promise<boolean> {
    const path = this.getPath(type, projectId, iid);
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
  async getStatus(type: 'issue' | 'mr', projectId: number, iid: number): Promise<WorkspaceStatus> {
    const path = this.getPath(type, projectId, iid);

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
    const { type, projectId, iid, repoUrl, defaultBranch } = options;
    const workspaceId = this.generateId(type, projectId, iid);
    const path = this.getPath(type, projectId, iid);

    logInfo(
      { event: 'workspace_get_or_create', workspaceId, type, projectId, iid },
      `Getting or creating workspace: ${workspaceId}`
    );

    // Check if workspace already exists
    const existing = await this.exists(type, projectId, iid);
    if (existing) {
      logDebug({ event: 'workspace_reuse', workspaceId }, 'Reusing existing workspace');
      return this.resetWorkspace(type, projectId, iid, defaultBranch);
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
      // Clean up on failure
      await this.delete(type, projectId, iid).catch(() => {});
      throw new WorkspaceError(`Failed to clone repository: ${error}`);
    }

    const info: WorkspaceInfo = {
      id: workspaceId,
      type,
      projectId,
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
  async resetWorkspace(type: 'issue' | 'mr', projectId: number, iid: number, defaultBranch: string): Promise<WorkspaceInfo> {
    const workspaceId = this.generateId(type, projectId, iid);
    const path = this.getPath(type, projectId, iid);

    logDebug({ event: 'workspace_reset', workspaceId, defaultBranch }, 'Resetting workspace to clean state');

    const git: SimpleGit = simpleGit(path);

    try {
      // Fetch latest and reset
      await git.fetch('origin', defaultBranch);
      await git.reset(['--hard', `origin/${defaultBranch}`]);

      // Update last used time
      const info = await this.getInfo(type, projectId, iid);
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
  async getInfo(type: 'issue' | 'mr', projectId: number, iid: number): Promise<WorkspaceInfo> {
    const workspaceId = this.generateId(type, projectId, iid);
    const path = this.getPath(type, projectId, iid);

    const stat = await fs.stat(path);

    return {
      id: workspaceId,
      type,
      projectId,
      iid,
      path,
      createdAt: stat.birthtime,
      lastUsedAt: stat.mtime,
    };
  }

  /**
   * Delete workspace
   */
  async delete(type: 'issue' | 'mr', projectId: number, iid: number): Promise<void> {
    const workspaceId = this.generateId(type, projectId, iid);
    const path = this.getPath(type, projectId, iid);

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
        await this.delete(ws.type, ws.projectId, ws.iid).catch(() => {});
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
        if (entry.isDirectory() && entry.name.startsWith('workspace-')) {
          const parts = entry.name.split('-');
          if (parts.length >= 4) {
            const type = parts[1] as 'issue' | 'mr';
            const projectId = parseInt(parts[2], 10);
            const iid = parseInt(parts[3], 10);

            if (!isNaN(projectId) && !isNaN(iid)) {
              try {
                const info = await this.getInfo(type, projectId, iid);
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
  async getGit(type: 'issue' | 'mr', projectId: number, iid: number): Promise<SimpleGit> {
    const exists = await this.exists(type, projectId, iid);
    if (!exists) {
      throw new WorkspaceError(`Workspace does not exist: ${this.generateId(type, projectId, iid)}`);
    }

    const path = this.getPath(type, projectId, iid);
    return simpleGit(path);
  }
}
