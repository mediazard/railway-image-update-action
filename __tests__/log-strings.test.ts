/**
 * Per-string assertion suite for v0-preserved log strings.
 *
 * Each `it()` case drives `run()` (or `emitToCore`) with a minimal setup and
 * asserts the exact literal string appears on the right `@actions/core`
 * channel (info / warning / error / notice / startGroup / endGroup).
 *
 * Strings tested are from the plan's Public Contract parity table.
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

import * as core from '@actions/core';

import { run } from '../src/run';
import { ActionError, emitToCore } from '../src/errors';
import { DeployState } from '../src/outputs/state';
import type { ActionInputs } from '../src/inputs/schema';
import { FakeRailwayClient } from './fixtures/fake-client';

const ENV_UUID = '550e8400-e29b-41d4-a716-446655440000';
const A_UUID = '550e8400-e29b-41d4-a716-446655440001';
const B_UUID = '550e8400-e29b-41d4-a716-446655440002';

const DIGEST_IMAGE =
  'ghcr.io/org/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function makeExecFn() {
  return vi.fn(async () => ({ stdout: '{"digest":"sha256:f00"}', stderr: '', exitCode: 0 }));
}

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  const services =
    overrides.services ??
    new Map<string, string>([
      ['api', A_UUID],
      ['worker', B_UUID],
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

/** A success-canned client for run() so we exercise the full log path. */
function happyClient(deployId: string | null = 'deploy-id-1'): FakeRailwayClient {
  const c = new FakeRailwayClient();
  c.setResponse('serviceInstanceUpdate', {
    response: { serviceInstanceUpdate: {} },
  });
  c.setResponse('serviceInstanceDeploy', {
    response: { serviceInstanceDeploy: deployId },
  });
  return c;
}

/** Collect every string passed to a `core.X` channel — flattened. */
function messages(channel: ReturnType<typeof vi.fn>): string[] {
  return (channel.mock.calls as unknown[][]).map((c) => String(c[0] ?? ''));
}

describe('log strings — step headers (parallel path)', () => {
  it('emits "Step 1/2: Updating image source on all services" via core.info', async () => {
    const inputs = makeInputs();
    const state = new DeployState(Array.from(inputs.services.keys()));
    await run({ client: happyClient(), execFn: makeExecFn(), inputs, state });
    expect(messages(vi.mocked(core.info))).toContain(
      'Step 1/2: Updating image source on all services',
    );
  });

  it('emits "Step 2/2: Redeploying all services" via core.info', async () => {
    const inputs = makeInputs();
    const state = new DeployState(Array.from(inputs.services.keys()));
    await run({ client: happyClient(), execFn: makeExecFn(), inputs, state });
    expect(messages(vi.mocked(core.info))).toContain('Step 2/2: Redeploying all services');
  });
});

describe('log strings — step headers (ordered path)', () => {
  it('emits "Step 1/3", "Step 2/3", "Step 3/3" via core.info', async () => {
    const services = new Map<string, string>([
      ['web', A_UUID],
      ['worker', B_UUID],
    ]);
    const inputs = makeInputs({ services, firstService: 'web', waitSeconds: 0 });
    const state = new DeployState(Array.from(inputs.services.keys()));
    await run({ client: happyClient(), execFn: makeExecFn(), inputs, state });

    const infoLines = messages(vi.mocked(core.info));
    expect(infoLines).toContain('Step 1/3: Updating image source and redeploying [web] first');
    expect(infoLines).toContain('Step 2/3: Updating image source on remaining services');
    expect(infoLines).toContain('Step 3/3: Redeploying remaining services');
  });
});

