import { spawn } from 'child_process';
import { logInfo, logDebug, logError } from '../utils/logger.js';

export interface GitOperationResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Execute git operation in a workspace directory
 */
export async function gitClone(
  repoUrl: string,
  targetDir: string,
  branch: string = 'main'
): Promise<GitOperationResult> {
  logInfo({ event: 'git_clone', repoUrl, targetDir, branch }, 'Cloning repository');

  return new Promise((resolve) => {
    const proc = spawn('git', ['clone', '--branch', branch, '--depth=1', repoUrl, targetDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        logInfo({ event: 'git_clone_success' }, 'Repository cloned successfully');
        resolve({ success: true, output: stdout });
      } else {
        logError({ event: 'git_clone_failed', code, stderr }, 'Failed to clone repository');
        resolve({ success: false, output: stdout, error: stderr });
      }
    });

    proc.on('error', (err) => {
      logError({ event: 'git_clone_error', error: err.message }, 'Git clone error');
      resolve({ success: false, output: '', error: err.message });
    });
  });
}

/**
 * Git add all changes
 */
export async function gitAdd(targetDir: string): Promise<GitOperationResult> {
  logInfo({ event: 'git_add', targetDir }, 'Staging all changes');

  return new Promise((resolve) => {
    const proc = spawn('git', ['add', '-A'], {
      cwd: targetDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        logDebug({ event: 'git_add_success' }, 'Changes staged');
        resolve({ success: true, output: stdout });
      } else {
        logError({ event: 'git_add_failed', code, stderr }, 'Failed to stage changes');
        resolve({ success: false, output: stdout, error: stderr });
      }
    });

    proc.on('error', (err) => {
      logError({ event: 'git_add_error', error: err.message }, 'Git add error');
      resolve({ success: false, output: '', error: err.message });
    });
  });
}

/**
 * Git commit changes
 */
export async function gitCommit(
  targetDir: string,
  message: string
): Promise<GitOperationResult> {
  logInfo({ event: 'git_commit', targetDir, message }, 'Committing changes');

  return new Promise((resolve) => {
    const proc = spawn('git', ['commit', '-m', message], {
      cwd: targetDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        logInfo({ event: 'git_commit_success' }, 'Changes committed');
        resolve({ success: true, output: stdout });
      } else {
        logError({ event: 'git_commit_failed', code, stderr }, 'Failed to commit');
        resolve({ success: false, output: stdout, error: stderr });
      }
    });

    proc.on('error', (err) => {
      logError({ event: 'git_commit_error', error: err.message }, 'Git commit error');
      resolve({ success: false, output: '', error: err.message });
    });
  });
}

/**
 * Git push to remote
 */
export async function gitPush(
  targetDir: string,
  branchName: string
): Promise<GitOperationResult> {
  logInfo({ event: 'git_push', targetDir, branchName }, 'Pushing changes');

  return new Promise((resolve) => {
    const proc = spawn('git', ['push', 'origin', `HEAD:refs/heads/${branchName}`], {
      cwd: targetDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        logInfo({ event: 'git_push_success', branchName }, 'Changes pushed');
        resolve({ success: true, output: stdout });
      } else {
        logError({ event: 'git_push_failed', code, stderr }, 'Failed to push');
        resolve({ success: false, output: stdout, error: stderr });
      }
    });

    proc.on('error', (err) => {
      logError({ event: 'git_push_error', error: err.message }, 'Git push error');
      resolve({ success: false, output: '', error: err.message });
    });
  });
}

/**
 * Git create and push new branch
 */
export async function gitCreateBranch(
  targetDir: string,
  branchName: string
): Promise<GitOperationResult> {
  logInfo({ event: 'git_create_branch', targetDir, branchName }, 'Creating new branch');

  return new Promise((resolve) => {
    const proc = spawn('git', ['checkout', '-b', branchName], {
      cwd: targetDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        logInfo({ event: 'git_branch_created', branchName }, 'Branch created');
        resolve({ success: true, output: stdout });
      } else {
        logError({ event: 'git_branch_failed', code, stderr }, 'Failed to create branch');
        resolve({ success: false, output: stdout, error: stderr });
      }
    });

    proc.on('error', (err) => {
      logError({ event: 'git_branch_error', error: err.message }, 'Git branch error');
      resolve({ success: false, output: '', error: err.message });
    });
  });
}

/**
 * Git fetch and reset to latest
 */
export async function gitReset(
  targetDir: string,
  branch: string = 'main'
): Promise<GitOperationResult> {
  logInfo({ event: 'git_reset', targetDir, branch }, 'Resetting to latest');

  return new Promise((resolve) => {
    // Use two separate git commands to avoid shell: true and command injection
    const proc = spawn('git', ['fetch', 'origin', branch], {
      cwd: targetDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        logError({ event: 'git_fetch_failed', code, stderr }, 'Failed to fetch origin');
        resolve({ success: false, output: stdout, error: stderr });
        return;
      }

      // Now do the reset
      const resetProc = spawn('git', ['reset', '--hard', `origin/${branch}`], {
        cwd: targetDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let resetStdout = '';
      let resetStderr = '';

      resetProc.stdout?.on('data', (data) => { resetStdout += data.toString(); });
      resetProc.stderr?.on('data', (data) => { resetStderr += data.toString(); });

      resetProc.on('close', (resetCode) => {
        if (resetCode === 0) {
          logDebug({ event: 'git_reset_success' }, 'Repository reset complete');
          resolve({ success: true, output: stdout + resetStdout });
        } else {
          logError({ event: 'git_reset_failed', code: resetCode, stderr: resetStderr }, 'Failed to reset repository');
          resolve({ success: false, output: stdout + resetStdout, error: resetStderr });
        }
      });

      resetProc.on('error', (err) => {
        logError({ event: 'git_reset_error', error: err.message }, 'Git reset error');
        resolve({ success: false, output: stdout, error: err.message });
      });
    });

    proc.on('error', (err) => {
      logError({ event: 'git_fetch_error', error: err.message }, 'Git fetch error');
      resolve({ success: false, output: '', error: err.message });
    });
  });
}

/**
 * Check git status to see what files changed
 */
export async function gitStatus(targetDir: string): Promise<GitOperationResult> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['status', '--porcelain'], {
      cwd: targetDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      resolve({ success: code === 0, output: stdout, error: stderr });
    });

    proc.on('error', (err) => {
      resolve({ success: false, output: '', error: err.message });
    });
  });
}
