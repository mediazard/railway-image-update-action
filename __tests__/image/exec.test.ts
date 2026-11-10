/**
 * Tests for `src/image/exec.ts` — the spawn-based runner with a timeout.
 *
 * These use REAL child processes (`process.execPath -e …`) because killing the
 * child is the behaviour under test. No docker, no network. Timeouts are kept
 * short and every spawned pid is killed in `afterEach` so nothing is orphaned.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ExecTimeoutError, runWithTimeout } from '../../src/image/exec';

const NODE = process.execPath;

let tmpDir: string;
let pidFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-test-'));
  pidFile = path.join(tmpDir, 'pid');
});

afterEach(() => {
  // Kill any process whose pid a test recorded (grandchildren in particular).
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Spawn a grandchild that holds the inherited stdout pipe; record its pid. */
const SPAWN_GRANDCHILD =
  "const cp=require('child_process');" +
  "const g=cp.spawn(process.execPath,['-e','setTimeout(()=>{},10e3)'],{stdio:'inherit'});" +
  "require('fs').writeFileSync(process.argv[1],String(g.pid));";

describe('runWithTimeout', () => {
  it('writes input to stdin and captures stdout', { timeout: 10_000 }, async () => {
    const result = await runWithTimeout(NODE, ['-e', 'process.stdin.pipe(process.stdout)'], {
      input: Buffer.from('pw'),
      timeoutMs: 5_000,
    });

    expect(result).toEqual({ exitCode: 0, stdout: 'pw', stderr: '' });
  });

  it('captures stderr', { timeout: 10_000 }, async () => {
    const result = await runWithTimeout(NODE, ['-e', "process.stderr.write('bad')"], {
      timeoutMs: 5_000,
    });

    expect(result.stderr).toBe('bad');
  });

  it('resolves with a non-zero exit code instead of rejecting', { timeout: 10_000 }, async () => {
    const result = await runWithTimeout(NODE, ['-e', 'process.exit(3)'], { timeoutMs: 5_000 });

    expect(result.exitCode).toBe(3);
  });

  it(
    'kills and reaps a hung child, then rejects ExecTimeoutError',
    { timeout: 10_000 },
    async () => {
      const started = performance.now();
      const err = await runWithTimeout(
        NODE,
        [
          '-e',
          "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{},1e3)",
          pidFile,
        ],
        { timeoutMs: 1_000 },
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ExecTimeoutError);
      expect((err as ExecTimeoutError).code).toBe('EXEC_TIMEOUT');
      expect((err as ExecTimeoutError).timeoutMs).toBe(1_000);
      // Message carries no argv or output.
      expect((err as Error).message).toBe('Command timed out after 1000ms');
      expect(performance.now() - started).toBeLessThan(3_000);

      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(isAlive(pid)).toBe(false);
    },
  );

  it(
    'grandchild holds stdout, parent exits 0 → resolves with the real exit code after the grace',
    { timeout: 10_000 },
    async () => {
      const started = performance.now();
      const result = await runWithTimeout(
        NODE,
        ['-e', `${SPAWN_GRANDCHILD} process.stdout.write('ok', () => process.exit(0));`, pidFile],
        { timeoutMs: 10_000 },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('ok');
      expect(performance.now() - started).toBeLessThan(3_000);
    },
  );

  it(
    'grandchild holds stdout, parent hangs → rejects ExecTimeoutError within timeout + grace',
    { timeout: 10_000 },
    async () => {
      const started = performance.now();
      const err = await runWithTimeout(
        NODE,
        ['-e', `${SPAWN_GRANDCHILD} setInterval(()=>{},1e3);`, pidFile],
        { timeoutMs: 500 },
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ExecTimeoutError);
      expect(performance.now() - started).toBeLessThan(500 + 1_000 + 500);
    },
  );

  it('rejects with ENOENT when the command does not exist', { timeout: 10_000 }, async () => {
    await expect(
      runWithTimeout('definitely-not-a-command-xyz', [], { timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
