import {
  ActionInputsSchema,
  parseServicesString,
  zodErrorToActionError,
  type RawInputsView,
} from '../../src/inputs/schema';
import { ActionError } from '../../src/errors';

// Real UUIDs used across fixtures.
const ENV_UUID = '550e8400-e29b-41d4-a716-446655440000';
const WEB_UUID = '550e8400-e29b-41d4-a716-446655440001';
const WORKER_UUID = '550e8400-e29b-41d4-a716-446655440002';
const ZETA_UUID = '550e8400-e29b-41d4-a716-446655440003';
const ALPHA_UUID = '550e8400-e29b-41d4-a716-446655440004';
const MID_UUID = '550e8400-e29b-41d4-a716-446655440005';

/**
 * Build a complete `RawInputsView` for use with `zodErrorToActionError`.
 * Override fields per-test.
 */
function makeRawView(overrides: Partial<RawInputsView> = {}): RawInputsView {
  return {
    apiToken: 'token-abc',
    tokenType: 'bearer',
    environmentId: ENV_UUID,
    image: 'ghcr.io/org/app:1.0.0',
    services: `web:${WEB_UUID}\nworker:${WORKER_UUID}`,
    firstService: '',
    waitSeconds: '30',
    registryUsername: '',
    registryPassword: '',
    resolveToDigest: true,
    allowMutableTag: false,
    ...overrides,
  };
}

/**
 * Build a complete raw input record suitable for `ActionInputsSchema.safeParse`.
 * The booleans are typed because zod's schema uses `z.boolean()`.
 */
function makeRawInputs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiToken: 'token-abc',
    tokenType: 'bearer',
    environmentId: ENV_UUID,
    image: 'ghcr.io/org/app:1.0.0',
    services: `web:${WEB_UUID}\nworker:${WORKER_UUID}`,
    firstService: '',
    waitSeconds: '30',
    registryUsername: '',
    registryPassword: '',
    resolveToDigest: true,
    allowMutableTag: false,
    ...overrides,
  };
}

describe('parseServicesString', () => {
  it('parses a happy-path two-service input into a Map with insertion order', () => {
    const map = parseServicesString(`web:${WEB_UUID}\nworker:${WORKER_UUID}`);
    expect(map.size).toBe(2);
    expect(Array.from(map.keys())).toEqual(['web', 'worker']);
    expect(map.get('web')).toBe(WEB_UUID);
    expect(map.get('worker')).toBe(WORKER_UUID);
  });

  it('preserves insertion order even when labels would sort differently (zeta/alpha/mid)', () => {
    const input = `zeta:${ZETA_UUID}\nalpha:${ALPHA_UUID}\nmid:${MID_UUID}`;
    const map = parseServicesString(input);
    expect(Array.from(map.keys())).toEqual(['zeta', 'alpha', 'mid']);
  });

  it('tolerates CRLF line endings identically to LF', () => {
    const lf = parseServicesString(`web:${WEB_UUID}\nworker:${WORKER_UUID}`);
    const crlf = parseServicesString(`web:${WEB_UUID}\r\nworker:${WORKER_UUID}`);
    expect(Array.from(crlf.entries())).toEqual(Array.from(lf.entries()));
  });

  it('trims whitespace around labels and IDs', () => {
    const map = parseServicesString(`  web  :  ${WEB_UUID}  \n\tworker\t:\t${WORKER_UUID}\t`);
    expect(map.get('web')).toBe(WEB_UUID);
    expect(map.get('worker')).toBe(WORKER_UUID);
  });

  it('skips empty (and whitespace-only) lines', () => {
    const map = parseServicesString(`\nweb:${WEB_UUID}\n   \n\nworker:${WORKER_UUID}\n\r\n`);
    expect(Array.from(map.keys())).toEqual(['web', 'worker']);
  });

  it('throws ActionError("Service label is empty") on `:<uuid>` line', () => {
    expect(() => parseServicesString(`:${WEB_UUID}`)).toThrowError(ActionError);
    try {
      parseServicesString(`:${WEB_UUID}`);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as ActionError).message).toBe('Service label is empty');
    }
  });

  it('throws ActionError on non-UUID service id, message includes the label', () => {
    try {
      parseServicesString('web:not-a-uuid');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as ActionError).message).toBe('Service ID for [web] is not a valid UUID');
    }
  });
});