describe('log strings — per-service progress lines', () => {
  it('emits "  ↳ Updating image on [api]" and "  ↳ Deploying [api]" via core.info', async () => {
    const inputs = makeInputs();
    const state = new DeployState(Array.from(inputs.services.keys()));
    await run({ client: happyClient(), execFn: makeExecFn(), inputs, state });

    const infoLines = messages(vi.mocked(core.info));
    expect(infoLines).toContain('  ↳ Updating image on [api]');
    expect(infoLines).toContain('  ↳ Updating image on [worker]');
    expect(infoLines).toContain('  ↳ Deploying [api]');
    expect(infoLines).toContain('  ↳ Deploying [worker]');
  });

  it('emits "[label] deployment-id: <id>" via core.info when id is non-null', async () => {
    const inputs = makeInputs();
    const state = new DeployState(Array.from(inputs.services.keys()));
    await run({ client: happyClient('abc123'), execFn: makeExecFn(), inputs, state });
    expect(messages(vi.mocked(core.info))).toContain('[api] deployment-id: abc123');
    expect(messages(vi.mocked(core.info))).toContain('[worker] deployment-id: abc123');
  });

  it('emits "[label] deployment-id: (unavailable — Railway returned: null)" via core.warning when id is null', async () => {
    const inputs = makeInputs();
    const state = new DeployState(Array.from(inputs.services.keys()));
    await run({ client: happyClient(null), execFn: makeExecFn(), inputs, state });
    expect(messages(vi.mocked(core.warning))).toContain(
      '[api] deployment-id: (unavailable — Railway returned: null)',
    );
    expect(messages(vi.mocked(core.warning))).toContain(
      '[worker] deployment-id: (unavailable — Railway returned: null)',
    );
  });

  it('emits "[label] deployment-id: (unavailable — Railway returned: true)" when Railway sent the boolean', async () => {
    // The real-production case captured from London staging run 26274637756:
    // Railway returns the boolean `true` from serviceInstanceDeploy. v1
    // surfaces the actual value in the warning, not a hardcoded "null".
    const inputs = makeInputs();
    const state = new DeployState(Array.from(inputs.services.keys()));
    const c = new FakeRailwayClient();
    c.setResponse('serviceInstanceUpdate', { response: { serviceInstanceUpdate: {} } });
    c.setResponse('serviceInstanceDeploy', { response: { serviceInstanceDeploy: true } });
    await run({ client: c, execFn: makeExecFn(), inputs, state });
    expect(messages(vi.mocked(core.warning))).toContain(
      '[api] deployment-id: (unavailable — Railway returned: true)',
    );
  });
});

