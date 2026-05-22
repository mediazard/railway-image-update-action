import { DeployState } from '../../src/outputs/state';

describe('DeployState', () => {
  describe('empty()', () => {
    it('produces a state with no labels, deployed, or failed', () => {
      const s = DeployState.empty();
      expect(s.labels).toEqual([]);
      expect(s.deployedLabels()).toEqual([]);
      expect(s.failedLabels()).toEqual([]);
      expect(s.ids()).toEqual([]);
    });
  });

  describe('constructor with labels', () => {
    it('treats all labels as failed until marked', () => {
      const s = new DeployState(['web', 'worker', 'api']);
      expect(s.deployedLabels()).toEqual([]);
      expect(s.failedLabels()).toEqual(['web', 'worker', 'api']);
    });
  });

  describe('markDeployed', () => {
    it('is idempotent — calling twice does not duplicate', () => {
      const s = new DeployState(['web']);
      s.markDeployed('web');
      s.markDeployed('web');
      expect(s.deployedLabels()).toEqual(['web']);
    });

    it('preserves input order regardless of mark order', () => {
      const s = new DeployState(['c', 'a', 'b']);
      s.markDeployed('a');
      s.markDeployed('c');
      // Input order: c, a, b → deployed (in input order): c, a
      expect(s.deployedLabels()).toEqual(['c', 'a']);
    });
  });

  describe('failedLabels', () => {
    it('is labels minus deployed, in input order', () => {
      const s = new DeployState(['c', 'a', 'b']);
      s.markDeployed('a');
      expect(s.failedLabels()).toEqual(['c', 'b']);
    });
  });

  describe('attachDeploymentId', () => {
    it('records pairs in call order', () => {
      const s = new DeployState(['web', 'worker']);
      s.attachDeploymentId('web', 'dep-1');
      s.attachDeploymentId('worker', 'dep-2');
      expect(s.ids()).toEqual([
        { label: 'web', id: 'dep-1' },
        { label: 'worker', id: 'dep-2' },
      ]);
    });

    it('is independent from markDeployed (can attach without marking)', () => {
      const s = new DeployState(['web']);
      s.attachDeploymentId('web', 'dep-1');
      // attaching does not mark
      expect(s.deployedLabels()).toEqual([]);
      expect(s.ids()).toEqual([{ label: 'web', id: 'dep-1' }]);
    });

    it('allows multiple ids per label (recorded in call order)', () => {
      const s = new DeployState(['web']);
      s.attachDeploymentId('web', 'dep-1');
      s.attachDeploymentId('web', 'dep-2');
      expect(s.ids()).toEqual([
        { label: 'web', id: 'dep-1' },
        { label: 'web', id: 'dep-2' },
      ]);
    });
  });

  describe('markDeployed + attachDeploymentId independence', () => {
    it('marks deployed without attaching id', () => {
      const s = new DeployState(['web']);
      s.markDeployed('web');
      expect(s.deployedLabels()).toEqual(['web']);
      expect(s.ids()).toEqual([]);
    });
  });

  describe('imageTag', () => {
    it('is mutable', () => {
      const s = new DeployState(['web']);
      expect(s.imageTag).toBeUndefined();
      s.imageTag = 'ghcr.io/foo/bar@sha256:deadbeef';
      expect(s.imageTag).toBe('ghcr.io/foo/bar@sha256:deadbeef');
    });
  });

  describe('ids()', () => {
    it('returns the deploymentIds list', () => {
      const s = new DeployState(['a', 'b']);
      s.attachDeploymentId('a', '1');
      s.attachDeploymentId('b', '2');
      expect(s.ids()).toEqual([
        { label: 'a', id: '1' },
        { label: 'b', id: '2' },
      ]);
    });
  });
});
