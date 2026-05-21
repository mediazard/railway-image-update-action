/**
 * Tests for `src/main.ts` — entry/runMain/runPost phase dispatch.
 *
 * Phase decision is based on the `mainStarted` sentinel that `runMain` writes
 * at its first line. Post is detected by `core.getState('mainStarted') === 'true'`.
 * This guarantees correct dispatch even when main recorded no cleanup work.
 *
 * Tests cover:
 *  - Phase A: main happy path (sentinel empty → runMain runs, writes the sentinel).
 *  - Phase B: post invocation (sentinel === 'true' → runPost runs, calls docker logout).
 *  - Phase C: post invocation with no cleanup state — runPost silently exits.
 *  - runPost swallows errors (warning only, never setFailed).
 *  - runMain validation failure: emitToCore once, exitCode=1, writeOutputs in finally.
 *  - runMain on error throws ONE `core.error` annotation, not two.
 */

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  notice: vi.fn(),
  debug: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
  setOutput: vi.fn(),
  setSecret: vi.fn(),
  saveState: vi.fn(),
  getState: vi.fn(() => ''),
  getInput: vi.fn(() => ''),
  getBooleanInput: vi.fn(() => false),
  setFailed: vi.fn(),
  summary: {
    addHeading: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    addQuote: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@actions/exec', () => ({
  getExecOutput: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
  exec: vi.fn(async () => 0),
}));

import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { entry, runMain, runPost } from '../src/main';

const ENV_UUID = '550e8400-e29b-41d4-a716-446655440000';
const WEB_UUID = '550e8400-e29b-41d4-a716-446655440001';

/** Reset process.exitCode between tests; vitest's restoreMocks handles spies. */
let originalExitCode: number | string | undefined;

beforeEach(() => {
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = originalExitCode;
  delete process.env.DRY_RUN;
});

/** Install a happy-path getInput mock matching v0 contract. */
function installHappyInputs(): void {
  vi.mocked(core.getInput).mockImplementation((name: string): string => {
    switch (name) {
      case 'api-token':
        return 'tok';
      case 'token-type':
        return 'bearer';
      case 'environment-id':
        return ENV_UUID;
      case 'image':
        // Already digest-pinned so resolveImageDigest is a no-op (no exec required).
        return 'ghcr.io/org/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      case 'services':
        return `web:${WEB_UUID}`;
      case 'first-service':
        return '';
      case 'wait-seconds':
        return '30';
      case 'registry-username':
        return '';
      case 'registry-password':
        return '';
      default:
        return '';
    }
  });
  vi.mocked(core.getBooleanInput).mockImplementation((name: string): boolean => {
    if (name === 'resolve-to-digest') return true;
    if (name === 'allow-mutable-tag') return false;
    return false;
  });
}

/** Helper: mock core.getState by key name. */
function mockState(values: Record<string, string>): void {
  vi.mocked(core.getState).mockImplementation((name: string): string => values[name] ?? '');
}

describe('entry — phase dispatch', () => {
  it('Phase A: mainStarted sentinel empty → runMain runs and writes the sentinel', async () => {
    mockState({});
    installHappyInputs();
    process.env.DRY_RUN = 'true';

    await entry();

    // runMain wrote the sentinel first thing.
    expect(core.saveState).toHaveBeenCalledWith('mainStarted', 'true');
    // runMain → writeOutputs is the side-effect we use to confirm "main ran".
    expect(core.setOutput).toHaveBeenCalledWith('deployed-services', expect.any(String));
    // We should NOT have invoked `docker logout`.
    expect(exec.getExecOutput).not.toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['logout']),
      expect.anything(),
    );
  });

  it('Phase B: mainStarted=true + dockerLogoutRegistry set → runPost (docker logout)', async () => {
    mockState({ mainStarted: 'true', dockerLogoutRegistry: 'ghcr.io' });

    await entry();

    expect(exec.getExecOutput).toHaveBeenCalledWith(
      'docker',
      ['logout', '--', 'ghcr.io'],
      expect.objectContaining({ ignoreReturnCode: true }),
    );
    // Post never writes outputs / never sets exitCode.
    expect(process.exitCode).toBeUndefined();
  });

  it('Phase C: mainStarted=true but no docker login → runPost silent (no double-run)', async () => {
    // Demonstrates the dispatch fix: post-step does NOT re-enter runMain when
    // main ran without recording cleanup work.
    mockState({ mainStarted: 'true' });

    await entry();

    // No docker logout (nothing to clean).
    expect(exec.getExecOutput).not.toHaveBeenCalled();
    // No outputs written (we're in post, not main).
    expect(core.setOutput).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});

