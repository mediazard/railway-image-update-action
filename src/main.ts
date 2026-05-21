import * as core from '@actions/core';
import { getExecOutput } from '@actions/exec';

import { ActionError, emitToCore } from './errors';
import { readInputs } from './inputs/parse';
import { createRailwayClient } from './railway/client';
import { createDryRunClient } from './railway/dry-run';
import { DeployState } from './outputs/state';
import { writeOutputs } from './outputs/writer';
import { run } from './run';
import { savedState } from './state/saved';

/**
 * Action entry point. Dispatches main vs post based on saved state — if main
 * recorded cleanup work (e.g. a docker login), we're in the post step.
 * `runs.post-if: always()` ensures this entry is invoked on every workflow
 * outcome, so the post branch must NEVER call `core.setFailed` — a cleanup
 * failure must not mask the main run's result.
 */
async function entry(): Promise<void> {
  if (savedState.getDockerLogoutRegistry() !== '') {
    return runPost();
  }
  return runMain();
}

async function runMain(): Promise<void> {
  // Construct an empty DeployState FIRST so the finally block can always write
  // outputs — even if readInputs() throws. v0's bash trap emits empty
  // deployed-services / failed-services keys on early die(); consumer
  // workflows depend on those keys existing in $GITHUB_OUTPUT.
  let state: DeployState = DeployState.empty();

  try {
    const inputs = readInputs(); // throws on validation failure (already setSecret'd)
    state = new DeployState(Array.from(inputs.services.keys()));

    const client =
      process.env.DRY_RUN === 'true'
        ? createDryRunClient()
        : createRailwayClient({
            token: inputs.apiToken,
            tokenType: inputs.tokenType,
          });

    await run({ client, execFn: getExecOutput, inputs, state });
  } catch (err) {
    const actionErr =
      err instanceof ActionError
        ? err
        : new ActionError(err instanceof Error ? err.message : String(err), undefined, undefined, {
            cause: err,
          });
    await emitToCore(actionErr);
    // Set exit code, do NOT call core.setFailed — it would re-emit ::error::.
    process.exitCode = 1;
  } finally {
    writeOutputs(state);
  }
}

async function runPost(): Promise<void> {
  // Never set process.exitCode or call core.setFailed in post — cleanup
  // failures must not mask the main run's result.
  try {
    const registry = savedState.getDockerLogoutRegistry();
    if (registry !== '') {
      await getExecOutput('docker', ['logout', registry], { ignoreReturnCode: true, silent: true });
    }
  } catch (err) {
    core.warning(
      `Post cleanup encountered an error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Top-level execution. We don't `await` here so test files can import this
// module without triggering the entry. The bundled `dist/index.js` is invoked
// directly by the runner, not imported, so the IIFE runs as expected.
if (require.main === module) {
  void entry();
}

export { entry, runMain, runPost };
