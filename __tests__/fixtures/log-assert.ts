/**
 * Assert that no string, once split the way the GitHub Actions runner splits
 * child stdout (`\n`, lone `\r`, or `\r\n`), would be parsed as a workflow
 * command by either of the runner's parsers:
 *   - V2: a line that starts with `::` after leading whitespace
 *   - legacy: a line that contains `##[` anywhere
 *
 * Mirrors the runner's rules, not our own sanitizer.
 */
export function expectNoWorkflowCommands(lines: readonly unknown[]): void {
  for (const line of lines) {
    const piece = findWorkflowCommandLine(String(line));
    if (piece !== undefined) {
      throw new Error(`workflow command would be parsed from log line: ${JSON.stringify(piece)}`);
    }
  }
}

/** True if any runner-split line of `text` would parse as a workflow command. */
export function hasWorkflowCommand(text: string): boolean {
  return findWorkflowCommandLine(text) !== undefined;
}

function findWorkflowCommandLine(text: string): string | undefined {
  return text
    .split(/\r\n|\r|\n/)
    .find((piece) => piece.trimStart().startsWith('::') || piece.includes('##['));
}
