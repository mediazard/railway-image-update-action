/**
 * Tests for `src/run.ts` — the orchestrator.
 *
 * Drives `run()` with a `FakeRailwayClient` that records every call and
 * throws on concurrent in-flight requests. Asserts:
 *   - Sequential ordering on parallel and ordered paths.
 *   - DeployState mutation on success.
 *   - Partial-failure preservation (state still holds deployed labels when
 *     a later call throws).
 *   - Mutable-tag refusal + digest resolution toggles.
 *   - first-service not in services Map runtime guard.
 *   - waitSeconds=0 doesn't actually block.
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
  summary: {
    addHeading: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    addQuote: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  },
}));

import { run } from '../src/run';
import { ActionError } from '../src/errors';
import { DeployState } from '../src/outputs/state';
import type { ActionInputs } from '../src/inputs/schema';
import { FakeRailwayClient } from './fixtures/fake-client';

const ENV_UUID = '550e8400-e29b-41d4-a716-446655440000';
const A_UUID = '550e8400-e29b-41d4-a716-446655440001';
const B_UUID = '550e8400-e29b-41d4-a716-446655440002';
const C_UUID = '550e8400-e29b-41d4-a716-446655440003';

/** Pre-resolved digest-pinned image so resolveImageDigest is a no-op. */
const DIGEST_IMAGE =
  'ghcr.io/org/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** A canned execFn for resolveImageDigest — never expected to fire when image is already digest-pinned. */
function makeExecFn(
  stdout = '{"digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}',
) {
  return vi.fn(async () => ({ stdout, stderr: '', exitCode: 0 }));
}

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  const services =
    overrides.services ??
    new Map<string, string>([
      ['a', A_UUID],
      ['b', B_UUID],
      ['c', C_UUID],
    ]);
  return {
    apiToken: 'tok',
    tokenType: 'bearer',
    environmentId: ENV_UUID,
    image: DIGEST_IMAGE,
    services,
    firstService: '',
    waitSeconds: 30,
    registryUsername: '',
    registryPassword: '',
    resolveToDigest: false,
    allowMutableTag: true,
    ...overrides,
  } as ActionInputs;
}

/** Configure the fake client with success canned responses for update + redeploy + status. */
function happyClient(): FakeRailwayClient {
  const c = new FakeRailwayClient();
  // FakeRailwayClient.setResponse matches by operationName first, then by
  // substring of the document. We key by operationName for clarity.
  c.setResponse('updateImage', { response: { serviceInstanceUpdate: { id: 'u' } } });
  c.setResponse('deployService', { response: { serviceInstanceDeployV2: 'deploy-id-x' } });
  // Ordered path polls `deployment(id)` after the first redeploy — return
  // SUCCESS immediately so `waitForDeployment` exits on the first iteration.
  c.setResponse('deploymentStatus', {
    response: {
      deployment: { id: 'deploy-id-x', status: 'SUCCESS', createdAt: '1970-01-01T00:00:00Z' },
    },
  });
  return c;
}

/**
 * Extract a simplified call sequence: [(kind, sid), ...]. `kind` derived
 * from the GraphQL document substring; `sid` from the `variables.sid`.
 */
function callSequence(client: FakeRailwayClient): Array<[string, string]> {
  return client.calls.map((c) => {
    const vars = c.variables as { sid?: string; id?: string } | undefined;
    const sid = vars?.sid ?? vars?.id ?? '';
    const kind = c.document.includes('serviceInstanceUpdate')
      ? 'update'
      : c.document.includes('serviceInstanceDeployV2') ||
          c.document.includes('serviceInstanceDeploy')
        ? 'deploy'
        : c.document.includes('deployment(id:')
          ? 'status'
          : 'unknown';
    return [kind, sid];
  });
}

