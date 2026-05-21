import * as core from '@actions/core';

/**
 * Typed wrappers around core.saveState / core.getState. We deliberately do
 * NOT store a 'phase' marker — the post-step decides what to do by inspecting
 * the *cleanup work* recorded by main. If nothing was recorded, the post-step
 * exits silently (main never started, or it had no resources to clean up).
 */
export const savedState = {
  /** Records that a docker registry was logged into; post must docker-logout it. */
  recordDockerLogout(registry: string): void {
    core.saveState('dockerLogoutRegistry', registry);
  },

  /** Returns the registry to docker-logout from, or '' if main never logged in. */
  getDockerLogoutRegistry(): string {
    return core.getState('dockerLogoutRegistry');
  },
};
