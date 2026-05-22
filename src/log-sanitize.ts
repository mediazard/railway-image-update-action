/**
 * Defang attacker-controlled output before embedding in `ActionError.details`
 * or any other string we hand to `core.info` / `core.error`. The GitHub
 * Actions runner parses lines starting with `::` as workflow commands
 * (`::add-mask::`, `::set-output::`, etc.), so a payload that originated
 * from a hostile registry, a Railway build log, or a Railway GraphQL
 * response could inject runner-level commands if we logged it raw.
 *
 * Used by:
 *   - src/image/digest.ts (docker login/manifest-inspect stderr+stdout)
 *   - src/railway/operations.ts (Railway buildLogs entries; raw response
 *     fragments in deployment-status error details)
 *   - src/run.ts (raw response fragment in the "deployment-id unavailable"
 *     warning)
 *
 * Replace any `::` with the U+2236 ratio glyph and drop CRs.
 */
export function sanitizeForLog(s: string): string {
  return s.replace(/::/g, '∶∶').replace(/\r/g, '');
}
