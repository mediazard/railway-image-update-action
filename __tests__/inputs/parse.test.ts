import { ActionError } from '../../src/errors';

// Mock `@actions/core` with explicit named exports. Vitest's `clearMocks`
// + `restoreMocks` (set in vitest.config.ts) reset call history between
// tests; we re-stub `getInput` / `getBooleanInput` per test as needed.
vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  setSecret: vi.fn(),
}));

// Imported after the mock declaration. Both modules share the same mocked
// `@actions/core` instance.
import * as core from '@actions/core';
import { readInputs, readRawFromCore } from '../../src/inputs/parse';

// Real UUIDs.
const ENV_UUID = '550e8400-e29b-41d4-a716-446655440000';
const WEB_UUID = '550e8400-e29b-41d4-a716-446655440001';
const WORKER_UUID = '550e8400-e29b-41d4-a716-446655440002';

const API_TOKEN = 'super-secret-token-abc';
const REG_PASSWORD = 'super-secret-pw-xyz';
const REG_USERNAME = 'registry-user';

interface InputsBundle {
  'api-token': string;
  'token-type': string;
  'environment-id': string;
  image: string;
  services: string;
  'first-service': string;
  'wait-seconds': string;
  'registry-username': string;
  'registry-password': string;
}

interface BooleanBundle {
  'resolve-to-digest': boolean;
  'allow-mutable-tag': boolean;
}

/**
 * Wire the mock `core.getInput` / `core.getBooleanInput` to return values
 * keyed by input name. Unknown keys fall back to the empty string / `false`.
 */
function installCoreMocks(
  strings: Partial<InputsBundle>,
  booleans: Partial<BooleanBundle> = {},
): void {
  const stringDefaults: InputsBundle = {
    'api-token': API_TOKEN,
    'token-type': 'bearer',
    'environment-id': ENV_UUID,
    image: 'ghcr.io/org/app:1.0.0',
    services: `web:${WEB_UUID}\nworker:${WORKER_UUID}`,
    'first-service': '',
    'wait-seconds': '30',
    'registry-username': '',
    'registry-password': '',
  };
  const booleanDefaults: BooleanBundle = {
    'resolve-to-digest': true,
    'allow-mutable-tag': false,
  };

  const mergedStrings: InputsBundle = { ...stringDefaults, ...strings };
  const mergedBooleans: BooleanBundle = { ...booleanDefaults, ...booleans };

  vi.mocked(core.getInput).mockImplementation((name: string): string => {
    if (name in mergedStrings) {
      return mergedStrings[name as keyof InputsBundle];
    }
    return '';
  });

  vi.mocked(core.getBooleanInput).mockImplementation((name: string): boolean => {
    if (name in mergedBooleans) {
      return mergedBooleans[name as keyof BooleanBundle];
    }
    return false;
  });
}

describe('readInputs — happy path', () => {
  it('returns a parsed ActionInputs matching the expected shape', () => {
    installCoreMocks({});

    const inputs = readInputs();

    expect(inputs.apiToken).toBe(API_TOKEN);
    expect(inputs.tokenType).toBe('bearer');
    expect(inputs.environmentId).toBe(ENV_UUID);
    expect(inputs.image).toBe('ghcr.io/org/app:1.0.0');
    expect(inputs.services).toBeInstanceOf(Map);
    expect(Array.from(inputs.services.keys())).toEqual(['web', 'worker']);
    expect(inputs.services.get('web')).toBe(WEB_UUID);
    expect(inputs.services.get('worker')).toBe(WORKER_UUID);
    expect(inputs.firstService).toBe('');
    expect(inputs.waitSeconds).toBe(30);
    expect(inputs.registryUsername).toBe('');
    expect(inputs.registryPassword).toBe('');
    expect(inputs.resolveToDigest).toBe(true);
    expect(inputs.allowMutableTag).toBe(false);
  });
});

describe('readRawFromCore — secret masking (Design Principle 5)', () => {
  it('calls core.setSecret for api-token AND registry-password, but NOT for registry-username', () => {
    installCoreMocks({
      'registry-username': REG_USERNAME,
      'registry-password': REG_PASSWORD,
    });

    readRawFromCore();

    expect(core.setSecret).toHaveBeenCalledWith(API_TOKEN);
    expect(core.setSecret).toHaveBeenCalledWith(REG_PASSWORD);
    // Crucial v0-parity assertion: usernames must never be registered as secrets.
    expect(core.setSecret).not.toHaveBeenCalledWith(REG_USERNAME);
    // Belt-and-braces: only two setSecret calls happened.
    expect(core.setSecret).toHaveBeenCalledTimes(2);
  });

  it('skips setSecret when api-token is empty', () => {
    installCoreMocks({ 'api-token': '' });

    readRawFromCore();

    expect(core.setSecret).not.toHaveBeenCalled();
  });

  it('skips setSecret for registry-password when empty', () => {
    installCoreMocks({});

    readRawFromCore();

    // Only api-token is registered; registry-password defaults to ''.
    expect(core.setSecret).toHaveBeenCalledTimes(1);
    expect(core.setSecret).toHaveBeenCalledWith(API_TOKEN);
  });

  it('uses core.getBooleanInput for resolve-to-digest and allow-mutable-tag (NOT core.getInput)', () => {
    installCoreMocks({});

    readRawFromCore();

    expect(core.getBooleanInput).toHaveBeenCalledWith('resolve-to-digest');
    expect(core.getBooleanInput).toHaveBeenCalledWith('allow-mutable-tag');

    // Spot-check that the string inputs went through getInput (not getBooleanInput).
    const stringCalls = vi.mocked(core.getInput).mock.calls.map((c) => c[0]);
    expect(stringCalls).toContain('api-token');
    expect(stringCalls).toContain('registry-username');
    expect(stringCalls).not.toContain('resolve-to-digest');
    expect(stringCalls).not.toContain('allow-mutable-tag');
  });
});

describe('readInputs — masking happens BEFORE schema validation', () => {
  it('still calls setSecret(api-token) even when schema validation fails later (bad image)', () => {
    installCoreMocks({ image: 'NOT VALID IMAGE!' });

    expect(() => readInputs()).toThrowError(ActionError);

    // The load-bearing ordering invariant: api-token was masked during
    // readRawFromCore, BEFORE the schema rejected the bad image.
    expect(core.setSecret).toHaveBeenCalledWith(API_TOKEN);
  });

  it('throws ActionError (not a raw ZodError) on validation failure', () => {
    installCoreMocks({ image: 'NOT VALID IMAGE!' });

    try {
      readInputs();
      throw new Error('expected readInputs to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      // The mapped v0-stable message:
      expect((err as ActionError).message).toBe('image tag has an invalid format');
    }
  });

  it('throws ActionError mapping missing api-token to "RAILWAY_API_TOKEN is not set"', () => {
    installCoreMocks({ 'api-token': '' });

    try {
      readInputs();
      throw new Error('expected readInputs to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as ActionError).message).toBe('RAILWAY_API_TOKEN is not set');
    }
  });
});
