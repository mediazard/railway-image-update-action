/**
 * Global vitest setup: no test may ever run the real `docker` CLI.
 *
 * A fake `docker` executable is put first on PATH. It writes a marker to
 * stderr and exits 97, so anything that spawns `docker` by name
 * (`@actions/exec`, `child_process`, our runner) hits the fake instead of
 * touching the developer's registry credentials.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const FAKE_DOCKER_EXIT_CODE = 97;
const FAKE_DOCKER_MESSAGE = 'real docker blocked in tests';

const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-'));
const fakeDocker = path.join(fakeBinDir, 'docker');
fs.writeFileSync(
  fakeDocker,
  `#!/bin/sh\necho '${FAKE_DOCKER_MESSAGE}' >&2\nexit ${FAKE_DOCKER_EXIT_CODE}\n`,
  { mode: 0o755 },
);

const originalPath = process.env.PATH;
process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ''}`;

afterAll(() => {
  process.env.PATH = originalPath;
  fs.rmSync(fakeBinDir, { recursive: true, force: true });
});
