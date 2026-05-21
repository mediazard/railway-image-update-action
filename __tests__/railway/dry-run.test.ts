/* eslint-disable @typescript-eslint/no-explicit-any */
vi.mock('@actions/core', () => ({
  info: vi.fn(),
  debug: vi.fn(),
}));

import * as core from '@actions/core';

import { createDryRunClient } from '../../src/railway/dry-run';
import {
  DEPLOY_MUTATION,
  RAILWAY_API_URL,
  UPDATE_IMAGE_MUTATION,
} from '../../src/railway/mutations';

const infoMock = core.info as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  infoMock.mockReset();
});

describe('createDryRunClient — canned responses', () => {
  it('returns serviceInstanceDeploy id for DEPLOY_MUTATION', async () => {
    const client = createDryRunClient();
    const result = await client.request<unknown, unknown>(
      DEPLOY_MUTATION,
      { sid: 's', eid: 'e' },
      { operationName: 'deployService' },
    );
    expect(result).toEqual({ serviceInstanceDeploy: 'dry-run-deploy-id' });
  });

  it('returns serviceInstanceUpdate stub for UPDATE_IMAGE_MUTATION', async () => {
    const client = createDryRunClient();
    const result = await client.request<unknown, unknown>(
      UPDATE_IMAGE_MUTATION,
      { sid: 's', eid: 'e', input: { source: { image: 'x' } } },
      { operationName: 'updateImage' },
    );
    expect(result).toEqual({ serviceInstanceUpdate: { id: 'dry-run-update-id' } });
  });

  it('returns dryRun: true for any non-deploy document', async () => {
    const client = createDryRunClient();
    const result = await client.request<unknown, unknown>(
      'query SomeOtherThing { whatever }',
      {},
      { operationName: 'whatever' },
    );
    expect(result).toEqual({ dryRun: true });
  });
});

describe('createDryRunClient — invariant: never rejects', () => {
  it('resolves for DEPLOY_MUTATION even with no opts', async () => {
    const client = createDryRunClient();
    await expect(client.request(DEPLOY_MUTATION, {})).resolves.toBeDefined();
  });

  it('resolves for UPDATE_IMAGE_MUTATION even with no opts', async () => {
    const client = createDryRunClient();
    await expect(client.request(UPDATE_IMAGE_MUTATION, {})).resolves.toBeDefined();
  });

  it('resolves for an arbitrary third document type', async () => {
    const client = createDryRunClient();
    await expect(client.request('query Foo { foo }', {})).resolves.toBeDefined();
  });
});

describe('createDryRunClient — logging via core.info', () => {
  it('emits the [DRY-RUN] triplet (Would send / Operation / Body) plus body line', async () => {
    const client = createDryRunClient();
    await client.request(
      UPDATE_IMAGE_MUTATION,
      { sid: 'svc', eid: 'env', input: { source: { image: 'img:1' } } },
      { operationName: 'updateImage' },
    );

    const calls = infoMock.mock.calls.map((c) => c[0] as string);
    expect(calls[0]).toBe(`[DRY-RUN] Would send to ${RAILWAY_API_URL}:`);
    expect(calls[1]).toBe('[DRY-RUN]   Operation: updateImage');
    expect(calls[2]).toBe('[DRY-RUN]   Body:');
    expect(calls[3]).toContain(UPDATE_IMAGE_MUTATION);
    expect(calls[3]).toContain('"sid":"svc"');
  });

  it('falls back to "GraphQL request" when operationName not supplied', async () => {
    const client = createDryRunClient();
    await client.request(UPDATE_IMAGE_MUTATION, {});
    const calls = infoMock.mock.calls.map((c) => c[0] as string);
    expect(calls[1]).toBe('[DRY-RUN]   Operation: GraphQL request');
  });

  it('logs different operation names for different calls', async () => {
    const client = createDryRunClient();
    await client.request(DEPLOY_MUTATION, {}, { operationName: 'deployService' });
    const calls = infoMock.mock.calls.map((c) => c[0] as string);
    expect(calls).toContain('[DRY-RUN]   Operation: deployService');
  });
});
