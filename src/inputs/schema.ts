import { z, type ZodError } from 'zod';

import { ActionError } from '../errors';

/**
 * UUID v4-ish pattern used for both `environmentId` and every per-service ID.
 * Byte-for-byte identical to the v0 bash regex (Appendix A).
 */
export const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Image reference: `registry/repo[:tag | @sha256:<hex>]`.
 *
 * Intentionally narrow:
 * - first character MUST be `[a-z0-9]` — prevents leading `-` (would otherwise
 *   match `--config/foo:bar` and slip through as a docker CLI flag downstream)
 * - body characters limited to `[a-z0-9._/-]`
 * - optional tag or sha256 digest suffix
 *
 * Does NOT accept `localhost:5000/...` port forms. CHANGELOG documents the
 * trade-off.
 */
export const IMAGE_REF_PATTERN = /^[a-z0-9][a-z0-9._/-]*(:[a-zA-Z0-9._-]+|@sha256:[0-9a-f]{64})?$/;

/**
 * Parse the multiline `services` input into a `Map<label, serviceId>`.
 *
 * Contract (Appendix A):
 *  - Split on `\n`; strip trailing `\r` (CRLF tolerance).
 *  - Skip empty lines (after trimming).
 *  - For each line split on the FIRST `:`, trim both sides.
 *  - Empty label → throws `ActionError("Service label is empty", ...)`.
 *  - Non-UUID service ID → throws
 *    `ActionError("Service ID for [<label>] is not a valid UUID", ...)`.
 *  - Map insertion order is the public contract for deploy order — never sort.
 */
export function parseServicesString(input: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = input.split('\n');

  for (const rawLine of lines) {
    // Strip trailing \r for CRLF tolerance.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === '') continue;

    const colonIdx = line.indexOf(':');
    const label = (colonIdx === -1 ? line : line.slice(0, colonIdx)).trim();
    const serviceId = (colonIdx === -1 ? '' : line.slice(colonIdx + 1)).trim();

    if (label === '') {
      throw new ActionError(
        'Service label is empty',
        `Offending line: '${rawLine}'`,
        "Each services line must be 'label:service_id' with a non-empty label.",
      );
    }

    if (!UUID_PATTERN.test(serviceId)) {
      throw new ActionError(
        `Service ID for [${label}] is not a valid UUID`,
        `Got: '${serviceId}'`,
        'Use the Railway service UUID, e.g. 1234abcd-12ab-34cd-56ef-1234567890ab.',
      );
    }

    result.set(label, serviceId);
  }

  return result;
}

/**
 * Both registry credentials must be present, or both absent. v0 parity.
 */
function refineCredentialPair(
  val: { registryUsername: string; registryPassword: string },
  ctx: z.RefinementCtx,
): void {
  const hasUser = val.registryUsername !== '';
  const hasPass = val.registryPassword !== '';
  if (hasUser && !hasPass) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['registryUsername'],
      message: 'registry-username provided without registry-password',
    });
  } else if (hasPass && !hasUser) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['registryPassword'],
      message: 'registry-password provided without registry-username',
    });
  }
}

/**
 * If `firstService` is non-empty, it must be a label present in the parsed
 * services Map. The error message intentionally includes the offending name.
 */
function refineFirstServiceExists(
  val: { firstService: string; services: Map<string, string> },
  ctx: z.RefinementCtx,
): void {
  if (val.firstService === '') return;
  if (!val.services.has(val.firstService)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['firstService'],
      message: `first-service '${val.firstService}' not found in services list`,
    });
  }
}

/**
 * Zod schema for all 11 action inputs. Booleans use `z.boolean()` because the
 * parse step uses `core.getBooleanInput` (Appendix D) which already throws on
 * invalid values per the GitHub Actions YAML 1.2 boolean spec.
 */
export const ActionInputsSchema = z
  .object({
    apiToken: z.string().min(1),
    tokenType: z.enum(['bearer', 'project']).default('bearer'),
    environmentId: z.string().regex(UUID_PATTERN),
    image: z.string().regex(IMAGE_REF_PATTERN),
    services: z.string().min(1).transform(parseServicesString),
    firstService: z.string().default(''),
    waitSeconds: z.coerce.number().int().nonnegative().default(30),
    registryUsername: z.string().default(''),
    registryPassword: z.string().default(''),
    resolveToDigest: z.boolean().default(true),
    allowMutableTag: z.boolean().default(false),
  })
  .superRefine(refineCredentialPair)
  .superRefine(refineFirstServiceExists);

/** Strongly-typed inputs after parse + transform. */
export type ActionInputs = z.infer<typeof ActionInputsSchema>;

/** Best-effort raw snapshot used by error mapping to surface offending values. */
export interface RawInputsView {
  apiToken: string;
  tokenType: string;
  environmentId: string;
  image: string;
  services: string;
  firstService: string;
  waitSeconds: string;
  registryUsername: string;
  registryPassword: string;
  resolveToDigest: boolean;
  allowMutableTag: boolean;
}

