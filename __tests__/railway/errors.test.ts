/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClientError } from 'graphql-request';
import { AbortError } from 'p-retry';

import { ActionError } from '../../src/errors';
import { mapToActionError } from '../../src/railway/errors';

/**
 * Build a ClientError. Caller controls status, errors[], and (optionally) the
 * request body and headers to verify the security invariant.
 */
function makeClientError(
  status: number,
  errors: ReadonlyArray<{ message: string }> = [],
  requestHeaders?: Record<string, string>,
  requestBody?: string,
): ClientError {
  return new ClientError(
    {
      status,
      headers: new Headers(),
      body: '',
      errors: errors as any,
    } as any,
    {
      query: requestBody ?? '',
      // graphql-request types don't include headers on GraphQLRequestContext,
      // but the runtime tolerates extra fields. Cast to any to attach.
      ...(requestHeaders ? { headers: requestHeaders } : {}),
    } as any,
  );
}

describe('mapToActionError — HTTP status mapping', () => {
  it('401 → authentication failed + verify token hint', () => {
    const err = makeClientError(401);
    const action = mapToActionError(err, 'updateImage');
    expect(action).toBeInstanceOf(ActionError);
    expect(action.message.toLowerCase()).toContain('authentication failed');
    expect(action.hint).toBeDefined();
    expect(action.hint!.toLowerCase()).toContain('verify your railway_api_token');
  });

  it('403 → forbidden', () => {
    const action = mapToActionError(makeClientError(403), 'updateImage');
    expect(action.message.toLowerCase()).toContain('forbidden');
  });

  it('404 → resource not found / endpoint not found', () => {
    const action = mapToActionError(makeClientError(404), 'updateImage');
    expect(action.message.toLowerCase()).toMatch(/not found/);
  });

  it('400 → bad request; details mention HTTP 400', () => {
    const action = mapToActionError(makeClientError(400), 'updateImage');
    expect(action.message.toLowerCase()).toMatch(/invalid|bad request/);
    expect(action.details ?? '').toMatch(/400/);
  });

  it('429 → rate limit', () => {
    const action = mapToActionError(makeClientError(429), 'updateImage');
    expect(action.message.toLowerCase()).toContain('rate limit');
  });

  it.each([500, 502, 503, 504])('%i → server unavailable', (status) => {
    const action = mapToActionError(makeClientError(status), 'updateImage');
    expect(action.message.toLowerCase()).toMatch(/unavailable|server/);
  });

  it('unmapped status (e.g. 418) → generic HTTP failure message', () => {
    const action = mapToActionError(makeClientError(418), 'updateImage');
    expect(action.message).toMatch(/HTTP 418/);
  });
});

describe('mapToActionError — GraphQL errors[] hints', () => {
  it('errors[] containing "not found" → verify IDs hint', () => {
    const err = makeClientError(200, [{ message: 'Service not found in project' }]);
    const action = mapToActionError(err, 'updateImage');
    expect(action.hint!.toLowerCase()).toMatch(
      /verify the service id and environment id|verify the service id, environment id/,
    );
  });

  it('errors[] containing "permission" → token access hint', () => {
    const err = makeClientError(200, [{ message: 'no permission for this resource' }]);
    const action = mapToActionError(err, 'updateImage');
    expect(action.hint!.toLowerCase()).toContain('access to this project');
  });

  it('errors[] containing "invalid" → input format hint', () => {
    const err = makeClientError(200, [{ message: 'invalid input on field foo' }]);
    const action = mapToActionError(err, 'updateImage');
    expect(action.hint!.toLowerCase()).toMatch(/well-formed|input/);
  });

  it('errors[] otherwise → generic Railway dashboard hint', () => {
    const err = makeClientError(200, [{ message: 'something else went wrong' }]);
    const action = mapToActionError(err, 'updateImage');
    expect(action.hint!.toLowerCase()).toContain('railway dashboard');
  });

  it('errors[] details concatenates all messages, never request body', () => {
    const err = makeClientError(
      200,
      [{ message: 'first error' }, { message: 'second error' }],
      { Authorization: 'Bearer should-not-appear-in-output' },
      'PRIVATE_BODY_SHOULD_NOT_APPEAR',
    );
    const action = mapToActionError(err, 'updateImage');
    expect(action.details).toContain('first error');
    expect(action.details).toContain('second error');
    expect(action.details).not.toContain('PRIVATE_BODY_SHOULD_NOT_APPEAR');
    expect(action.details).not.toContain('should-not-appear-in-output');
    expect(action.message).not.toContain('should-not-appear-in-output');
  });
});