describe('run — parallel path (no first-service)', () => {
  it('updates all then deploys all, in input order, sequentially', async () => {
    const client = happyClient();
    const inputs = makeInputs();
    const state = new DeployState(Array.from(inputs.services.keys()));

    await run({ client, execFn: makeExecFn(), inputs, state });

    expect(callSequence(client)).toEqual([
      ['update', A_UUID],
      ['update', B_UUID],
      ['update', C_UUID],
      ['deploy', A_UUID],
      ['deploy', B_UUID],
      ['deploy', C_UUID],
    ]);
  });

  it('mutates DeployState: deployedLabels in input order, imageTag set', async () => {
    const client = happyClient();
    const inputs = makeInputs();
    const state = new DeployState(Array.from(inputs.services.keys()));

    await run({ client, execFn: makeExecFn(), inputs, state });

    expect(state.deployedLabels()).toEqual(['a', 'b', 'c']);
    expect(state.imageTag).toBe(DIGEST_IMAGE);
  });
});

describe('run — ordered path (first-service set)', () => {
  it('redeploys first, then updates the rest, then deploys the rest', async () => {
    const services = new Map<string, string>([
      ['web', A_UUID],
      ['worker', B_UUID],
      ['clock', C_UUID],
    ]);
    const client = happyClient();
    const inputs = makeInputs({ services, firstService: 'web', waitSeconds: 0 });
    const state = new DeployState(Array.from(inputs.services.keys()));

    await run({ client, execFn: makeExecFn(), inputs, state });

    // Ordered flow: update(web), deploy(web), poll status until SUCCESS,
    // then update(worker), update(clock), deploy(worker), deploy(clock).
    // The status query has id=deploy-id-x (no sid), so its tuple is
    // ['status', 'deploy-id-x'] from callSequence's vars.id fallback.
    expect(callSequence(client)).toEqual([
      ['update', A_UUID],
      ['deploy', A_UUID],
      ['status', 'deploy-id-x'],
      ['update', B_UUID],
      ['update', C_UUID],
      ['deploy', B_UUID],
      ['deploy', C_UUID],
    ]);
    expect(state.deployedLabels()).toEqual(['web', 'worker', 'clock']);
  });

  it('waitSeconds=0 means the ordered path does not block measurably', async () => {
    const services = new Map<string, string>([
      ['web', A_UUID],
      ['worker', B_UUID],
    ]);
    const client = happyClient();
    const inputs = makeInputs({ services, firstService: 'web', waitSeconds: 0 });
    const state = new DeployState(Array.from(inputs.services.keys()));

    const start = Date.now();
    await run({ client, execFn: makeExecFn(), inputs, state });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
  });

  it('throws ActionError when first-service is not a key in services Map', async () => {
    // This guard exists in run.ts at runtime (the schema also catches it, but we
    // build the inputs object directly, bypassing the schema's refineFirstServiceExists).
    const services = new Map<string, string>([
      ['web', A_UUID],
      ['worker', B_UUID],
    ]);
    const client = happyClient();
    const inputs = makeInputs({
      services,
      firstService: 'nope',
      waitSeconds: 0,
    });
    const state = new DeployState(Array.from(inputs.services.keys()));

    await expect(run({ client, execFn: makeExecFn(), inputs, state })).rejects.toBeInstanceOf(
      ActionError,
    );

    try {
      await run({ client, execFn: makeExecFn(), inputs, state });
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as ActionError).message).toBe("first-service 'nope' not found in services list");
    }
  });
});

