/**
 * Image-reference mutability check. Ported from the bash v0 `is_mutable_ref`
 * helper. A reference is considered mutable when:
 *
 *   - it has no tag at all (Docker defaults to `:latest`), or
 *   - its tag is one of the well-known floating tags: latest, main, master,
 *     develop, stable.
 *
 * Digest-pinned references (containing `@sha256:`) are never mutable.
 *
 * The tag is extracted from the substring after the LAST `/` so that registry
 * ports (e.g. `localhost:5000/repo:tag`) do not get mistaken for the tag
 * delimiter.
 */

const MUTABLE_TAGS = new Set<string>(['latest', 'main', 'master', 'develop', 'stable']);

/**
 * Returns true if the image reference looks mutable. A ref is considered
 * mutable if it has no tag, or its tag is one of: latest, main, master,
 * develop, stable. Digest-pinned refs (containing '@sha256:') are never mutable.
 */
export function isMutableRef(ref: string): boolean {
  // 1. Digest-pinned refs are always immutable.
  if (ref.includes('@sha256:')) {
    return false;
  }

  // 2. Strip registry/path prefix — only the substring after the LAST `/`
  //    can contain the tag delimiter. This avoids matching registry ports
  //    like `localhost:5000/`.
  const lastSlash = ref.lastIndexOf('/');
  const lastSegment = lastSlash === -1 ? ref : ref.slice(lastSlash + 1);

  // 3. If the last segment contains `:`, the tag is the part after the
  //    last `:`. Otherwise the ref is tagless.
  const lastColon = lastSegment.lastIndexOf(':');
  if (lastColon === -1) {
    // Tagless ref → defaults to `:latest` at pull time → mutable.
    return true;
  }

  const tag = lastSegment.slice(lastColon + 1);
  return MUTABLE_TAGS.has(tag);
}
