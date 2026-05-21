import * as core from '@actions/core';

import { ActionError } from './errors';
import { resolveImageDigest, type ExecFn } from './image/digest';
import { isMutableRef } from './image/mutable';
import type { ActionInputs } from './inputs/schema';
import type { RailwayClient } from './railway/client';
import { redeploy, updateImage } from './railway/operations';
import type { DeployState } from './outputs/state';
import { savedState } from './state/saved';

export interface RunDeps {
  readonly client: RailwayClient;
  readonly execFn: ExecFn;
  readonly inputs: ActionInputs;
  /**
   * Mutated by reference as services succeed. Constructed in `main.ts` BEFORE
   * `run()` is called so partial mutations survive a thrown `run()` —
   * `main.ts`'s `finally` block always calls `writeOutputs(state)`.
   */
  readonly state: DeployState;
}

/**
 * Orchestrates the deploy: resolve image → update each service's image source →
 * trigger redeploy. Two paths: ordered (when `first-service` is set) and
 * parallel (no first-service). Iteration over services is SEQUENTIAL via
 * `for...of` + `await` — `Promise.all` would interleave logs the integration
 * tests grep for in order AND change which services land in
 * `deployed-services` on transient failure. This is enforced by the
 * `FakeRailwayClient` test fixture that throws on concurrent `request()`.
 */
export async function run(deps: RunDeps): Promise<void> {
  const { client, execFn, inputs, state } = deps;

  // Resolve image to a digest-pinned ref, or refuse mutable tags if opted out.
  const resolved = await resolveImage(inputs, execFn);
  state.imageTag = resolved;

  printDeploymentSummary(inputs, resolved);

  if (inputs.firstService !== '') {
    await deployOrdered(client, inputs, state, resolved);
  } else {
    await deployParallel(client, inputs, state, resolved);
  }

  core.info('');
  core.info(
    `✅ Deploy complete (${state.deployedLabels().length} services): ${state.deployedLabels().join(' ')}`,
  );
}

/** Resolve image to digest, or fail on mutable tags if not allowed. */
async function resolveImage(inputs: ActionInputs, execFn: ExecFn): Promise<string> {
  const isDryRun = process.env.DRY_RUN === 'true';

  if (inputs.resolveToDigest) {
    const registry = inputs.image.split('/')[0] ?? '';
    const creds =
      inputs.registryUsername !== '' && inputs.registryPassword !== ''
        ? { username: inputs.registryUsername, password: inputs.registryPassword }
        : undefined;
    return resolveImageDigest(
      inputs.image,
      {
        registry,
        credentials: creds,
        onDockerLogin: (r) => savedState.recordDockerLogout(r),
        isDryRun,
      },
      execFn,
    );
  }

  // resolve-to-digest is off — fail fast on mutable refs unless explicitly allowed.
  if (!inputs.allowMutableTag && isMutableRef(inputs.image)) {
    throw new ActionError(
      'Refusing to deploy mutable tag',
      `Image: ${inputs.image}\nThe tag appears to be mutable (e.g. :latest, :main, :master, :develop, :stable, or no tag)`,
      'Either use an immutable tag (e.g. sha-${{ github.sha }} or @sha256:...), set resolve-to-digest: true (the default), or set allow-mutable-tag: true to bypass this check',
    );
  }

  return inputs.image;
}

/** Print the v0 deployment-summary header lines via core.info. */
function printDeploymentSummary(inputs: ActionInputs, resolved: string): void {
  core.info(
    inputs.tokenType === 'project' ? '🔑 Token type: project' : '🔑 Token type: account/workspace',
  );
  if (resolved !== inputs.image) {
    core.info(`🐳 Image (input):    ${inputs.image}`);
    core.info(`🐳 Image (resolved): ${resolved}`);
  } else {
    core.info(`🐳 Image: ${inputs.image}`);
  }
  core.info(`🌍 Environment: ${inputs.environmentId}`);
  const labels = Array.from(inputs.services.keys());
  core.info(`📦 Services (${labels.length}): ${labels.join(' ')}`);
  if (inputs.registryUsername !== '' && inputs.registryPassword !== '') {
    core.info('🔐 Registry credentials: provided');
  }
  core.info('');
}