/**
 * Map a `ZodError` produced by `ActionInputsSchema.safeParse(raw)` back to the
 * v0-equivalent stable error messages from Appendix A.
 *
 * The mapping is keyed by `issue.path[0]` + `issue.code` so we can produce
 * messages that mention the v0 env-style names (`RAILWAY_API_TOKEN`) instead
 * of the new action input names (`api-token`) — preserving the existing user
 * mental model and any grep-based log assertions consumer scripts rely on.
 *
 * If a custom-issue message was set by one of our `.superRefine`s, that exact
 * message is used as-is (it's already v0-equivalent).
 *
 * On any unmapped issue we fall back to the zod-rendered message under a
 * generic `Invalid action input` header so we never silently swallow drift.
 */
export function zodErrorToActionError(err: ZodError, raw: RawInputsView): ActionError {
  // Custom issues (from our `.superRefine`s + `parseServicesString`) already
  // carry the v0-stable message; surface the first one.
  const customIssue = err.issues.find((i) => i.code === z.ZodIssueCode.custom);
  if (customIssue) {
    return new ActionError(
      customIssue.message,
      buildDetails(customIssue.path, raw),
      hintFor(customIssue.path),
    );
  }

  const issue = err.issues[0];
  if (!issue) {
    return new ActionError(
      'Invalid action input',
      'Zod reported no issues but parsing failed.',
      'Re-run with debug logging enabled.',
    );
  }

  const field = typeof issue.path[0] === 'string' ? issue.path[0] : '';

  switch (field) {
    case 'apiToken':
      return new ActionError(
        'RAILWAY_API_TOKEN is not set',
        'api-token input was empty.',
        "Add 'api-token: ${{ secrets.RAILWAY_API_TOKEN }}' to your workflow.",
      );

    case 'environmentId': {
      if (raw.environmentId === '') {
        return new ActionError(
          'RAILWAY_ENV_ID is not set',
          'environment-id input was empty.',
          "Add 'environment-id: <your-environment-uuid>' to your workflow.",
        );
      }
      return new ActionError(
        'RAILWAY_ENV_ID is not a valid UUID',
        `Got: '${raw.environmentId}'`,
        'Use the Railway environment UUID, e.g. 1234abcd-12ab-34cd-56ef-1234567890ab.',
      );
    }

    case 'image': {
      if (raw.image === '') {
        return new ActionError(
          'IMAGE_TAG is not set',
          'image input was empty.',
          "Add 'image: <registry>/<repo>:<tag>' to your workflow.",
        );
      }
      return new ActionError(
        'image tag has an invalid format',
        `Got: '${raw.image}'`,
        'Use a Docker image reference like ghcr.io/org/app:1.2.3 or ...@sha256:<hex>.',
      );
    }

    case 'services':
      return new ActionError(
        'SERVICES is not set',
        'services input was empty.',
        "Provide a multiline list of 'label:service_id' pairs in your workflow.",
      );

    case 'waitSeconds':
      return new ActionError(
        'wait-seconds must be a non-negative integer',
        `Got: '${raw.waitSeconds}'`,
        'Set wait-seconds to 0 or a positive integer (default: 30).',
      );

    case 'tokenType':
      return new ActionError(
        "token-type must be 'bearer' or 'project'",
        `Got: '${raw.tokenType}'`,
        "Set token-type: 'bearer' (default) or 'project'.",
      );

    case 'firstService':
      return new ActionError(
        `first-service '${raw.firstService}' not found in services list`,
        undefined,
        'Set first-service to one of the labels in your services input.',
      );

    case 'registryUsername':
      return new ActionError(
        'registry-username provided without registry-password',
        undefined,
        'Provide both registry-username and registry-password, or neither.',
      );

    case 'registryPassword':
      return new ActionError(
        'registry-password provided without registry-username',
        undefined,
        'Provide both registry-username and registry-password, or neither.',
      );

    default:
      return new ActionError(
        'Invalid action input',
        `${field || '(unknown)'}: ${issue.message}`,
        'Check the action inputs against the README.',
      );
  }
}

function buildDetails(path: ReadonlyArray<PropertyKey>, raw: RawInputsView): string | undefined {
  const field = typeof path[0] === 'string' ? path[0] : '';
  switch (field) {
    case 'registryUsername':
    case 'registryPassword':
      return undefined;
    case 'firstService':
      return `first-service='${raw.firstService}', services labels=${listLabels(raw.services)}`;
    default:
      return undefined;
  }
}

function hintFor(path: ReadonlyArray<PropertyKey>): string | undefined {
  const field = typeof path[0] === 'string' ? path[0] : '';
  switch (field) {
    case 'registryUsername':
    case 'registryPassword':
      return 'Provide both registry-username and registry-password, or neither.';
    case 'firstService':
      return 'Set first-service to one of the labels in your services input.';
    default:
      return undefined;
  }
}

function listLabels(servicesInput: string): string {
  const labels: string[] = [];
  for (const rawLine of servicesInput.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === '') continue;
    const colonIdx = line.indexOf(':');
    const label = (colonIdx === -1 ? line : line.slice(0, colonIdx)).trim();
    if (label !== '') labels.push(label);
  }
  return `[${labels.join(', ')}]`;
}
