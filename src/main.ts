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
 * Action entry point. Dispatches main vs post based on the `mainStarted`
 * sentinel — set by `runMain` at its first line, observable on the post
 * invocation. Sentinel `=== 'true'` ⇒ runPost (cleanup phase). Anything else
 * (empty, missing) ⇒ runMain (first invocation, OR runner re-invoke before
 * main started).
 *
 * `runs.post-if: always()` ensures this entry is invoked on every workflow
 * outcome, so the post branch must NEVER call `core.setFailed` or set
 * `process.exitCode` — a cleanup failure must not mask the main run's result.
 */
async function entry(): Promise<void> {
  if (savedState.hasMainStarted()) {
    return runPost();
  }
  return runMain();
}

async function runMain(): Promise<void> {
  // Load-bearing FIRST line: tell the post invocation we ran. Without this,
  // the post step would re-enter runMain when no cleanup work was recorded.
  savedState.markMainStarted();

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
        : // Intentionally do NOT pass { cause: err } here — Node's default
          // unhandled-rejection printer walks .cause chains and would print
          // the underlying ClientError's request body, which we just stripped.
          new ActionError(err instanceof Error ? err.message : String(err));
    await emitToCore(actionErr);
    // Set exit code, do NOT call core.setFailed — it would re-emit ::error::.
    process.exitCode = 1;
  } finally {
    // Wrapped in try/catch so a writeOutputs failure (e.g. GITHUB_OUTPUT
    // unwritable) cannot mask the original error from the main try block.
    try {
      writeOutputs(state);
    } catch (writeErr) {
      core.warning(
        `Failed to write GitHub Action outputs: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
      );
    }
  }
}

async function runPost(): Promise<void> {
  // Never set process.exitCode or call core.setFailed in post — cleanup
  // failures must not mask the main run's result.
  try {
    const registry = savedState.getDockerLogoutRegistry();
    if (registry !== '') {
      await getExecOutput('docker', ['logout', '--', registry], {
        ignoreReturnCode: true,
        silent: true,
      });
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