describe('runPost', () => {
  it('calls docker logout with the recorded registry when state is non-empty', async () => {
    mockState({ dockerLogoutRegistry: 'docker.io' });

    await runPost();

    expect(exec.getExecOutput).toHaveBeenCalledWith(
      'docker',
      ['logout', '--', 'docker.io'],
      expect.objectContaining({ ignoreReturnCode: true }),
    );
  });

  it('NEVER calls core.setFailed even when docker logout throws', async () => {
    mockState({ dockerLogoutRegistry: 'ghcr.io' });
    vi.mocked(exec.getExecOutput).mockRejectedValueOnce(new Error('docker exec failure'));

    await runPost();

    expect(core.setFailed).not.toHaveBeenCalled();
    // It also must not set process.exitCode — cleanup never masks main result.
    expect(process.exitCode).toBeUndefined();
    // It SHOULD warn.
    expect(core.warning).toHaveBeenCalled();
  });

  it('exits silently when state is empty', async () => {
    mockState({});

    await runPost();

    expect(exec.getExecOutput).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
  });
});

describe('runMain — validation failure', () => {
  it('emits one error annotation, sets process.exitCode=1, still calls writeOutputs', async () => {
    // Empty api-token → readInputs throws ActionError("RAILWAY_API_TOKEN is not set").
    vi.mocked(core.getState).mockReturnValue('');
    vi.mocked(core.getInput).mockImplementation((name: string): string => {
      if (name === 'api-token') return '';
      if (name === 'token-type') return 'bearer';
      if (name === 'environment-id') return ENV_UUID;
      if (name === 'image') return 'ghcr.io/org/app:1.0.0';
      if (name === 'services') return `web:${WEB_UUID}`;
      if (name === 'first-service') return '';
      if (name === 'wait-seconds') return '30';
      return '';
    });
    vi.mocked(core.getBooleanInput).mockReturnValue(false);

    await runMain();

    // emitToCore was called → core.error fired exactly once.
    expect(core.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(core.error).mock.calls[0]?.[0]).toBe('RAILWAY_API_TOKEN is not set');

    // exitCode set to 1 (NOT via setFailed — that would double-emit).
    expect(process.exitCode).toBe(1);
    expect(core.setFailed).not.toHaveBeenCalled();

    // writeOutputs ran in the `finally`, emitting empty deployed-services + failed-services.
    expect(core.setOutput).toHaveBeenCalledWith('deployed-services', '');
    expect(core.setOutput).toHaveBeenCalledWith('failed-services', '');
  });

  it('uses process.exitCode=1 instead of core.setFailed (single ::error:: emission)', async () => {
    vi.mocked(core.getState).mockReturnValue('');
    // Trigger a validation error.
    vi.mocked(core.getInput).mockImplementation((name: string): string => {
      if (name === 'api-token') return '';
      return '';
    });
    vi.mocked(core.getBooleanInput).mockReturnValue(false);

    await runMain();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe('runMain — happy path under DRY_RUN', () => {
  it('writes outputs once with deployed-services populated', async () => {
    vi.mocked(core.getState).mockReturnValue('');
    installHappyInputs();
    process.env.DRY_RUN = 'true';

    await runMain();

    const deployedCalls = vi
      .mocked(core.setOutput)
      .mock.calls.filter((c) => c[0] === 'deployed-services');
    expect(deployedCalls).toHaveLength(1);
    expect(deployedCalls[0]?.[1]).toBe('web');
    // No error annotations on the happy path.
    expect(core.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
