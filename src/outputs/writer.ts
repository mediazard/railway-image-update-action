import * as core from '@actions/core';
import type { DeployState } from './state';

/**
 * Writes the 4 outputs to $GITHUB_OUTPUT via core.setOutput. Always emits
 * `deployed-services` and `failed-services` (even when empty) — preserves
 * v0 bash trap semantic where consumer workflows rely on these keys existing.
 *
 * - deployed-services: comma-separated labels in input order
 * - failed-services:   comma-separated labels not in deployed, input order
 * - image-tag:         resolved digest ref (only set if state.imageTag defined)
 * - deployment-ids:    multiline `label=id` (one per line) — @actions/core
 *                      automatically wraps multiline values in <<DELIM/DELIM
 */
export function writeOutputs(state: DeployState): void {
  core.setOutput('deployed-services', state.deployedLabels().join(','));
  core.setOutput('failed-services', state.failedLabels().join(','));

  if (state.imageTag) {
    core.setOutput('image-tag', state.imageTag);
  }

  const ids = state.ids();
  if (ids.length > 0) {
    const multiline = ids.map(({ label, id }) => `${label}=${id}`).join('\n');
    core.setOutput('deployment-ids', multiline);
  }
}
