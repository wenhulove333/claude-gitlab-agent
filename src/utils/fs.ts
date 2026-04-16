import { promises as fs, constants } from 'fs';
import { join } from 'path';
import { logDebug, logInfo, logWarn } from './logger.js';

/**
 * Find the Claude session UUID file in .claude folder
 */
async function findSessionUUID(basePath: string): Promise<string | null> {
  const claudeDir = join(basePath, '.claude');
  try {
    await fs.access(claudeDir, constants.R_OK);
  } catch {
    return null;
  }

  const entries = await fs.readdir(claudeDir, { withFileTypes: true });
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  for (const entry of entries) {
    if (entry.isFile() && uuidRegex.test(entry.name)) {
      return entry.name;
    }
  }

  return null;
}

/**
 * Copy Claude session from source workspace to destination workspace
 * Copies .claude/<uuid> file from source to dest
 */
export async function copyClaudeSession(sourceWorkspace: string, destWorkspace: string): Promise<boolean> {
  try {
    // Find session UUID in source
    const sessionUUID = await findSessionUUID(sourceWorkspace);
    if (!sessionUUID) {
      logDebug(
        { event: 'copy_session_no_session', source: sourceWorkspace },
        'No Claude session found in source workspace'
      );
      return false;
    }

    const sourceSessionFile = join(sourceWorkspace, '.claude', sessionUUID);
    const destClaudeDir = join(destWorkspace, '.claude');
    const destSessionFile = join(destClaudeDir, sessionUUID);

    // Check if destination already has a session
    const destSessionUUID = await findSessionUUID(destWorkspace);
    if (destSessionUUID) {
      logDebug(
        { event: 'copy_session_already_exists', dest: destWorkspace, existingSession: destSessionUUID },
        'Destination workspace already has a Claude session, skipping copy'
      );
      return false;
    }

    // Ensure destination .claude directory exists
    await fs.mkdir(destClaudeDir, { recursive: true });

    // Copy the session file
    await fs.copyFile(sourceSessionFile, destSessionFile);

    logInfo(
      {
        event: 'copy_session_success',
        source: sourceWorkspace,
        dest: destWorkspace,
        sessionUUID,
      },
      `Copied Claude session ${sessionUUID} from issue to MR workspace`
    );

    return true;
  } catch (error) {
    logWarn(
      { event: 'copy_session_failed', source: sourceWorkspace, dest: destWorkspace, error: String(error) },
      'Failed to copy Claude session from issue to MR workspace'
    );
    return false;
  }
}
