import * as core from '@actions/core';

import { ActionError } from '../errors';
import { sanitizeForLog } from '../log-sanitize';
import type { RegistryCredentials } from '../types';
import {
  DOCKER_LOGIN_TIMEOUT_MS,
  ExecTimeoutError,
  IMAGETOOLS_INSPECT_TIMEOUT_MS,
  runWithTimeout,
  type ExecFn,
} from './exec';

/**
 * Function-shaped seam for subprocess exec (re-exported from `./exec`). The
 * default is `runWithTimeout`; tests inject a fake. We deliberately do not
 * introduce a `DigestResolver` interface — the function with an injectable
 * `execFn` IS the testable seam.
 */
export type { ExecFn };

/**
 * The server string for Docker Hub, used for BOTH `docker login` and
 * `docker logout`. `docker login docker.io` stores credentials under this key,
 * but `docker logout docker.io` erases only `docker.io` variants — so the
 * credentials would outlive the post step. Using this string explicitly makes
 * login and logout hit the same key (and it is the key buildx reads).
 */
export const DOCKER_HUB_LOGIN_SERVER = 'https://index.docker.io/v1/';

/**
 * The ONLY derivation of a registry host from an image reference
 * (distribution/reference `splitDockerDomain`): the first path segment is a
 * host only if it contains `.` or `:` or is `localhost`; otherwise the image
 * is on Docker Hub. `docker.io` and `index.docker.io` also map to Docker Hub.
 */
export function registryHostFor(ref: string): string {
  const slash = ref.indexOf('/');
  if (slash === -1) return DOCKER_HUB_LOGIN_SERVER;
  const first = ref.slice(0, slash);
  if (!(first.includes('.') || first.includes(':') || first === 'localhost')) {
    return DOCKER_HUB_LOGIN_SERVER;
  }
  if (first === 'docker.io' || first === 'index.docker.io') return DOCKER_HUB_LOGIN_SERVER;
  return first;
}

export interface DigestResolveOptions {
  /** Optional pull credentials for private registries. */
  credentials?: RegistryCredentials;
  /**
   * Invoked before `docker login`; the post step will log out of this host.
   * Called before (not after) login because a login that is killed or fails
   * may still have written credentials, and logging out of a host never
   * logged in to is harmless.
   */
  onDockerLogin?: (registry: string) => void;
  /** When true, return a stub digest without invoking docker. */
  isDryRun?: boolean;
}

/** A content-addressed image digest, as written into the pinned ref. */
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Shape of the JSON returned by `docker buildx imagetools inspect --format '{{json .Manifest}}'`. */
interface ManifestJson {
  digest?: string;
}

/**
 * Resolve a (possibly tag-pinned) image reference to its manifest digest,
 * returning a `repo@sha256:…` reference. Ports the bash v0 `resolve_image_digest`
 * helper. If the input is already digest-pinned, returns it unchanged.
 */
