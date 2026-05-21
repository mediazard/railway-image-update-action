import * as core from '@actions/core';

/**
 * Typed wrappers around core.saveState / core.getState.
 *
 * GitHub invokes this bundle twice when `runs.post` is set (`main` then
 * `post-if: always()`). We need a reliable way to tell the two apart, so the
 * very first thing `runMain` does is `markMainStarted()`. The post invocation
 * sees the marker and dispatches to runPost; if main never ran (e.g. the
 * runner crashed before our code executed), the marker is empty and the
 * post-step exits silently. Without this marker, the post invocation would
 * re-run `runMain` when no docker login happened during main.
 */
export const savedState = {
  /**
   * Records that `runMain` started. Called once, at the top of `runMain`,
   * BEFORE any other work — this is the load-bearing dispatch sentinel.
   */
  markMainStarted(): void {
    core.saveState('mainStarted', 'true');
  },

  /** Returns `'true'` on the post invocation iff runMain actually started. */
  hasMainStarted(): boolean {
    return core.getState('mainStarted') === 'true';
  },

  /** Records that a docker registry was logged into; post must docker-logout it. */
  recordDockerLogout(registry: string): void {
    core.saveState('dockerLogoutRegistry', registry);
  },

  /** Returns the registry to docker-logout from, or '' if main never logged in. */
  getDockerLogoutRegistry(): string {
    return core.getState('dockerLogoutRegistry');
  },
};
