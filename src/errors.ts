import * as core from '@actions/core';

import { sanitizeForLog } from './log-sanitize';

/**
 * Action-level error carrying a human-friendly message, optional detail block,
 * and a hint. Mirrors the bash `die "msg" "details" "hint"` triplet.
 *
 * Throw this anywhere; the entry point catches it once and emits via emitToCore.
 */
export class ActionError extends Error {
  public readonly details?: string;
  public readonly hint?: string;

  // Deliberately no `cause` option: Node's unhandled-rejection printer walks
  // `.cause` chains and could print an unredacted underlying error.
  constructor(message: string, details?: string, hint?: string) {
    super(message);
    this.name = 'ActionError';
    this.details = details;
    this.hint = hint;
  }
}

/**
 * Emit an ActionError through the GitHub Actions runtime annotations and write
 * a summary block. The summary is async — callers MUST await this, otherwise
 * the summary is dropped when `process.exitCode = 1` ends the run.
 *
 * Single source of error annotations: do NOT also call `core.setFailed` after
 * this — `setFailed` re-emits `::error::` and would double-log.
 */
export async function emitToCore(err: ActionError): Promise<void> {
  // Chokepoint B: everything an ActionError carries passes through
  // sanitizeForLog once. `core.info` writes raw stdout, so details are the
  // channel that matters; message/hint go through escaped commands but are
  // sanitized too so the summary matches.
  const message = sanitizeForLog(err.message);
  const details = err.details ? sanitizeForLog(err.details) : undefined;
  const hint = err.hint ? sanitizeForLog(err.hint) : undefined;

  core.error(message);

  if (details) {
    core.startGroup('Details');
    core.info(details);
    core.endGroup();
  }

  if (hint) {
    core.notice(hint, { title: 'Hint' });
  }

  // Everything in the summary is HTML-escaped: core.summary inserts text
  // into HTML verbatim, and message/hint can carry a label (which may hold
  // `<` / `>`) or Railway text.
  core.summary.addHeading(escapeHtml(message), 3);
  if (details) {
    // Escaped inside <pre>, not a ``` fence: details carry untrusted text
    // (Railway, docker), and a fence in it would end the block and let the
    // rest render as markdown/HTML.
    core.summary.addRaw('\n<pre>' + escapeHtml(details) + '</pre>\n');
  }
  if (hint) {
    core.summary.addQuote('💡 ' + escapeHtml(hint));
  }

  // The summary is best-effort: with no GITHUB_STEP_SUMMARY (some self-hosted
  // or local runners) write() rejects, which must not replace the real error
  // or skip the caller's exit code.
  try {
    await core.summary.write();
  } catch (writeErr) {
    core.summary.emptyBuffer();
    core.debug(
      `Could not write the job summary: ${sanitizeForLog(writeErr instanceof Error ? writeErr.message : String(writeErr))}`,
    );
  }
}

/** Escape text for literal display inside HTML (the job summary). */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