/** Ordered: redeploy first-service, wait, then update + redeploy the rest. */
async function deployOrdered(
  client: RailwayClient,
  inputs: ActionInputs,
  state: DeployState,
  image: string,
): Promise<void> {
  const firstLabel = inputs.firstService;
  const firstId = inputs.services.get(firstLabel);
  // Schema's refineFirstServiceExists already validated this, but narrow the type.
  if (firstId === undefined) {
    throw new ActionError(
      `first-service '${firstLabel}' not found in services list`,
      `Requested first-service: ${firstLabel}\nAvailable services: ${Array.from(inputs.services.keys()).join(', ')}`,
      'Use one of the available service labels, or remove the first-service input',
    );
  }

  const creds = buildCreds(inputs);

  core.info(`Step 1/3: Updating image source and redeploying [${firstLabel}] first`);
  core.info(`  ↳ Updating image on [${firstLabel}]`);
  await updateImage(client, {
    serviceId: firstId,
    environmentId: inputs.environmentId,
    image,
    registryCredentials: creds,
  });
  core.info(`  ↳ Deploying [${firstLabel}]`);
  const firstResult = await redeploy(client, {
    serviceId: firstId,
    environmentId: inputs.environmentId,
    serviceLabel: firstLabel,
  });
  state.markDeployed(firstLabel);
  recordDeploymentId(state, firstLabel, firstResult.deploymentId);

  core.info(`  ⏳ Waiting ${inputs.waitSeconds}s for first service to stabilise...`);
  await sleep(inputs.waitSeconds * 1000);
  core.info('');

  core.info('Step 2/3: Updating image source on remaining services');
  for (const [label, sid] of inputs.services) {
    if (label === firstLabel) continue;
    core.info(`  ↳ Updating image on [${label}]`);
    await updateImage(client, {
      serviceId: sid,
      environmentId: inputs.environmentId,
      image,
      registryCredentials: creds,
    });
  }
  core.info('');

  core.info('Step 3/3: Redeploying remaining services');
  for (const [label, sid] of inputs.services) {
    if (label === firstLabel) continue;
    core.info(`  ↳ Deploying [${label}]`);
    const result = await redeploy(client, {
      serviceId: sid,
      environmentId: inputs.environmentId,
      serviceLabel: label,
    });
    state.markDeployed(label);
    recordDeploymentId(state, label, result.deploymentId);
  }
}

/** Parallel: 2 steps — update all, then redeploy all. */
async function deployParallel(
  client: RailwayClient,
  inputs: ActionInputs,
  state: DeployState,
  image: string,
): Promise<void> {
  const creds = buildCreds(inputs);

  core.info('Step 1/2: Updating image source on all services');
  for (const [label, sid] of inputs.services) {
    core.info(`  ↳ Updating image on [${label}]`);
    await updateImage(client, {
      serviceId: sid,
      environmentId: inputs.environmentId,
      image,
      registryCredentials: creds,
    });
  }
  core.info('');

  core.info('Step 2/2: Redeploying all services');
  for (const [label, sid] of inputs.services) {
    core.info(`  ↳ Deploying [${label}]`);
    const result = await redeploy(client, {
      serviceId: sid,
      environmentId: inputs.environmentId,
      serviceLabel: label,
    });
    state.markDeployed(label);
    recordDeploymentId(state, label, result.deploymentId);
  }
}

function buildCreds(inputs: ActionInputs): { username: string; password: string } | undefined {
  return inputs.registryUsername !== '' && inputs.registryPassword !== ''
    ? { username: inputs.registryUsername, password: inputs.registryPassword }
    : undefined;
}

function recordDeploymentId(state: DeployState, label: string, id: string | null): void {
  if (id !== null && id !== '') {
    core.info(`[${label}] deployment-id: ${id}`);
    state.attachDeploymentId(label, id);
  } else {
    core.warning(`[${label}] deployment-id: (unavailable)`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
