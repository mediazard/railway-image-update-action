/**
 * Drift guard: the inputs/outputs tables in README.md and CLAUDE.md are
 * hand-written copies of action.yml. They must list the same names, in the
 * same order, with the same required flags (and, in the README, defaults).
 *
 * action.yml is parsed with a small line-based parser (no YAML dependency).
 * It throws on shapes it does not understand, so parser drift fails the test
 * instead of passing it vacuously.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (file: string): string => readFileSync(resolve(__dirname, '../..', file), 'utf8');

interface ActionInput {
  name: string;
  required: boolean;
  default: string | undefined;
}

interface ActionYml {
  inputs: ActionInput[];
  outputs: string[];
}

const KEY_LINE = /^ {2}([a-z0-9-]+):\s*$/;

/** Lines of a top-level section (`inputs:`), up to the next column-0 key. */
function sectionLines(lines: string[], name: string): string[] {
  const start = lines.findIndex((l) => l === `${name}:`);
  if (start === -1) throw new Error(`action.yml has no top-level "${name}:" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^[^\s#]/.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Group a section's lines by their two-space key. */
function groupByKey(lines: string[], section: string): Array<{ name: string; body: string[] }> {
  const groups: Array<{ name: string; body: string[] }> = [];
  for (const line of lines) {
    const key = KEY_LINE.exec(line);
    if (key) {
      groups.push({ name: key[1], body: [] });
    } else if (line.trim() !== '') {
      const current = groups.at(-1);
      if (!current) throw new Error(`action.yml ${section}: unexpected line "${line}"`);
      current.body.push(line);
    }
  }
  if (groups.length === 0) throw new Error(`action.yml ${section}: no keys found`);
  return groups;
}

function parseActionYml(text: string): ActionYml {
  const lines = text.replace(/\r/g, '').split('\n');

  const inputs = groupByKey(sectionLines(lines, 'inputs'), 'inputs').map(({ name, body }) => {
    const required = body
      .map((l) => /^ {4}required: (true|false)$/.exec(l))
      .find((m) => m !== null);
    if (!required) throw new Error(`action.yml input "${name}" has no required: line`);
    const def = body.map((l) => /^ {4}default: "(.*)"$/.exec(l)).find((m) => m !== null);
    return { name, required: required[1] === 'true', default: def ? def[1] : undefined };
  });

  const outputs = groupByKey(sectionLines(lines, 'outputs'), 'outputs').map((g) => g.name);

  return { inputs, outputs };
}

/** Lines under `## heading`, up to the next heading of level 1 or 2. */
function markdownSection(text: string, heading: string): string[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) throw new Error(`no "## ${heading}" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2} /.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Table rows whose first cell is a backticked name, as trimmed cells. */
function parseMarkdownTable(text: string, heading: string): string[][] {
  const rows = markdownSection(text, heading)
    .filter((l) => l.trim().startsWith('|'))
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim()),
    )
    .filter((cells) => /^`[^`]+`$/.test(cells[0]));
  if (rows.length === 0) throw new Error(`no table rows under "## ${heading}"`);
  return rows;
}

/** Bullet names (``- `name` — ``) under `## heading`. */
function parseMarkdownBullets(text: string, heading: string): string[] {
  const names = markdownSection(text, heading)
    .map((l) => /^- `([^`]+)` —/.exec(l))
    .filter((m) => m !== null)
    .map((m) => m[1]);
  if (names.length === 0) throw new Error(`no bullets under "## ${heading}"`);
  return names;
}

const unquote = (cell: string): string => cell.replace(/^`(.*)`$/, '$1');

/** README Default cell → action.yml default (`—` = absent, `""` = empty). */
function normaliseDefault(cell: string): string | undefined {
  const value = unquote(cell);
  if (value === '—') return undefined;
  if (value === '""') return '';
  return value;
}

const requiredCell = (required: boolean): string => (required ? 'Yes' : 'No');

describe('parseActionYml', () => {
  it('throws when an input has no required: line', () => {
    const yml = ['inputs:', '  a:', '    description: "x"', 'outputs:', '  b:', ''].join('\n');
    expect(() => parseActionYml(yml)).toThrow('input "a" has no required: line');
  });

  it('throws when a section has no keys', () => {
    const yml = ['inputs:', 'outputs:', '  b:', ''].join('\n');
    expect(() => parseActionYml(yml)).toThrow('inputs: no keys found');
  });

  it('reads the real action.yml', () => {
    const { inputs, outputs } = parseActionYml(read('action.yml'));
    expect(inputs.find((i) => i.name === 'api-token')).toEqual({
      name: 'api-token',
      required: true,
      default: undefined,
    });
    expect(inputs.find((i) => i.name === 'token-type')?.default).toBe('bearer');
    expect(outputs).toContain('deployment-ids');
  });
});

describe('README.md matches action.yml', () => {
  const action = parseActionYml(read('action.yml'));
  const readme = read('README.md');

  it('lists the same inputs in the same order', () => {
    const rows = parseMarkdownTable(readme, 'Inputs');
    expect(rows.map((r) => unquote(r[0]))).toEqual(action.inputs.map((i) => i.name));
  });

  it('has the same Required column', () => {
    const rows = parseMarkdownTable(readme, 'Inputs');
    expect(rows.map((r) => [unquote(r[0]), r[1]])).toEqual(
      action.inputs.map((i) => [i.name, requiredCell(i.required)]),
    );
  });

  it('has the same Default column', () => {
    const rows = parseMarkdownTable(readme, 'Inputs');
    expect(rows.map((r) => [unquote(r[0]), normaliseDefault(r[2])])).toEqual(
      action.inputs.map((i) => [i.name, i.default]),
    );
  });

  it('lists the same outputs in the same order', () => {
    const rows = parseMarkdownTable(readme, 'Outputs');
    expect(rows.map((r) => unquote(r[0]))).toEqual(action.outputs);
  });
});

describe('CLAUDE.md matches action.yml', () => {
  const action = parseActionYml(read('action.yml'));
  const claude = read('CLAUDE.md');

  it('lists the same inputs, in order, with the same Required column', () => {
    const rows = parseMarkdownTable(claude, 'Inputs');
    expect(rows.map((r) => [unquote(r[0]), r[1]])).toEqual(
      action.inputs.map((i) => [i.name, requiredCell(i.required)]),
    );
  });

  it('lists the same outputs in the same order', () => {
    expect(parseMarkdownBullets(claude, 'Outputs')).toEqual(action.outputs);
  });
});

describe('LICENSE', () => {
  it('is the MIT license held by mediazard', () => {
    const path = resolve(__dirname, '../..', 'LICENSE');
    expect(existsSync(path)).toBe(true);
    const text = read('LICENSE');
    expect(text.startsWith('MIT License')).toBe(true);
    expect(text).toContain('Copyright (c) 2026 mediazard');
  });
});