export async function resolveImageDigest(
  ref: string,
  opts: DigestResolveOptions,
  execFn?: ExecFn,
): Promise<string> {
  // 1. Already digest-pinned → nothing to do.
  if (ref.includes('@sha256:')) {
    core.debug('resolve_image_digest: ref already digest-pinned, skipping');
    return ref;
  }

  // 2. Dry-run mode: emit the same `[DRY-RUN]` lines bash v0 produced and
  //    return a stub digest. Never invokes docker.
  if (opts.isDryRun) {
    core.info(`[DRY-RUN] Resolving manifest digest for: ${ref}`);
    const stubBase = ref.includes(':') ? ref.replace(/:[^/]+$/, '') : ref;
    const stub = `${stubBase}@sha256:dryrun`;
    core.info(`[DRY-RUN] Resolved to (stub): ${stub}`);
    return stub;
  }

  // 3. Live mode: announce the lookup. Note the leading two spaces and 🔍
  //    emoji — matches bash v0 byte-for-byte.
  core.info(`  🔍 Resolving manifest digest for: ${ref}`);

  const host = registryHostFor(ref);

  // Defense-in-depth against argv injection: even though IMAGE_REF_PATTERN
  // now rejects leading `-`, the derived host must also not start with one —
  // otherwise docker would consume it as a global flag (e.g. `--config`).
  if (host.startsWith('-') || ref.startsWith('-')) {
    throw new ActionError(
      'Refusing docker arguments that look like CLI flags',
      `registry='${host}', ref='${ref}'`,
      'Image reference must not start with a hyphen',
    );
  }

  const run: ExecFn = execFn ?? runWithTimeout;

  // 4. If credentials provided, `docker login` first via stdin to avoid
  //    leaking the password in `ps`/argv. The `--` separator after flags
  //    pins the host as the positional argument, so even if some future
  //    version of docker invents a new global flag with a similar name,
  //    we won't be fooled.
  if (opts.credentials) {
    const { username, password } = opts.credentials;
    // Record the logout host BEFORE login (see `onDockerLogin`).
    opts.onDockerLogin?.(host);
    core.info(`  🔐 Logging in to ${host}`);
    let loginResult;
    try {
      loginResult = await run('docker', ['login', '-u', username, '--password-stdin', '--', host], {
        input: Buffer.from(password),
        timeoutMs: DOCKER_LOGIN_TIMEOUT_MS,
      });
    } catch (err) {
      if (err instanceof ExecTimeoutError) {
        throw new ActionError(
          `Registry login timed out after ${DOCKER_LOGIN_TIMEOUT_MS / 1000}s`,
          `Registry: ${host}`,
          "The registry did not respond. Check the image host and the runner's network access to it.",
        );
      }
      throw err;
    }
    if (loginResult.exitCode !== 0) {
      throw new ActionError(
        'Registry login failed during digest resolution',
        `Registry: ${host}\nUsername: ${username}`,
        'Verify registry-username and registry-password are correct',
      );
    }
  }

  // 5. Inspect the manifest. `buildx imagetools inspect` is preferred over
  //    `docker manifest inspect` because it works with multi-arch indexes
  //    without `experimental` mode. `--` separator pins `ref` as positional.
  let inspect;
  try {
    inspect = await run(
      'docker',
      ['buildx', 'imagetools', 'inspect', '--format', '{{json .Manifest}}', '--', ref],
      { timeoutMs: IMAGETOOLS_INSPECT_TIMEOUT_MS },
    );
  } catch (err) {
    if (err instanceof ExecTimeoutError) {
      throw new ActionError(
        `Resolving the image digest timed out after ${IMAGETOOLS_INSPECT_TIMEOUT_MS / 1000}s`,
        `Image: ${ref}`,
        "The registry did not respond. Check the image host and the runner's network access to it.",
      );
    }
    throw err;
  }

  if (inspect.exitCode !== 0) {
    throw new ActionError(
      'Failed to resolve manifest digest for image',
      // sanitize stderr: a hostile registry could echo `::add-mask::...` and
      // since ActionError.details is emitted via core.info (raw stdout, no
      // escaping), an attacker-controlled error payload would inject workflow
      // commands. Replace `::` with the U+2236 ratio glyph and strip CR.
      `Image: ${ref}\nError: ${sanitizeForLog(inspect.stderr)}`,
      'Check that the image exists, is accessible, and registry credentials are correct',
    );
  }

  let parsed: ManifestJson;
  try {
    parsed = JSON.parse(inspect.stdout) as ManifestJson;
  } catch {
    // Intentionally no { cause } — Node's default unhandled-rejection
    // printer walks .cause chains; the underlying SyntaxError can include
    // unmasked stdout fragments. details already includes the stdout.
    throw new ActionError(
      'Failed to parse manifest JSON for image',
      `Image: ${ref}\nOutput: ${sanitizeForLog(inspect.stdout)}`,
      'Ensure the image tag exists and the registry returns a valid manifest',
    );
  }

  const digest = parsed.digest;
  if (!digest) {
    throw new ActionError(
      'Manifest digest resolution returned empty result',
      `Image: ${ref}\nReturned digest: (empty)`,
      'Ensure the image tag exists and the registry is reachable',
    );
  }

  if (typeof (digest as unknown) !== 'string' || !SHA256_DIGEST_PATTERN.test(digest)) {
    throw new ActionError(
      'Manifest digest resolution returned an invalid digest',
      `Image: ${ref}\nReturned digest: ${sanitizeForLog(String(digest)).slice(0, 200)}`,
      'Expected sha256:<64 lowercase hex>. Check the registry and the docker buildx version.',
    );
  }

  // 6. Build the digest-pinned ref. Only strip the tag if the LAST path
  //    segment contains a `:`, so registry ports remain intact.
  const lastSlash = ref.lastIndexOf('/');
  const lastSegment = lastSlash === -1 ? ref : ref.slice(lastSlash + 1);
  const base = lastSegment.includes(':') ? ref.replace(/:[^/]+$/, '') : ref;
  const resolved = `${base}@${digest}`;

  core.info(`  ✓ Resolved: ${resolved}`);
  return resolved;
}
