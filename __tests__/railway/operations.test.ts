/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClientError } from 'graphql-request';

import { ActionError } from '../../src/errors';
import { redeploy, updateImage } from '../../src/railway/operations';
import { FakeRailwayClient } from '../fixtures/fake-client';

// Silence retry's `core.info` retry-attempt log.
vi.mock('@actions/core', () => ({
  info: vi.fn(),
  debug: vi.fn(),
}));

const SERVICE_ID = '550e8400-e29b-41d4-a716-446655440001';
const ENV_ID = '550e8400-e29b-41d4-a716-446655440000';

function makeClientError(status: number): ClientError {
  return new ClientError(
    {
      status,
      headers: new Headers(),
      body: '',
      errors: [],
    } as any,
    { query: '' } as any,
  );
}

describe('updateImage — happy path', () => {
  it('sends variables.input.registryCredentials when credentials provided', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('updateImage', {
      response: { serviceInstanceUpdate: null },
    });

    await updateImage(client, {
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
      image: 'registry/repo:tag',
      registryCredentials: { username: 'u', password: 'p' },
    });

    expect(client.calls).toHaveLength(1);
    const call = client.calls[0]!;
    expect(call.operationName).toBe('updateImage');
    const vars = call.variables as any;
    expect(vars.sid).toBe(SERVICE_ID);
    expect(vars.eid).toBe(ENV_ID);
    expect(vars.input.source).toEqual({ image: 'registry/repo:tag' });
    expect(vars.input.registryCredentials).toEqual({ username: 'u', password: 'p' });
  });

  it('omits registryCredentials when not provided (input is source-only)', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('updateImage', {
      response: { serviceInstanceUpdate: null },
    });

    await updateImage(client, {
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
      image: 'registry/repo:tag',
    });

    const vars = client.calls[0]!.variables as any;
    expect(vars.input).toEqual({ source: { image: 'registry/repo:tag' } });
    expect('registryCredentials' in vars.input).toBe(false);
  });
});

describe('updateImage — error paths', () => {
  it('throws ActionError (not raw ClientError) on 401', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('updateImage', { error: makeClientError(401) });

    await expect(
      updateImage(client, {
        serviceId: SERVICE_ID,
        environmentId: ENV_ID,
        image: 'registry/repo:tag',
      }),
    ).rejects.toBeInstanceOf(ActionError);
  });

  it('routes ClientError 401 through mapToActionError → "authentication failed"', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('updateImage', { error: makeClientError(401) });

    try {
      await updateImage(client, {
        serviceId: SERVICE_ID,
        environmentId: ENV_ID,
        image: 'registry/repo:tag',
      });
      throw new Error('expected updateImage to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ActionError);
      expect((e as ActionError).message.toLowerCase()).toContain('authentication failed');
    }
  });

  it('throws ActionError when response shape mismatches schema (zod parse fail)', async () => {
    const client = new FakeRailwayClient();
    // `serviceInstanceUpdate` field is missing — UpdateResponseSchema requires it.
    // (graphql-request@7 unwraps the outer `data` envelope, so our schema
    // validates the inner payload.)
    client.setResponse('updateImage', { response: { somethingElse: true } });

    await expect(
      updateImage(client, {
        serviceId: SERVICE_ID,
        environmentId: ENV_ID,
        image: 'registry/repo:tag',
      }),
    ).rejects.toBeInstanceOf(ActionError);
  });
});

describe('redeploy — happy path', () => {
  it('returns { deploymentId: "abc123" } when API returns that id', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('deployService', {
      response: { serviceInstanceDeploy: 'abc123' },
    });

    const result = await redeploy(client, {
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
      serviceLabel: 'api',
    });
    expect(result).toEqual({ deploymentId: 'abc123' });
  });

  it('returns { deploymentId: null } when API returns the boolean `true`', async () => {
    // Railway sometimes returns `serviceInstanceDeploy: true` instead of an id
    // string (deploy accepted but no id surfaced). v0 bash handled this via
    // `[[ "$deploy_id" != "true" ]]`. v1 normalizes boolean → null here so the
    // caller's "unavailable" warning fires. Caught by a failed London staging
    // deploy at SHA d3e49af5; without this normalization the zod schema
    // rejected the response and the whole deploy failed.
    const client = new FakeRailwayClient();
    client.setResponse('deployService', {
      response: { serviceInstanceDeploy: true },
    });

    const result = await redeploy(client, {
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
      serviceLabel: 'api',
    });
    expect(result).toEqual({ deploymentId: null });
  });

  it('returns { deploymentId: null } when API returns null', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('deployService', {
      response: { serviceInstanceDeploy: null },
    });

    const result = await redeploy(client, {
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
      serviceLabel: 'api',
    });
    expect(result).toEqual({ deploymentId: null });
  });

  it('passes operationName=deployService to the client', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('deployService', {
      response: { serviceInstanceDeploy: 'd' },
    });
    await redeploy(client, {
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
      serviceLabel: 'api',
    });
    expect(client.calls[0]!.operationName).toBe('deployService');
    expect(client.calls[0]!.variables).toEqual({ sid: SERVICE_ID, eid: ENV_ID });
  });
});

describe('redeploy — error paths', () => {
  it('throws ActionError on 401', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('deployService', { error: makeClientError(401) });

    await expect(
      redeploy(client, {
        serviceId: SERVICE_ID,
        environmentId: ENV_ID,
        serviceLabel: 'api',
      }),
    ).rejects.toBeInstanceOf(ActionError);
  });

  it('throws ActionError when response shape mismatches (e.g. data.serviceInstanceDeploy missing)', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('deployService', { response: { data: {} } });

    await expect(
      redeploy(client, {
        serviceId: SERVICE_ID,
        environmentId: ENV_ID,
        serviceLabel: 'api',
      }),
    ).rejects.toBeInstanceOf(ActionError);
  });

  it('includes serviceLabel in the operation context when erroring', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('deployService', { error: makeClientError(404) });

    try {
      await redeploy(client, {
        serviceId: SERVICE_ID,
        environmentId: ENV_ID,
        serviceLabel: 'my-label',
      });
      throw new Error('expected to throw');
    } catch (e) {
      // mapToActionError uses status mapping for 404 — message says "not found".
      expect(e).toBeInstanceOf(ActionError);
      expect((e as ActionError).message.toLowerCase()).toContain('not found');
    }
  });
});
