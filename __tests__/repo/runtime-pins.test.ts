/**
 * Drift guard: the action runtime (`action.yml` `runs.using`), the local Node
 * pin (`.node-version` / `.nvmrc`) and `package.json` `engines.node` are
 * hand-synced. They must agree on one Node major, or CI breaks at `npm ci`
 * (`engine-strict`) or `dist/` is built on a different Node than it runs on.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const read = (file: string): string => readFileSync(join(root, file), 'utf8');

function runtimeMajor(): number {
  const match = /^\s+using:\s*"node(\d+)"\s*$/m.exec(read('action.yml'));
  if (!match) throw new Error('action.yml has no `using: "node<N>"` line');
  return Number(match[1]);
}

function pinnedVersion(): string {
  return read('.node-version').trim();
}

describe('runtime pins', () => {
  it('action.yml declares the node24 runtime', () => {
    expect(runtimeMajor()).toBe(24);
  });

  it('.node-version and .nvmrc pin the same exact version', () => {
    expect(pinnedVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(read('.nvmrc').trim()).toBe(pinnedVersion());
  });

  it('.node-version major matches the action runtime', () => {
    expect(Number(pinnedVersion().split('.')[0])).toBe(runtimeMajor());
  });

  it('engines.node is bounded to the runtime major', () => {
    const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
    const range = pkg.engines?.node ?? '';
    const match = /^>=(\d+)\.\d+\.\d+ <(\d+)$/.exec(range);
    if (!match) throw new Error(`unexpected engines.node range: "${range}"`);
    const major = runtimeMajor();
    expect(Number(match[1])).toBe(major);
    expect(Number(match[2])).toBe(major + 1);
  });
});