describe('log strings — deployment summary header', () => {
  it('emits "🔑 Token type: account/workspace" via core.info (bearer)', async () => {
    const inputs = makeInputs({ tokenType: 'bearer' });
    const state = new DeployState(Array.from(inputs.services.keys()));
    await run({ client: happyClient(), execFn: makeExecFn(), inputs, state });
    expect(messages(vi.mocked(core.info))).toContain('🔑 Token type: account/workspace');
  });

  it('emits "🔑 Token type: project" via core.info (project)', async () => {
    const inputs = makeInputs({ tokenType: 'project' });
    const state = new DeployState(Array.from(inputs.services.keys()));
    await run({ client: happyClient(), execFn: makeExecFn(), inputs, state });
    expect(messages(vi.mocked(core.info))).toContain('🔑 Token type: project');
  });

  it('emits "🐳 Image: <image>" via core.info when image is not re-resolved', async () => {
    const inputs = makeInputs({ image: DIGEST_IMAGE });
    const state = new DeployState(Array.from(inputs.services.keys()));
    await run({ client: happyClient(), execFn: makeExecFn(), inputs, state });
    expect(messages(vi.mocked(core.info))).toContain(`🐳 Image: ${DIGEST_IMAGE}`);
  });

  it('emits "🐳 Image (input): ..." + "🐳 Image (resolved): ..." when digest-resolved', async () => {
    const execFn = vi.fn(async () => ({
      stdout:
        '{"digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}',
      stderr: '',
      exitCode: 0,
    }));
    const inputs = makeInputs({
      image: 'ghcr.io/foo/bar:1.0',
      resolveToDigest: true,
      allowMutableTag: false,
    });
    const state = new DeployState(Array.from(inputs.services.keys()));
    await run({ client: happyClient(), execFn, inputs, state });

    const infoLines = messages(vi.mocked(core.info));
    expect(infoLines).toContain('🐳 Image (input):    ghcr.io/foo/bar:1.0');
    expect(infoLines).toContain(
      '🐳 Image (resolved): ghcr.io/foo/bar@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    );
  });

  it('emits "🌍 Environment: <id>" via core.info', async () => {
    const inputs = makeInputs();
    const state = new DeployState(Array.from(inputs.services.keys()));
    await run({ client: happyClient(), execFn: makeExecFn(), inputs, state });
    expect(messages(vi.mocked(core.info))).toContain(`🌍 Environment: ${ENV_UUID}`);
  });

  it('emits "📦 Services (N): a b" via core.info', async () => {
    const inputs = makeInputs();
    const state = new DeployState(Array.from(inputs.services.keys()));
    await run({ client: happyClient(), execFn: makeExecFn(), inputs, state });
    expect(messages(vi.mocked(core.info))).toContain('📦 Services (2): api worker');
  });

  it('emits "🔐 Registry credentials: provided" only when both username and password are set', async () => {
    const inputs = makeInputs({
      registryUsername: 'u',
      registryPassword: 'p',
    });
    const state = new DeployState(Array.from(inputs.services.keys()));
    await run({ client: happyClient(), execFn: makeExecFn(), inputs, state });
    expect(messages(vi.mocked(core.info))).toContain('🔐 Registry credentials: provided');
  });

  it('does NOT emit registry credentials line when neither is set', async () => {
    const inputs = makeInputs();
    const state = new DeployState(Array.from(inputs.services.keys()));
    await run({ client: happyClient(), execFn: makeExecFn(), inputs, state });
    expect(messages(vi.mocked(core.info))).not.toContain('🔐 Registry credentials: provided');
  });
});

describe('log strings — completion line', () => {
  it('emits "✅ Deploy complete (N services): <labels>" via core.info', async () => {
    const inputs = makeInputs();
    const state = new DeployState(Array.from(inputs.services.keys()));
    await run({ client: happyClient(), execFn: makeExecFn(), inputs, state });
    expect(messages(vi.mocked(core.info))).toContain('✅ Deploy complete (2 services): api worker');
  });
});

describe('log strings — error annotations', () => {
  it('emits "Refusing to deploy mutable tag" via core.error (through emitToCore)', async () => {
    const err = new ActionError('Refusing to deploy mutable tag', 'details here', 'hint here');
    await emitToCore(err);

    // The exact message is the first arg to core.error.
    expect(messages(vi.mocked(core.error))).toContain('Refusing to deploy mutable tag');

    // The details are wrapped in startGroup('Details') ... endGroup, with info() in between.
    expect(vi.mocked(core.startGroup)).toHaveBeenCalledWith('Details');
    expect(messages(vi.mocked(core.info))).toContain('details here');
    expect(vi.mocked(core.endGroup)).toHaveBeenCalled();

    // The hint is emitted via core.notice with title 'Hint'.
    expect(vi.mocked(core.notice)).toHaveBeenCalledWith(
      'hint here',
      expect.objectContaining({ title: 'Hint' }),
    );

    // Summary write was awaited.
    expect(vi.mocked(core.summary.write)).toHaveBeenCalled();
  });

  it('startGroup/endGroup are used ONLY in emitToCore (never around step headers)', async () => {
    const inputs = makeInputs();
    const state = new DeployState(Array.from(inputs.services.keys()));
    await run({ client: happyClient(), execFn: makeExecFn(), inputs, state });

    // run() emits no startGroup/endGroup calls on the happy path — those are reserved
    // for emitToCore's "Details" wrapping.
    expect(vi.mocked(core.startGroup)).not.toHaveBeenCalled();
    expect(vi.mocked(core.endGroup)).not.toHaveBeenCalled();
  });
});
