import { WorkspaceManager } from './manager.js';
import { logInfo, logDebug, logWarn } from '../utils/logger.js';
import { getEnv } from '../config/index.js';

export interface CleanResult {
  deleted: number;
  failed: number;
  errors: string[];
}

export class WorkspaceCleaner {
  private manager: WorkspaceManager;
  private ttlHours: number;

  constructor(manager: WorkspaceManager) {
    this.manager = manager;
    this.ttlHours = getEnv().WORKSPACE_TTL_HOURS;
  }

  /**
   * Clean workspaces that exceeded TTL
   */
  async cleanStaleWorkspaces(): Promise<CleanResult> {
    logInfo({ event: 'cleaner_start', ttlHours: this.ttlHours }, 'Starting stale workspace cleanup');

    const workspaces = await this.manager.listWorkspaces();
    const now = new Date();
    const ttlMs = this.ttlHours * 60 * 60 * 1000;

    const result: CleanResult = {
      deleted: 0,
      failed: 0,
      errors: [],
    };

    for (const ws of workspaces) {
      const age = now.getTime() - ws.lastUsedAt.getTime();

      if (age > ttlMs) {
        logDebug(
          { event: 'cleaner_found_stale', workspaceId: ws.id, ageHours: Math.round(age / (60 * 60 * 1000)) },
          `Found stale workspace: ${ws.id}`
        );

        try {
          await this.manager.delete(ws.type, ws.projectId, ws.iid);
          result.deleted++;
        } catch (error) {
          result.failed++;
          result.errors.push(`${ws.id}: ${error}`);
          logWarn({ event: 'cleaner_delete_failed', workspaceId: ws.id, error }, `Failed to delete workspace: ${ws.id}`);
        }
      }
    }

    logInfo(
      { event: 'cleaner_complete', deleted: result.deleted, failed: result.failed },
      `Cleanup complete: ${result.deleted} deleted, ${result.failed} failed`
    );

    return result;
  }

  /**
   * Force clean all workspaces (use with caution)
   */
  async cleanAll(): Promise<CleanResult> {
    logWarn({ event: 'cleaner_clean_all' }, 'Starting cleanup of ALL workspaces');

    const workspaces = await this.manager.listWorkspaces();
    const result: CleanResult = {
      deleted: 0,
      failed: 0,
      errors: [],
    };

    for (const ws of workspaces) {
      try {
        await this.manager.delete(ws.type, ws.projectId, ws.iid);
        result.deleted++;
      } catch (error) {
        result.failed++;
        result.errors.push(`${ws.id}: ${error}`);
      }
    }

    logInfo({ event: 'cleaner_clean_all_complete', deleted: result.deleted }, 'All workspaces cleaned');
    return result;
  }
}