describe('run — partial-failure preservation (v0 trap semantic)', () => {
  it('preserves labels deployed BEFORE the failure on the parallel path', async () => {
    // Parallel: update A, update B, update C, deploy A, deploy B(FAIL), deploy C.
    // After deploy A completes (state.markDeployed('a')), redeploy B throws.
    // run() re-throws; state.deployedLabels() should still contain ['a'].
    const client = new FakeRailwayClient();
    client.setResponse('updateImage', { response: { serviceInstanceUpdate: {} } });
    client.setResponse('deployService', { response: { serviceInstanceDeployV2: 'deploy-id-x' } });
    // Custom dispatch for redeploy: succeed for A, throw for B, never reached for C.
    let deployCount = 0;
    const originalRequest = client.request.bind(client);
    client.request = async function <TVars, TResult>(
      document: string,
      variables: TVars,
      opts?: { signal?: AbortSignal; operationName?: string },
    ): Promise<TResult> {
      if (document.includes('serviceInstanceDeploy')) {
        deployCount += 1;
        if (deployCount === 2) {
          // Pretend the second deploy throws an ActionError directly (post-mapToActionError).
          // We need to record the call first, so do that manually via the regular path
          // but then throw afterward. Easiest: push the call manually and throw.
          (client as unknown as { calls: unknown[] }).calls.push({
            document,
            variables,
            operationName: opts?.operationName,
          });
          throw new ActionError(
            'Railway API returned an error during deployService:b',
            'simulated',
            'simulated',
          );
        }
      }
      return originalRequest<TVars, TResult>(document, variables, opts);
    };

    const inputs = makeInputs();
    const state = new DeployState(Array.from(inputs.services.keys()));

    await expect(run({ client, execFn: makeExecFn(), inputs, state })).rejects.toBeInstanceOf(
      ActionError,
    );

    // A was deployed before B failed → still in deployedLabels().
    expect(state.deployedLabels()).toEqual(['a']);
    // B and C are in failedLabels().
    expect(state.failedLabels()).toEqual(['b', 'c']);
    // imageTag was set before the failure.
    expect(state.imageTag).toBe(DIGEST_IMAGE);
  });
});

describe('run — image resolution', () => {
  it('throws "Refusing to deploy mutable tag" when resolveToDigest=false + allowMutableTag=false + mutable tag', async () => {
    const client = happyClient();
    const inputs = makeInputs({
      image: 'ghcr.io/foo/bar:latest',
      resolveToDigest: false,
      allowMutableTag: false,
    });
    const state = new DeployState(Array.from(inputs.services.keys()));

    await expect(run({ client, execFn: makeExecFn(), inputs, state })).rejects.toBeInstanceOf(
      ActionError,
    );

    try {
      await run({ client, execFn: makeExecFn(), inputs, state });
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as ActionError).message).toBe('Refusing to deploy mutable tag');
    }
  });

  it('with resolveToDigest=false and allowMutableTag=true, passes raw image through unchanged and never calls execFn', async () => {
    const client = happyClient();
    const execFn = makeExecFn();
    const inputs = makeInputs({
      image: 'ghcr.io/foo/bar:1.2.3',
      resolveToDigest: false,
      allowMutableTag: true,
    });
    const state = new DeployState(Array.from(inputs.services.keys()));

    await run({ client, execFn, inputs, state });

    expect(state.imageTag).toBe('ghcr.io/foo/bar:1.2.3');
    expect(execFn).not.toHaveBeenCalled();
  });

  it('with resolveToDigest=true and a tagged image, invokes execFn to resolve manifest digest', async () => {
    const client = happyClient();
    const execFn = makeExecFn(
      '{"digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}',
    );
    const inputs = makeInputs({
      image: 'ghcr.io/foo/bar:1.2.3',
      resolveToDigest: true,
      allowMutableTag: false,
    });
    const state = new DeployState(Array.from(inputs.services.keys()));

    await run({ client, execFn, inputs, state });

    // resolveImageDigest invokes execFn at least once (for `imagetools inspect`).
    expect(execFn).toHaveBeenCalled();
    expect(state.imageTag).toBe(
      'ghcr.io/foo/bar@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    );
  });
});

describe('run — sequential-iteration invariant (defense in depth)', () => {
  it('FakeRailwayClient throws on overlap; passing parallel-path test proves no overlap', async () => {
    // The happy-path parallel test (first test in this file) already exercises
    // this: if run() ever switched to Promise.all, the fake would throw on the
    // second concurrent request. This is a meta-test that explicitly invokes
    // the fake with manually overlapping calls to prove the overlap detection
    // actually works.
    const c = happyClient();
    // Use the real operationName so the fake's canned-response lookup
    // succeeds; otherwise the first call rejects with "no canned response"
    // before the second call ever fires.
    const p1 = c.request('any', { sid: A_UUID }, { operationName: 'updateImage' });
    // Don't await p1; start a second call concurrently.
    await expect(
      c.request('any', { sid: B_UUID }, { operationName: 'updateImage' }),
    ).rejects.toThrow(/concurrent request/);
    await p1;
  });
});