describe('mapToActionError — security: never leak token / body / headers', () => {
  const FAKE_TOKEN = 'sk-railway-secret-abc123-XYZ';

  it('never includes Authorization bearer token in details or message', () => {
    const err = makeClientError(
      401,
      [],
      { Authorization: `Bearer ${FAKE_TOKEN}` },
      'mutation { secretQuery(token: "REQUEST_BODY_LEAK") }',
    );
    const action = mapToActionError(err, 'updateImage');

    expect(action.details ?? '').not.toContain(FAKE_TOKEN);
    expect(action.details ?? '').not.toContain('Bearer ');
    expect(action.details ?? '').not.toContain('REQUEST_BODY_LEAK');

    expect(action.message).not.toContain(FAKE_TOKEN);
    expect(action.message).not.toContain('Bearer ');
    expect(action.message).not.toContain('REQUEST_BODY_LEAK');
  });

  it('does not include Project-Access-Token value either', () => {
    const err = makeClientError(403, [], { 'Project-Access-Token': FAKE_TOKEN }, '');
    const action = mapToActionError(err, 'updateImage');
    expect(action.details ?? '').not.toContain(FAKE_TOKEN);
    expect(action.message).not.toContain(FAKE_TOKEN);
  });
});

describe('mapToActionError — AbortError unwrapping', () => {
  it('unwraps p-retry AbortError(ClientError) and maps the inner ClientError', () => {
    const inner = makeClientError(401);
    const wrapped = new AbortError(inner);
    const action = mapToActionError(wrapped, 'updateImage');
    expect(action.message.toLowerCase()).toContain('authentication failed');
  });

  it('unwraps nested AbortError → ClientError 404 → resource not found', () => {
    const inner = makeClientError(404);
    const wrapped = new AbortError(inner);
    const action = mapToActionError(wrapped, 'updateImage');
    expect(action.message.toLowerCase()).toContain('not found');
  });
});

describe('mapToActionError — network errors (post-retry exhaustion)', () => {
  it('network error with code ENOTFOUND → request failed, details mention code', () => {
    const err = Object.assign(new Error('dns failure'), { code: 'ENOTFOUND' });
    const action = mapToActionError(err, 'updateImage');
    expect(action.message).toContain('Railway API request failed');
    expect(action.details).toBe('ENOTFOUND');
    // Should never embed full message or any URL-like text.
    expect(action.details).not.toContain('https://');
    expect(action.details).not.toContain('Bearer');
  });

  it('network error with cause.code surfaces the cause code', () => {
    const err = new Error('outer');
    (err as any).cause = { code: 'ECONNREFUSED' };
    const action = mapToActionError(err, 'updateImage');
    expect(action.details).toBe('ECONNREFUSED');
  });

  it('unknown error class with no code → generic fallback', () => {
    const err = new Error('something weird');
    const action = mapToActionError(err, 'updateImage');
    expect(action.message).toMatch(/Railway API request failed.*updateImage/);
    expect(action.details).toBe('something weird');
    expect(action.hint!.toLowerCase()).toContain('actions_step_debug');
  });

  it('non-Error throwable falls back to String(err)', () => {
    const action = mapToActionError('weird-string', 'updateImage');
    expect(action.message).toMatch(/updateImage/);
    expect(action.details).toBe('weird-string');
  });
});
