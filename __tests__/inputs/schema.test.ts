import {
  ActionInputsSchema,
  parseServicesString,
  zodErrorToActionError,
} from '../../src/inputs/schema';
import * as core from '@actions/core';

import { ActionError, emitToCore } from '../../src/errors';
import { expectNoWorkflowCommands } from '../fixtures/log-assert';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  error: vi.fn(),
  notice: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
  summary: {
    addHeading: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    addQuote: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  },
}));

// Real UUIDs used across fixtures.
const ENV_UUID = '550e8400-e29b-41d4-a716-446655440000';
const WEB_UUID = '550e8400-e29b-41d4-a716-446655440001';
const WORKER_UUID = '550e8400-e29b-41d4-a716-446655440002';
const ZETA_UUID = '550e8400-e29b-41d4-a716-446655440003';
const ALPHA_UUID = '550e8400-e29b-41d4-a716-446655440004';
const MID_UUID = '550e8400-e29b-41d4-a716-446655440005';

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

  it('throws ActionError on an empty label (`:<uuid>` line)', () => {
    try {
      parseServicesString(`:${WEB_UUID}`);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as ActionError).message).toBe('services line has an empty label');
    }
  });

  it('throws ActionError on non-UUID service id, message includes the label', () => {
    try {
      parseServicesString('web:not-a-uuid');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as ActionError).message).toBe(
        "services: service ID for 'web' is not a valid UUID",
      );
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
    expect(result.data.resolveToDigest).toBe(true);
    expect(result.data.allowMutableTag).toBe(false);
  });

  it('defaults dryRun to false when omitted, and keeps an explicit true', () => {
    const omitted = ActionInputsSchema.safeParse(makeRawInputs());
    expect(omitted.success && omitted.data.dryRun).toBe(false);
    const on = ActionInputsSchema.safeParse(makeRawInputs({ dryRun: true }));
    expect(on.success && on.data.dryRun).toBe(true);
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

describe('zodErrorToActionError — action-input-name messages', () => {
  function mapError(rawInputs: Record<string, unknown>): ActionError {
    const result = ActionInputsSchema.safeParse(rawInputs);
    if (result.success) {
      throw new Error('expected schema to fail; this test fixture is invalid');
    }
    return zodErrorToActionError(result.error);
  }

  it('missing api-token → "api-token is required"', () => {
    const err = mapError(makeRawInputs({ apiToken: '' }));
    expect(err.message).toBe('api-token is required');
  });

  it('missing environment-id → "environment-id must be a UUID"', () => {
    // zod's regex check fires (empty string doesn't match UUID regex).
    const err = mapError(makeRawInputs({ environmentId: '' }));
    expect(err.message).toBe('environment-id must be a UUID');
  });

  it('missing image → "image is not a valid Docker image reference"', () => {
    const err = mapError(makeRawInputs({ image: '' }));
    expect(err.message).toBe('image is not a valid Docker image reference');
  });

  it('missing services → "services is required"', () => {
    const err = mapError(makeRawInputs({ services: '' }));
    expect(err.message).toBe('services is required');
  });

  it('invalid environment-id → "environment-id must be a UUID"', () => {
    const err = mapError(makeRawInputs({ environmentId: 'not-a-uuid' }));
    expect(err.message).toBe('environment-id must be a UUID');
  });

  it('invalid image regex → "image is not a valid Docker image reference"', () => {
    const err = mapError(makeRawInputs({ image: 'NOT VALID IMAGE!' }));
    expect(err.message).toBe('image is not a valid Docker image reference');
  });

  it('registry-username without password → custom-refine message', () => {
    const err = mapError(makeRawInputs({ registryUsername: 'user', registryPassword: '' }));
    expect(err.message).toBe('registry-username provided without registry-password');
  });

  it('registry-password without username → custom-refine message', () => {
    const err = mapError(makeRawInputs({ registryUsername: '', registryPassword: 'pw' }));
    expect(err.message).toBe('registry-password provided without registry-username');
  });

  it('first-service not in services list → custom-refine message', () => {
    const err = mapError(makeRawInputs({ firstService: 'ghost' }));
    expect(err.message).toBe("first-service 'ghost' not found in services list");
  });

  it('invalid service UUID → ActionError propagated from parseServicesString .transform()', () => {
    // `.transform(parseServicesString)` throws synchronously when a service id
    // fails the UUID check. zod's safeParse does NOT catch thrown non-ZodErrors
    // — the throw propagates to the caller.
    try {
      ActionInputsSchema.safeParse(makeRawInputs({ services: 'web:not-a-uuid' }));
      throw new Error('expected safeParse to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as ActionError).message).toBe(
        "services: service ID for 'web' is not a valid UUID",
      );
    }
  });

  it('missing services with a first-service set → "services is required", not a TypeError', () => {
    const err = mapError(makeRawInputs({ services: '', firstService: 'web' }));
    expect(err.message).toBe('services is required');
    expect(err.details).toBeUndefined();
  });

  it('multiple issues → all listed in details', () => {
    const err = mapError(makeRawInputs({ apiToken: '', environmentId: '' }));
    // First issue surfaces as headline; both appear in details.
    expect(err.message).toBe('api-token is required');
    expect(err.details).toContain('api-token is required');
    expect(err.details).toContain('environment-id must be a UUID');
  });
});

describe('injection hardening — first-service, labels, registry-username', () => {
  const DIRTY_FIRST = 'x\n::add-mask::PWNED';

  it('a forbidden first-service yields exactly one issue that does not echo the value', () => {
    const result = ActionInputsSchema.safeParse(makeRawInputs({ firstService: DIRTY_FIRST }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toHaveLength(1);
    for (const issue of result.error.issues) {
      expect(issue.message).not.toContain('PWNED');
    }
  });

  it('a forbidden first-service, end to end through emitToCore, prints no workflow command', async () => {
    const result = ActionInputsSchema.safeParse(makeRawInputs({ firstService: DIRTY_FIRST }));
    expect(result.success).toBe(false);
    if (result.success) return;
    await emitToCore(zodErrorToActionError(result.error));
    expectNoWorkflowCommands(vi.mocked(core.info).mock.calls.flat());
    expectNoWorkflowCommands(vi.mocked(core.summary.addRaw).mock.calls.flat());
  });

  it.each([
    ['embedded CR + legacy command', `web\r##[add-mask]PWNED:${WEB_UUID}`],
    ['comma', `a,b:${WEB_UUID}`],
    ['open bracket', `we[b:${WEB_UUID}`],
    ['close bracket', `we]b:${WEB_UUID}`],
    ['control char', `we\u0007b:${WEB_UUID}`],
    ['U+2028', `we\u2028b:${WEB_UUID}`],
    ['U+2029', `we\u2029b:${WEB_UUID}`],
  ])('rejects a label with %s', (_name, input) => {
    expect(() => parseServicesString(input)).toThrow(ActionError);
    expect(() => parseServicesString(input)).toThrow(
      'services: label contains forbidden characters',
    );
  });

  it('rejects a label that appears more than once (no silent overwrite)', () => {
    const input = `web:${WEB_UUID}\nworker:${WORKER_UUID}\n web :${WORKER_UUID}`;
    expect(() => parseServicesString(input)).toThrow(ActionError);
    expect(() => parseServicesString(input)).toThrow(
      "services: label 'web' appears more than once",
    );
  });

  it('checks forbidden characters before duplicates, so an unsafe label is never echoed', () => {
    const input = `a,b:${WEB_UUID}\na,b:${WORKER_UUID}`;
    expect(() => parseServicesString(input)).toThrow(
      'services: label contains forbidden characters',
    );
  });

  it('rejects a service ID that appears more than once (same service deployed twice)', () => {
    const input = `web:${WEB_UUID}\nworker:${WEB_UUID}`;
    expect(() => parseServicesString(input)).toThrow(ActionError);
    expect(() => parseServicesString(input)).toThrow(
      `services: service ID '${WEB_UUID}' appears more than once`,
    );
  });

  it('treats service IDs that differ only in letter case as duplicates', () => {
    const upper = '550E8400-E29B-41D4-A716-4466554400AA';
    const input = `web:${upper.toLowerCase()}\nworker:${upper}`;
    expect(() => parseServicesString(input)).toThrow(
      `services: service ID '${upper}' appears more than once`,
    );
  });

  it('validates the UUID before the duplicate check, so a non-UUID is never echoed as an ID', () => {
    const input = `web:not-a-uuid\nworker:not-a-uuid`;
    expect(() => parseServicesString(input)).toThrow(
      "services: service ID for 'web' is not a valid UUID",
    );
  });

  it('still accepts labels with spaces and dashes', () => {
    const map = parseServicesString(`web app:${WEB_UUID}\napi-v2:${WORKER_UUID}`);
    expect(Array.from(map.keys())).toEqual(['web app', 'api-v2']);
  });

  it('rejects a first-service with a bracket or comma (same rule as labels)', () => {
    for (const firstService of ['we[b', 'a,b', 'x\u2028y']) {
      const result = ActionInputsSchema.safeParse(makeRawInputs({ firstService }));
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]!.message).toBe('first-service contains forbidden characters');
    }
  });

  it('rejects a registry-username containing ##[ and accepts org+robot', () => {
    const bad = ActionInputsSchema.safeParse(
      makeRawInputs({ registryUsername: 'u##[add-mask]x', registryPassword: 'p' }),
    );
    expect(bad.success).toBe(false);
    const good = ActionInputsSchema.safeParse(
      makeRawInputs({ registryUsername: 'org+robot', registryPassword: 'p' }),
    );
    expect(good.success).toBe(true);
  });
});

/**
 * Pins for the zod 3 → 4 migration. Written green on zod 3; they must stay
 * green on zod 4. The never-echo pin (forbidden first-service) may never be relaxed.
 */
describe('zod major-upgrade pins', () => {
  function issuesOf(rawInputs: Record<string, unknown>): string[] {
    const result = ActionInputsSchema.safeParse(rawInputs);
    if (result.success) throw new Error('expected schema to fail; this test fixture is invalid');
    return result.error.issues.map((i) => i.message);
  }

  it('an invalid token-type has exactly the custom headline', () => {
    const result = ActionInputsSchema.safeParse(makeRawInputs({ tokenType: 'nope' }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(zodErrorToActionError(result.error).message).toBe(
      "token-type must be 'bearer' or 'project'",
    );
  });

  it('omitted optional inputs take their defaults', () => {
    const raw = makeRawInputs();
    for (const key of [
      'tokenType',
      'firstService',
      'registryUsername',
      'registryPassword',
      'resolveToDigest',
      'allowMutableTag',
      'dryRun',
    ]) {
      delete raw[key];
    }
    const result = ActionInputsSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.tokenType).toBe('bearer');
    expect(result.data.firstService).toBe('');
    expect(result.data.registryUsername).toBe('');
    expect(result.data.registryPassword).toBe('');
    expect(result.data.resolveToDigest).toBe(true);
    expect(result.data.allowMutableTag).toBe(false);
    expect(result.data.dryRun).toBe(false);
  });

  it('an ActionError thrown by the services transform propagates out of safeParse', () => {
    expect(() =>
      ActionInputsSchema.safeParse(makeRawInputs({ services: 'web:not-a-uuid' })),
    ).toThrow(ActionError);
    expect(() =>
      ActionInputsSchema.safeParse(makeRawInputs({ services: 'web:not-a-uuid' })),
    ).toThrow(/not a valid UUID/);
  });

  it('the object-level credential-pair refinement runs when no field issue exists', () => {
    expect(issuesOf(makeRawInputs({ registryUsername: 'u', registryPassword: '' }))).toEqual([
      'registry-username provided without registry-password',
    ]);
  });

  it('a forbidden first-service is never echoed, even alongside the refinements', () => {
    const raw = 'evil%0A::warning::x';
    const messages = issuesOf(makeRawInputs({ firstService: raw }));
    expect(messages).toContain('first-service contains forbidden characters');
    for (const message of messages) {
      expect(message).not.toContain(raw);
      expect(message).not.toContain('evil');
    }
  });

  it('a field issue is the headline when an unknown first-service is also present', () => {
    const result = ActionInputsSchema.safeParse(
      makeRawInputs({ apiToken: 'a\nb', firstService: 'ghost' }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(zodErrorToActionError(result.error).message).toBe(
      'api-token contains forbidden characters',
    );
  });
});
