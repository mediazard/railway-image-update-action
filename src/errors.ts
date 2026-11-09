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

  constructor(message: string, details?: string, hint?: string, options?: { cause?: unknown }) {
    super(message, options);
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

  core.summary.addHeading(message, 3);
  if (details) {
    core.summary.addRaw('\n```\n' + details + '\n```\n');
  }
  if (hint) {
    core.summary.addQuote('💡 ' + hint);
  }

  await core.summary.write();
}
