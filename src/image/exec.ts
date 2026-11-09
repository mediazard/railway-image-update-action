import { spawn } from 'node:child_process';

/**
 * Bounds for the three docker calls. Registry round-trips take seconds; the
 * inspect of a large multi-arch index can take tens of seconds. All stay well
 * inside a CI job, so a black-holed host fails the step instead of hanging it
 * until the job timeout.
 */
export const DOCKER_LOGIN_TIMEOUT_MS = 60_000;
export const IMAGETOOLS_INSPECT_TIMEOUT_MS = 120_000;
export const DOCKER_LOGOUT_TIMEOUT_MS = 30_000;

/**
 * After the child exits (or is killed), how long to wait for its stdio pipes
 * to close. A grandchild (e.g. a credential helper) can inherit and hold the
 * pipes open, so `'close'` may never fire on its own.
 */
const EXIT_STDIO_GRACE_MS = 1_000;

export interface ExecOptions {
  /** Written to the child's stdin, which is then closed. */
  readonly input?: Buffer;
  /** Required: every call site must choose a bound. */
  readonly timeoutMs: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Function-shaped seam for subprocess exec. The default is `runWithTimeout`;
 * tests inject a fake.
 */
export type ExecFn = (
  cmd: string,
  args: readonly string[],
  opts: ExecOptions,
) => Promise<ExecResult>;

/**
 * The command was killed by the timer. The message deliberately carries no
 * argv and no output, so it is log-safe (no username, host or secret).
 */
export class ExecTimeoutError extends Error {
  readonly code = 'EXEC_TIMEOUT';

  constructor(readonly timeoutMs: number) {
    super(`Command timed out after ${timeoutMs}ms`);
    this.name = 'ExecTimeoutError';
  }
}

/**
 * Run a command without a shell, capturing stdout/stderr (nothing is echoed),
 * and resolve with its exit code whatever it is. On timeout: SIGKILL the
 * child, destroy its pipes, wait (bounded) for it to exit so it is reaped,
 * then reject `ExecTimeoutError`. Rejects on spawn errors (e.g. ENOENT).
 */
export const runWithTimeout: ExecFn = (cmd, args, opts) =>
  new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(cmd, [...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let exitCode: number | null = null;
    let exited = false;
    let graceTimer: NodeJS.Timeout | undefined;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    // EPIPE if the child exits before reading its input; the exit code tells the story.
    child.stdin.on('error', () => undefined);

    const destroyPipes = (): void => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      fn();
    };

    const resolveWithExit = (): void => {
      settle(() => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
    };

    child.on('error', (err) => {
      settle(() => {
        destroyPipes();
        reject(err);
      });
    });

    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
      if (settled) return;
      // Normal exit: give the pipes a bounded window to drain and close.
      graceTimer = setTimeout(() => {
        destroyPipes();
        resolveWithExit();
      }, EXIT_STDIO_GRACE_MS);
    });

    child.on('close', () => {
      if (exited) resolveWithExit();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      if (exited) {
        // The command finished; only its pipes were still draining.
        destroyPipes();
        resolveWithExit();
        return;
      }
      settled = true;
      const fail = (): void => reject(new ExecTimeoutError(opts.timeoutMs));
      child.kill('SIGKILL');
      destroyPipes();
      // Wait for the kill to be reaped (bounded), so no zombie outlives us.
      const reapTimer = setTimeout(fail, EXIT_STDIO_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(reapTimer);
        fail();
      });
    }, opts.timeoutMs);

    child.stdin.end(opts.input);
  });
