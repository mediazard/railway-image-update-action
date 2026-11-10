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
import {
  DOCKER_HUB_LOGIN_SERVER,
  registryHostFor,
  resolveImageDigest,
} from '../../src/image/digest';
import {
  DOCKER_LOGIN_TIMEOUT_MS,
  ExecTimeoutError,
  IMAGETOOLS_INSPECT_TIMEOUT_MS,
  type ExecFn,
} from '../../src/image/exec';

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

    const result = await resolveImageDigest(SHA_REF, {}, execFn);

    expect(result).toBe(SHA_REF);
    expect(execFn).not.toHaveBeenCalled();
    expect(core.debug).toHaveBeenCalledWith(
      'resolve_image_digest: ref already digest-pinned, skipping',
    );
  });

  it('returns stub digest in dry-run mode and emits dry-run lines', async () => {
    const execFn = vi.fn() as unknown as ExecFn;

    const result = await resolveImageDigest('ghcr.io/org/app:v1.2.3', { isDryRun: true }, execFn);

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

    const result = await resolveImageDigest('ghcr.io/org/app', { isDryRun: true }, execFn);

    expect(result).toBe('ghcr.io/org/app@sha256:dryrun');
    expect(execFn).not.toHaveBeenCalled();
  });

  it('returns repo@digest in live mode and emits the 🔍/✓ info lines', async () => {
    const execFn = mockExecOk();

    const result = await resolveImageDigest('ghcr.io/org/app:v1.2.3', {}, execFn);

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
    expect(firstCall[2].timeoutMs).toBe(DOCKER_LOGIN_TIMEOUT_MS);

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
    expect(secondCall[2].timeoutMs).toBe(IMAGETOOLS_INSPECT_TIMEOUT_MS);

    expect(onDockerLogin).toHaveBeenCalledWith('ghcr.io');
    expect(onDockerLogin).toHaveBeenCalledTimes(1);
  });

  it('throws ActionError when docker login fails, and still records the host for logout', async () => {
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
          credentials: { username: 'u', password: 'p' },
          onDockerLogin,
        },
        execFn,
      ),
    ).rejects.toMatchObject({
      name: 'ActionError',
      message: 'Registry login failed during digest resolution',
    });

    // Recorded BEFORE login: a failed login may still have written credentials,
    // and logging out of a host never logged in to is harmless.
    expect(onDockerLogin).toHaveBeenCalledWith('ghcr.io');
  });

  it('throws ActionError when inspect returns non-zero exit code', async () => {
    const execFn = vi.fn(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'manifest unknown',
    })) as unknown as ExecFn;

    let caught: unknown;
    try {
      await resolveImageDigest('ghcr.io/org/app:v1.2.3', {}, execFn);
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

    await expect(resolveImageDigest('ghcr.io/org/app:v1.2.3', {}, execFn)).rejects.toMatchObject({
      name: 'ActionError',
      message: 'Manifest digest resolution returned empty result',
    });
  });

  it('strips only the trailing tag from registry/repo:tag', async () => {
    const execFn = mockExecOk();

    const result = await resolveImageDigest('registry.example.com/foo/bar:tag', {}, execFn);

    expect(result).toBe(`registry.example.com/foo/bar@${FAKE_DIGEST}`);
  });

  it('handles tagless input registry/repo by appending @digest', async () => {
    const execFn = mockExecOk();

    const result = await resolveImageDigest('registry.example.com/foo/bar', {}, execFn);

    expect(result).toBe(`registry.example.com/foo/bar@${FAKE_DIGEST}`);
  });

  it('preserves registry port: localhost:5000/foo:bar → localhost:5000/foo@digest', async () => {
    const execFn = mockExecOk();

    const result = await resolveImageDigest('localhost:5000/foo:bar', {}, execFn);

    expect(result).toBe(`localhost:5000/foo@${FAKE_DIGEST}`);
  });

  it('preserves registry port on tagless input: localhost:5000/foo → localhost:5000/foo@digest', async () => {
    const execFn = mockExecOk();

    const result = await resolveImageDigest('localhost:5000/foo', {}, execFn);

    expect(result).toBe(`localhost:5000/foo@${FAKE_DIGEST}`);
  });
});

describe('resolveImageDigest — digest shape check', () => {
  it.each([
    ['a digest carrying a command', '{"digest":"sha256:abc\\n::add-mask::x"}'],
    ['a non-string digest', '{"digest":123}'],
    ['an upper-case algorithm', `{"digest":"SHA256:${DIGEST_HEX}"}`],
  ])('rejects %s with ActionError', async (_name, stdout) => {
    await expect(resolveImageDigest('ghcr.io/org/app:v1', {}, mockExecOk(stdout))).rejects.toThrow(
      'Manifest digest resolution returned an invalid digest',
    );
    await expect(
      resolveImageDigest('ghcr.io/org/app:v1', {}, mockExecOk(stdout)),
    ).rejects.toBeInstanceOf(ActionError);
  });
});

describe('resolveImageDigest — timeouts', () => {
  it('maps an inspect timeout to an ActionError', async () => {
    const execFn = vi.fn(async () => {
      throw new ExecTimeoutError(IMAGETOOLS_INSPECT_TIMEOUT_MS);
    }) as unknown as ExecFn;

    const err = await resolveImageDigest('ghcr.io/org/app:v1', {}, execFn).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).message).toMatch(/timed out/);
    expect((err as ActionError).details).toContain('ghcr.io/org/app:v1');
  });

  it('maps a login timeout to an ActionError and has already recorded the host for logout', async () => {
    const execFn = vi.fn(async () => {
      throw new ExecTimeoutError(DOCKER_LOGIN_TIMEOUT_MS);
    }) as unknown as ExecFn;
    const onDockerLogin = vi.fn();

    const err = await resolveImageDigest(
      'myorg/app:v1',
      { credentials: { username: 'u', password: 'p' }, onDockerLogin },
      execFn,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).message).toMatch(/Registry login timed out/);
    expect(onDockerLogin).toHaveBeenCalledWith(DOCKER_HUB_LOGIN_SERVER);
  });

  it('rethrows non-timeout exec errors unchanged', async () => {
    const boom = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    const execFn = vi.fn(async () => {
      throw boom;
    }) as unknown as ExecFn;

    await expect(resolveImageDigest('ghcr.io/org/app:v1', {}, execFn)).rejects.toBe(boom);
  });
});

describe('registryHostFor', () => {
  // Pin the exact Docker Hub server string: login AND logout both use it, so
  // the credentials are erased from the same key they were stored under.
  it('Docker Hub login server is https://index.docker.io/v1/', () => {
    expect(DOCKER_HUB_LOGIN_SERVER).toBe('https://index.docker.io/v1/');
  });

  it.each([
    ['nginx', 'https://index.docker.io/v1/'],
    ['nginx:1.25', 'https://index.docker.io/v1/'],
    ['library/nginx', 'https://index.docker.io/v1/'],
    ['myorg/app:v1', 'https://index.docker.io/v1/'],
    ['docker.io/myorg/app', 'https://index.docker.io/v1/'],
    ['index.docker.io/myorg/app', 'https://index.docker.io/v1/'],
    ['ghcr.io/o/a:t', 'ghcr.io'],
    ['localhost/app', 'localhost'],
    ['localhost:5000/foo', 'localhost:5000'],
    ['my-registry:5000/x', 'my-registry:5000'],
    ['registry-1.docker.io/x/y', 'registry-1.docker.io'],
  ])('%s → %s', (ref, host) => {
    expect(registryHostFor(ref)).toBe(host);
  });
});
