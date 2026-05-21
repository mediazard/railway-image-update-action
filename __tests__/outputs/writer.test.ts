vi.mock('@actions/core', () => ({
  setOutput: vi.fn(),
}));

import * as core from '@actions/core';
import { DeployState } from '../../src/outputs/state';
import { writeOutputs } from '../../src/outputs/writer';

describe('writeOutputs', () => {
  it('emits empty deployed/failed for empty state and skips image-tag and deployment-ids', () => {
    const s = DeployState.empty();

    writeOutputs(s);

    const setOutput = core.setOutput as unknown as ReturnType<typeof vi.fn>;
    expect(setOutput).toHaveBeenCalledWith('deployed-services', '');
    expect(setOutput).toHaveBeenCalledWith('failed-services', '');
    // image-tag NOT called
    const calls = setOutput.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain('image-tag');
    expect(calls).not.toContain('deployment-ids');
  });

  it('emits deployed/failed in input order with 2 deployed and 1 not', () => {
    const s = new DeployState(['web', 'api', 'worker']);
    s.markDeployed('web');
    s.markDeployed('worker');

    writeOutputs(s);

    const setOutput = core.setOutput as unknown as ReturnType<typeof vi.fn>;
    expect(setOutput).toHaveBeenCalledWith('deployed-services', 'web,worker');
    expect(setOutput).toHaveBeenCalledWith('failed-services', 'api');
  });

  it('emits image-tag when state.imageTag is set', () => {
    const s = new DeployState(['web']);
    s.imageTag = 'ghcr.io/foo/bar@sha256:deadbeef';

    writeOutputs(s);

    const setOutput = core.setOutput as unknown as ReturnType<typeof vi.fn>;
    expect(setOutput).toHaveBeenCalledWith('image-tag', 'ghcr.io/foo/bar@sha256:deadbeef');
  });

  it('emits deployment-ids as multiline label=id when ids exist', () => {
    const s = new DeployState(['web', 'worker']);
    s.markDeployed('web');
    s.markDeployed('worker');
    s.attachDeploymentId('web', 'dep-1');
    s.attachDeploymentId('worker', 'dep-2');

    writeOutputs(s);

    const setOutput = core.setOutput as unknown as ReturnType<typeof vi.fn>;
    expect(setOutput).toHaveBeenCalledWith('deployment-ids', 'web=dep-1\nworker=dep-2');
  });

  it('omits image-tag when imageTag is undefined', () => {
    const s = new DeployState(['web']);
    s.markDeployed('web');

    writeOutputs(s);

    const setOutput = core.setOutput as unknown as ReturnType<typeof vi.fn>;
    const calls = setOutput.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain('image-tag');
  });

  it('omits image-tag when imageTag is empty string', () => {
    const s = new DeployState(['web']);
    s.imageTag = '';

    writeOutputs(s);

    const setOutput = core.setOutput as unknown as ReturnType<typeof vi.fn>;
    const calls = setOutput.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain('image-tag');
  });
});
