/**
 * Proves the global setup (`__tests__/setup.ts`) blocks the real docker CLI:
 * `docker` on PATH resolves to the fake, which exits 97.
 */
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';

import { runWithTimeout } from '../src/image/exec';

// Mirrors `__tests__/setup.ts` (not imported, so its side effects run once).
const FAKE_DOCKER_EXIT_CODE = 97;
const FAKE_DOCKER_MESSAGE = 'real docker blocked in tests';

describe('real docker is blocked in tests', () => {
  it('`which docker` resolves to the fake in the temp dir', () => {
    const resolved = execFileSync('which', ['docker'], { encoding: 'utf8' }).trim();

    expect(resolved.startsWith(os.tmpdir())).toBe(true);
    expect(resolved).toMatch(/fake-docker-[^/]+\/docker$/);
  });

  it('runWithTimeout("docker", …) hits the fake (exit 97), never a real docker', async () => {
    const result = await runWithTimeout('docker', ['version'], { timeoutMs: 5_000 });

    expect(result.exitCode).toBe(FAKE_DOCKER_EXIT_CODE);
    expect(result.stderr).toContain(FAKE_DOCKER_MESSAGE);
  });
});
