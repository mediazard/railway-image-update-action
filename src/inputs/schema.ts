import { z, type ZodError } from 'zod';

import { ActionError } from '../errors';

/** UUID pattern used for both `environmentId` and every per-service ID. */
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
 * Does NOT accept `localhost:5000/...` port forms.
 */
export const IMAGE_REF_PATTERN = /^[a-z0-9][a-z0-9._/-]*(:[a-zA-Z0-9._-]+|@sha256:[0-9a-f]{64})?$/;

/**
 * Inputs that may end up in `ActionError.details` (which is logged via
 * core.info → raw stdout) MUST reject control chars + `%`. Otherwise an
 * attacker who controls the input can inject GitHub Actions workflow
 * commands (`::add-mask::secret`, `::error::...`) into the log stream.
 */
const NO_WORKFLOW_COMMAND_CHARS = /^[^\r\n%]*$/;

/**
 * Parse the multiline `services` input into a `Map<label, serviceId>`.
 *
 * - Split on `\n`; strip trailing `\r` (CRLF tolerance).
 * - Skip empty lines (after trimming).
 * - For each line, split on the FIRST `:`, trim both sides.
 * - Empty label or non-UUID service id → throws `ActionError`.
 * - Map insertion order is the public contract for deploy order — never sort.
 */
export function parseServicesString(input: string): Map<string, string> {
  const result = new Map<string, string>();

  for (const rawLine of input.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === '') continue;

    const colonIdx = line.indexOf(':');
    const label = (colonIdx === -1 ? line : line.slice(0, colonIdx)).trim();
    const serviceId = (colonIdx === -1 ? '' : line.slice(colonIdx + 1)).trim();

    if (label === '') {
      throw new ActionError(
        'services line has an empty label',
        `Offending line: '${rawLine}'`,
        "Each services line must be 'label:service_id' with a non-empty label.",
      );
    }

    if (!UUID_PATTERN.test(serviceId)) {
      throw new ActionError(
        `services: service ID for '${label}' is not a valid UUID`,
        `Got: '${serviceId}'`,
        'Use the Railway service UUID, e.g. 1234abcd-12ab-34cd-56ef-1234567890ab.',
      );
    }

    result.set(label, serviceId);
  }

  return result;
}

/** Both registry credentials must be present, or both absent. */
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
 * Zod schema for all 11 action inputs. Per-field `.message` strings carry
 * action-input-name phrasing so a `safeParse` failure surfaces a
 * user-readable error without any external mapping layer.
 */
export const ActionInputsSchema = z
  .object({
    apiToken: z
      .string()
      .min(1, 'api-token is required')
      .regex(NO_WORKFLOW_COMMAND_CHARS, 'api-token contains forbidden characters'),
    tokenType: z
      .enum(['bearer', 'project'], {
        errorMap: () => ({ message: "token-type must be 'bearer' or 'project'" }),
      })
      .default('bearer'),
    environmentId: z.string().regex(UUID_PATTERN, 'environment-id must be a UUID'),
    image: z.string().regex(IMAGE_REF_PATTERN, 'image is not a valid Docker image reference'),
    services: z.string().min(1, 'services is required').transform(parseServicesString),
    firstService: z
      .string()
      .regex(NO_WORKFLOW_COMMAND_CHARS, 'first-service contains forbidden characters')
      .default(''),
    waitSeconds: z.coerce
      .number({ invalid_type_error: 'wait-seconds must be a non-negative integer' })
      .int('wait-seconds must be a non-negative integer')
      .nonnegative('wait-seconds must be a non-negative integer')
      .max(900, 'wait-seconds must not exceed 900 (15 min)')
      .default(30),
    registryUsername: z
      .string()
      .regex(NO_WORKFLOW_COMMAND_CHARS, 'registry-username contains forbidden characters')
      .default(''),
    registryPassword: z.string().default(''),
    resolveToDigest: z.boolean().default(true),
    allowMutableTag: z.boolean().default(false),
  })
  .superRefine(refineCredentialPair)
  .superRefine(refineFirstServiceExists);

/** Strongly-typed inputs after parse + transform. */
export type ActionInputs = z.infer<typeof ActionInputsSchema>;

/**
 * Convert a `ZodError` to an `ActionError`. Every zod issue in the schema
 * carries a user-readable `.message` already, so this packager just surfaces
 * the first one as the headline and lists all of them in `details`.
 */
export function zodErrorToActionError(err: ZodError): ActionError {
  const messages = err.issues.map((i) => i.message);
  const headline = messages[0] ?? 'Invalid action input';
  const details = messages.length > 1 ? messages.map((m) => `- ${m}`).join('\n') : undefined;
  return new ActionError(headline, details);
}
