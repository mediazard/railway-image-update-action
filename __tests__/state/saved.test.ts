vi.mock('@actions/core', () => ({
  saveState: vi.fn(),
  getState: vi.fn(),
}));

import * as core from '@actions/core';
import { savedState } from '../../src/state/saved';

describe('savedState', () => {
  describe('recordDockerLogout', () => {
    it('calls saveState("dockerLogoutRegistry", reg)', () => {
      savedState.recordDockerLogout('ghcr.io');
      expect(core.saveState).toHaveBeenCalledWith('dockerLogoutRegistry', 'ghcr.io');
    });
  });

  describe('getDockerLogoutRegistry', () => {
    it('calls getState("dockerLogoutRegistry") and returns the value', () => {
      (core.getState as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce('ghcr.io');
      const out = savedState.getDockerLogoutRegistry();
      expect(core.getState).toHaveBeenCalledWith('dockerLogoutRegistry');
      expect(out).toBe('ghcr.io');
    });

    it('returns empty string when state is unset (core.getState semantics)', () => {
      (core.getState as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce('');
      const out = savedState.getDockerLogoutRegistry();
      expect(out).toBe('');
    });
  });
});
