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
    for (const piece of String(line).split(/\r\n|\r|\n/)) {
      if (piece.trimStart().startsWith('::') || piece.includes('##[')) {
        throw new Error(`workflow command would be parsed from log line: ${JSON.stringify(piece)}`);
      }
    }
  }
}
