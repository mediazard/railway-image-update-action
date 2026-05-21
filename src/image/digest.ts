import * as core from '@actions/core';
import * as exec from '@actions/exec';

import { ActionError } from '../errors';
import type { RegistryCredentials } from '../types';

/**
 * Function-shaped seam for subprocess exec. The default is `exec.getExecOutput`
 * from `@actions/exec`; tests inject a fake. We deliberately do not introduce
 * a `DigestResolver` interface — the function with an injectable `execFn` IS
 * the testable seam.
 */
export type ExecFn = typeof exec.getExecOutput;

export interface DigestResolveOptions {
  /** Registry hostname for `docker login` (derived in caller as `ref.split('/')[0]`). */
  registry: string;
  /** Optional pull credentials for private registries. */
  credentials?: RegistryCredentials;
  /**
   * Hook so the caller can record state for post-step cleanup (e.g.
   * `core.saveState('dockerLogoutRegistry', registry)`). Invoked only on
   * successful `docker login`.
   */
  onDockerLogin?: (registry: string) => void;
  /** When true, return a stub digest without invoking docker. */
  isDryRun?: boolean;
}

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

  // Defense-in-depth against argv injection: even though IMAGE_REF_PATTERN
  // now rejects leading `-`, the derived `registry` segment must also not
  // start with one — otherwise docker would consume it as a global flag
  // (e.g. `--config`, `--host`).
  if (opts.registry.startsWith('-') || ref.startsWith('-')) {
    throw new ActionError(
      'Refusing docker arguments that look like CLI flags',
      `registry='${opts.registry}', ref='${ref}'`,
      'Image reference must not start with a hyphen',
    );
  }

  const run: ExecFn = execFn ?? exec.getExecOutput;

  // 4. If credentials provided, `docker login` first via stdin to avoid
  //    leaking the password in `ps`/argv. The `--` separator after flags
  //    pins `registry` as the positional argument, so even if some future
  //    version of docker invents a new global flag with a similar name,
  //    we won't be fooled.
  if (opts.credentials) {
    const { username, password } = opts.credentials;
    const loginResult = await run(
      'docker',
      ['login', '-u', username, '--password-stdin', '--', opts.registry],
      {
        input: Buffer.from(password),
        silent: true,
        ignoreReturnCode: true,
      },
    );
    if (loginResult.exitCode !== 0) {
      throw new ActionError(
        'Registry login failed during digest resolution',
        `Registry: ${opts.registry}\nUsername: ${username}`,
        'Verify registry-username and registry-password are correct',
      );
    }
    opts.onDockerLogin?.(opts.registry);
  }

  // 5. Inspect the manifest. `buildx imagetools inspect` is preferred over
  //    `docker manifest inspect` because it works with multi-arch indexes
  //    without `experimental` mode. `--` separator pins `ref` as positional.
  const inspect = await run(
    'docker',
    ['buildx', 'imagetools', 'inspect', '--format', '{{json .Manifest}}', '--', ref],
    { silent: true, ignoreReturnCode: true },
  );

  if (inspect.exitCode !== 0) {
    throw new ActionError(
      'Failed to resolve manifest digest for image',
      `Image: ${ref}\nError: ${inspect.stderr}`,
      'Check that the image exists, is accessible, and registry credentials are correct',
    );
  }

  let parsed: ManifestJson;
  try {
    parsed = JSON.parse(inspect.stdout) as ManifestJson;
  } catch (cause) {
    throw new ActionError(
      'Failed to parse manifest JSON for image',
      `Image: ${ref}\nOutput: ${inspect.stdout}`,
      'Ensure the image tag exists and the registry returns a valid manifest',
      { cause },
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

  // 6. Build the digest-pinned ref. Only strip the tag if the LAST path
  //    segment contains a `:`, so registry ports remain intact.
  const lastSlash = ref.lastIndexOf('/');
  const lastSegment = lastSlash === -1 ? ref : ref.slice(lastSlash + 1);
  const base = lastSegment.includes(':') ? ref.replace(/:[^/]+$/, '') : ref;
  const resolved = `${base}@${digest}`;

  core.info(`  ✓ Resolved: ${resolved}`);
  return resolved;
}
