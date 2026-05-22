import type * as exec from '@actions/exec';

// Mock @actions/core so we can assert on info/debug calls without polluting
// the test runner output.
vi.mock('@actions/core', () => ({
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  notice: vi.fn(),
}));

import * as core from '@actions/core';
import { ActionError } from '../../src/errors';
import { resolveImageDigest } from '../../src/image/digest';

type ExecFn = typeof exec.getExecOutput;

const DIGEST_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const FAKE_DIGEST = `sha256:${DIGEST_HEX}`;
const SHA_REF =
  'ghcr.io/org/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function mockExecOk(stdout = `{"digest":"${FAKE_DIGEST}"}`) {
  return vi.fn(async () => ({ exitCode: 0, stdout, stderr: '' })) as unknown as ExecFn;
}

describe('resolveImageDigest', () => {
  it('returns input unchanged when ref already digest-pinned', async () => {
    const execFn = vi.fn() as unknown as ExecFn;

    const result = await resolveImageDigest(SHA_REF, { registry: 'ghcr.io' }, execFn);

    expect(result).toBe(SHA_REF);
    expect(execFn).not.toHaveBeenCalled();
    expect(core.debug).toHaveBeenCalledWith(
      'resolve_image_digest: ref already digest-pinned, skipping',
    );
  });

  it('returns stub digest in dry-run mode and emits dry-run lines', async () => {
    const execFn = vi.fn() as unknown as ExecFn;

    const result = await resolveImageDigest(
      'ghcr.io/org/app:v1.2.3',
      { registry: 'ghcr.io', isDryRun: true },
      execFn,
    );

    expect(result).toBe('ghcr.io/org/app@sha256:dryrun');
    expect(execFn).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(
      '[DRY-RUN] Resolving manifest digest for: ghcr.io/org/app:v1.2.3',
    );
    expect(core.info).toHaveBeenCalledWith(
      '[DRY-RUN] Resolved to (stub): ghcr.io/org/app@sha256:dryrun',
    );
  });

  it('returns stub digest in dry-run mode for tagless ref', async () => {
    const execFn = vi.fn() as unknown as ExecFn;

    const result = await resolveImageDigest(
      'ghcr.io/org/app',
      { registry: 'ghcr.io', isDryRun: true },
      execFn,
    );

    expect(result).toBe('ghcr.io/org/app@sha256:dryrun');
    expect(execFn).not.toHaveBeenCalled();
  });

  it('returns repo@digest in live mode and emits the 🔍/✓ info lines', async () => {
    const execFn = mockExecOk();

    const result = await resolveImageDigest(
      'ghcr.io/org/app:v1.2.3',
      { registry: 'ghcr.io' },
      execFn,
    );

    expect(result).toBe(`ghcr.io/org/app@${FAKE_DIGEST}`);
    expect(core.info).toHaveBeenCalledWith(
      '  🔍 Resolving manifest digest for: ghcr.io/org/app:v1.2.3',
    );
    expect(core.info).toHaveBeenCalledWith(`  ✓ Resolved: ghcr.io/org/app@${FAKE_DIGEST}`);
  });

  it('calls docker login with credentials before inspect and invokes onDockerLogin', async () => {
    const execFn = vi.fn(async (_cmd: string, args?: string[]) => {
      // First call: docker login. Second call: imagetools inspect.
      if (args && args[0] === 'login') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: `{"digest":"${FAKE_DIGEST}"}`, stderr: '' };
    }) as unknown as ExecFn;
    const onDockerLogin = vi.fn();

    await resolveImageDigest(
      'ghcr.io/org/app:v1.2.3',
      {
        registry: 'ghcr.io',
        credentials: { username: 'u', password: 'p' },
        onDockerLogin,
      },
      execFn,
    );

    const execMock = execFn as unknown as ReturnType<typeof vi.fn>;
    // Login call comes first. Args use `--` separator to defend against
    // argv injection if `registry` ever starts with `-`.
    const firstCall = execMock.mock.calls[0];
    expect(firstCall[0]).toBe('docker');
    expect(firstCall[1]).toEqual(['login', '-u', 'u', '--password-stdin', '--', 'ghcr.io']);
    // Password is passed on stdin via the `input` option.
    expect(firstCall[2].input).toBeInstanceOf(Buffer);
    expect((firstCall[2].input as Buffer).toString('utf8')).toBe('p');
    expect(firstCall[2].silent).toBe(true);
    expect(firstCall[2].ignoreReturnCode).toBe(true);

    // Inspect call comes second. Args use `--` separator before the ref.
    const secondCall = execMock.mock.calls[1];
    expect(secondCall[0]).toBe('docker');
    expect(secondCall[1]).toEqual([
      'buildx',
      'imagetools',
      'inspect',
      '--format',
      '{{json .Manifest}}',
      '--',
      'ghcr.io/org/app:v1.2.3',
    ]);

    expect(onDockerLogin).toHaveBeenCalledWith('ghcr.io');
    expect(onDockerLogin).toHaveBeenCalledTimes(1);
  });

  it('throws ActionError when docker login fails and does NOT call onDockerLogin', async () => {
    const execFn = vi.fn(async (_cmd: string, args?: string[]) => {
      if (args && args[0] === 'login') {
        return { exitCode: 1, stdout: '', stderr: 'bad creds' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as unknown as ExecFn;
    const onDockerLogin = vi.fn();

    await expect(
      resolveImageDigest(
        'ghcr.io/org/app:v1.2.3',
        {
          registry: 'ghcr.io',
          credentials: { username: 'u', password: 'p' },
          onDockerLogin,
        },
        execFn,
      ),
    ).rejects.toMatchObject({
      name: 'ActionError',
      message: 'Registry login failed during digest resolution',
    });

    expect(onDockerLogin).not.toHaveBeenCalled();
  });

  it('throws ActionError when inspect returns non-zero exit code', async () => {
    const execFn = vi.fn(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'manifest unknown',
    })) as unknown as ExecFn;

    let caught: unknown;
    try {
      await resolveImageDigest('ghcr.io/org/app:v1.2.3', { registry: 'ghcr.io' }, execFn);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ActionError);
    const e = caught as ActionError;
    expect(e.message).toBe('Failed to resolve manifest digest for image');
    expect(e.details).toContain('manifest unknown');
  });

  it('throws ActionError when inspect returns empty digest field', async () => {
    const execFn = mockExecOk('{"digest":""}');

    await expect(
      resolveImageDigest('ghcr.io/org/app:v1.2.3', { registry: 'ghcr.io' }, execFn),
    ).rejects.toMatchObject({
      name: 'ActionError',
      message: 'Manifest digest resolution returned empty result',
    });
  });

  it('strips only the trailing tag from registry/repo:tag', async () => {
    const execFn = mockExecOk();

    const result = await resolveImageDigest(
      'registry.example.com/foo/bar:tag',
      { registry: 'registry.example.com' },
      execFn,
    );

    expect(result).toBe(`registry.example.com/foo/bar@${FAKE_DIGEST}`);
  });

  it('handles tagless input registry/repo by appending @digest', async () => {
    const execFn = mockExecOk();

    const result = await resolveImageDigest(
      'registry.example.com/foo/bar',
      { registry: 'registry.example.com' },
      execFn,
    );

    expect(result).toBe(`registry.example.com/foo/bar@${FAKE_DIGEST}`);
  });

  it('preserves registry port: localhost:5000/foo:bar → localhost:5000/foo@digest', async () => {
    const execFn = mockExecOk();

    const result = await resolveImageDigest(
      'localhost:5000/foo:bar',
      { registry: 'localhost:5000' },
      execFn,
    );

    expect(result).toBe(`localhost:5000/foo@${FAKE_DIGEST}`);
  });

  it('preserves registry port on tagless input: localhost:5000/foo → localhost:5000/foo@digest', async () => {
    const execFn = mockExecOk();

    const result = await resolveImageDigest(
      'localhost:5000/foo',
      { registry: 'localhost:5000' },
      execFn,
    );

    expect(result).toBe(`localhost:5000/foo@${FAKE_DIGEST}`);
  });
});
