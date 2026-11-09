/**
 * Defang attacker-controlled output before it reaches `core.info` (raw
 * stdout, no escaping) or any other string the runner parses.
 *
 * The runner splits our stdout into lines on `\n`, a lone `\r`, or `\r\n`,
 * and tries two command parsers on each line:
 *   - V2: the line, after leading whitespace, starts with `::`
 *     (`::add-mask::x`, `::error::x`, ...)
 *   - legacy: the line contains `##[` ANYWHERE (`foo ##[add-mask]x`), followed
 *     by a registered command name
 * A payload from a hostile registry, a Railway build log or a Railway GraphQL
 * response could inject runner-level commands if logged raw.
 *
 * This function:
 *   1. strips every `\r` (a lone CR is a runner line break) — FIRST, so that
 *      stripping can't join `:\r:` into `::` or `#\r#[` into `##[`;
 *   2. replaces every `::` with the U+2236 ratio glyph, so no line starts with `::`;
 *   3. replaces every `##[` with `##［` (U+FF3B fullwidth bracket).
 * `\n` is kept, so multi-line details still read as multi-line. Idempotent.
 *
 * Applied at the two chokepoints — `emitToCore` (src/errors.ts) and the
 * Railway client's `ClientError` redaction (src/railway/client.ts) — and at a
 * few older call sites that embed raw output in `ActionError.details`.
 */
export function sanitizeForLog(s: string): string {
  return s.replace(/\r/g, '').replace(/::/g, '∶∶').replace(/##\[/g, '##［');
}

/** Replacement for a scrubbed secret. */
const SCRUBBED = '***';

/**
 * Replace each non-empty secret in `text` with `***`, in both its raw form and
 * its JSON-escaped form (`JSON.stringify(s).slice(1, -1)`, as graphql-js
 * renders string values in validation messages). Longer secrets are replaced
 * first so overlapping secrets are fully covered.
 *
 * Other encodings (URL, base64, truncation) are NOT covered; the runner's
 * mask is the second layer.
 */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  const unique = Array.from(new Set(secrets.filter((s) => s !== ''))).sort(
    (a, b) => b.length - a.length,
  );
  let out = text;
  for (const secret of unique) {
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) out = out.split(escaped).join(SCRUBBED);
    out = out.split(secret).join(SCRUBBED);
  }
  return out;
}