describe('ActionInputsSchema — happy path and refines', () => {
  it('parses a full valid input bundle and produces a typed Map of services', () => {
    const result = ActionInputsSchema.safeParse(makeRawInputs());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.apiToken).toBe('token-abc');
    expect(result.data.tokenType).toBe('bearer');
    expect(result.data.environmentId).toBe(ENV_UUID);
    expect(result.data.image).toBe('ghcr.io/org/app:1.0.0');
    expect(result.data.services).toBeInstanceOf(Map);
    expect(Array.from(result.data.services.keys())).toEqual(['web', 'worker']);
    expect(result.data.waitSeconds).toBe(30);
    expect(result.data.resolveToDigest).toBe(true);
    expect(result.data.allowMutableTag).toBe(false);
  });

  describe('refineCredentialPair', () => {
    it('errors when registry-username is present without registry-password', () => {
      const result = ActionInputsSchema.safeParse(
        makeRawInputs({ registryUsername: 'user', registryPassword: '' }),
      );
      expect(result.success).toBe(false);
      if (result.success) return;
      const issue = result.error.issues.find((i) => i.path[0] === 'registryUsername');
      expect(issue?.message).toBe('registry-username provided without registry-password');
    });

    it('errors when registry-password is present without registry-username', () => {
      const result = ActionInputsSchema.safeParse(
        makeRawInputs({ registryUsername: '', registryPassword: 'pw' }),
      );
      expect(result.success).toBe(false);
      if (result.success) return;
      const issue = result.error.issues.find((i) => i.path[0] === 'registryPassword');
      expect(issue?.message).toBe('registry-password provided without registry-username');
    });

    it('accepts both credentials present', () => {
      const result = ActionInputsSchema.safeParse(
        makeRawInputs({ registryUsername: 'user', registryPassword: 'pw' }),
      );
      expect(result.success).toBe(true);
    });

    it('accepts neither credential present', () => {
      const result = ActionInputsSchema.safeParse(
        makeRawInputs({ registryUsername: '', registryPassword: '' }),
      );
      expect(result.success).toBe(true);
    });
  });

  describe('refineFirstServiceExists', () => {
    it('errors when first-service is not in the services Map', () => {
      const result = ActionInputsSchema.safeParse(makeRawInputs({ firstService: 'nope' }));
      expect(result.success).toBe(false);
      if (result.success) return;
      const issue = result.error.issues.find((i) => i.path[0] === 'firstService');
      expect(issue?.message).toBe("first-service 'nope' not found in services list");
    });

    it('accepts an empty first-service (means "no ordering")', () => {
      const result = ActionInputsSchema.safeParse(makeRawInputs({ firstService: '' }));
      expect(result.success).toBe(true);
    });

    it('accepts first-service when it is present in the services Map', () => {
      const result = ActionInputsSchema.safeParse(makeRawInputs({ firstService: 'worker' }));
      expect(result.success).toBe(true);
    });
  });
});

describe('zodErrorToActionError — v0-stable error strings (Appendix A)', () => {
  /**
   * Run the schema against `rawInputs`, expect failure, and map the resulting
   * ZodError back to an ActionError via `zodErrorToActionError`.
   */
  function mapError(
    rawInputs: Record<string, unknown>,
    rawView: Partial<RawInputsView> = {},
  ): ActionError {
    const result = ActionInputsSchema.safeParse(rawInputs);
    if (result.success) {
      throw new Error('expected schema to fail; this test fixture is invalid');
    }
    return zodErrorToActionError(result.error, makeRawView(rawView));
  }

  it('missing api-token → "RAILWAY_API_TOKEN is not set"', () => {
    const err = mapError(makeRawInputs({ apiToken: '' }), { apiToken: '' });
    expect(err.message).toBe('RAILWAY_API_TOKEN is not set');
  });

  it('missing environment-id → "RAILWAY_ENV_ID is not set"', () => {
    const err = mapError(makeRawInputs({ environmentId: '' }), {
      environmentId: '',
    });
    expect(err.message).toBe('RAILWAY_ENV_ID is not set');
  });

  it('missing image → "IMAGE_TAG is not set"', () => {
    const err = mapError(makeRawInputs({ image: '' }), { image: '' });
    expect(err.message).toBe('IMAGE_TAG is not set');
  });

  it('missing services → "SERVICES is not set"', () => {
    const err = mapError(makeRawInputs({ services: '' }), { services: '' });
    expect(err.message).toBe('SERVICES is not set');
  });

  it('invalid environment-id → "RAILWAY_ENV_ID is not a valid UUID"', () => {
    const err = mapError(makeRawInputs({ environmentId: 'not-a-uuid' }), {
      environmentId: 'not-a-uuid',
    });
    expect(err.message).toBe('RAILWAY_ENV_ID is not a valid UUID');
  });

  it('invalid image regex → "image tag has an invalid format"', () => {
    const err = mapError(makeRawInputs({ image: 'NOT VALID IMAGE!' }), {
      image: 'NOT VALID IMAGE!',
    });
    expect(err.message).toBe('image tag has an invalid format');
  });

  it('non-integer wait-seconds → "wait-seconds must be a non-negative integer"', () => {
    const err = mapError(makeRawInputs({ waitSeconds: 'abc' }), {
      waitSeconds: 'abc',
    });
    expect(err.message).toBe('wait-seconds must be a non-negative integer');
  });

  it('registry-username without password → stable message', () => {
    const err = mapError(makeRawInputs({ registryUsername: 'user', registryPassword: '' }), {
      registryUsername: 'user',
      registryPassword: '',
    });
    expect(err.message).toBe('registry-username provided without registry-password');
  });

  it('registry-password without username → stable message', () => {
    const err = mapError(makeRawInputs({ registryUsername: '', registryPassword: 'pw' }), {
      registryUsername: '',
      registryPassword: 'pw',
    });
    expect(err.message).toBe('registry-password provided without registry-username');
  });

  it('invalid service UUID → ActionError propagated from parseServicesString .transform()', () => {
    // The `.transform(parseServicesString)` throws synchronously when a
    // service id fails the UUID check. zod's safeParse does NOT catch
    // thrown non-ZodErrors — the throw propagates to the caller. That's
    // the v0-stable contract: a single ActionError with the preserved
    // string makes it back to `readInputs`.
    expect(() =>
      ActionInputsSchema.safeParse(makeRawInputs({ services: 'web:not-a-uuid' })),
    ).toThrowError(ActionError);

    try {
      ActionInputsSchema.safeParse(makeRawInputs({ services: 'web:not-a-uuid' }));
      throw new Error('expected safeParse to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as ActionError).message).toBe('Service ID for [web] is not a valid UUID');
    }
  });

  it('first-service not in services list → stable message', () => {
    const err = mapError(makeRawInputs({ firstService: 'ghost' }), {
      firstService: 'ghost',
    });
    expect(err.message).toBe("first-service 'ghost' not found in services list");
  });
});
