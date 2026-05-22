import * as core from '@actions/core';

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
  core.error(err.message);

  if (err.details) {
    core.startGroup('Details');
    core.info(err.details);
    core.endGroup();
  }

  if (err.hint) {
    core.notice(err.hint, { title: 'Hint' });
  }

  core.summary.addHeading(err.message, 3);
  if (err.details) {
    core.summary.addRaw('\n```\n' + err.details + '\n```\n');
  }
  if (err.hint) {
    core.summary.addQuote('💡 ' + err.hint);
  }

  await core.summary.write();
}
