/**
 * `ActionError` / `emitToCore` against the REAL `@actions/core` (summary
 * rendering and the `$GITHUB_STEP_SUMMARY` file are what is under test).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as core from '@actions/core';

import { ActionError, emitToCore } from '../src/errors';

let tmpDir: string;
let savedSummaryEnv: string | undefined;

beforeEach(() => {
  // `core.summary` is a process singleton that caches the summary file path
  // on first use (private `_filePath`) and buffers until a successful write.
  // Reset both so each test sees its own GITHUB_STEP_SUMMARY.
  (core.summary as unknown as { _filePath?: string })._filePath = undefined;
  core.summary.emptyBuffer();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emit-to-core-'));
  savedSummaryEnv = process.env.GITHUB_STEP_SUMMARY;
  // Silence the real core's `::error::` / `::notice::` stdout lines.
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  if (savedSummaryEnv === undefined) delete process.env.GITHUB_STEP_SUMMARY;
  else process.env.GITHUB_STEP_SUMMARY = savedSummaryEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ActionError', () => {
  it('carries no cause, even if a caller passes one (it could print unredacted text)', () => {
    const Ctor = ActionError as unknown as new (...args: unknown[]) => Error;
    const err = new Ctor('msg', 'details', 'hint', { cause: new Error('secret-cause') });
    expect(err.cause).toBeUndefined();
    expect(err.message).toBe('msg');
  });
});

describe('emitToCore — job summary', () => {
  it('renders details HTML-escaped inside <pre>, so a code fence or tag stays literal', async () => {
    const summaryFile = path.join(tmpDir, 'summary.md');
    fs.writeFileSync(summaryFile, '');
    process.env.GITHUB_STEP_SUMMARY = summaryFile;

    await emitToCore(
      new ActionError('Boom', 'line one\n```\n# injected heading\n<script>alert(1)</script> & "q"'),
    );

    const written = fs.readFileSync(summaryFile, 'utf8');
    expect(written).toContain(
      '<pre>line one\n```\n# injected heading\n&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;</pre>',
    );
    expect(written).not.toContain('<script>');
  });

  it('HTML-escapes the summary heading and hint too (a label can carry < >)', async () => {
    const summaryFile = path.join(tmpDir, 'summary.md');
    fs.writeFileSync(summaryFile, '');
    process.env.GITHUB_STEP_SUMMARY = summaryFile;

    await emitToCore(
      new ActionError(
        'Railway GraphQL error during: deployService:web<img src=x>',
        undefined,
        'Check <b>web<img src=x></b>',
      ),
    );

    const written = fs.readFileSync(summaryFile, 'utf8');
    expect(written).toContain(
      '<h3>Railway GraphQL error during: deployService:web&lt;img src=x&gt;</h3>',
    );
    expect(written).toContain('Check &lt;b&gt;web&lt;img src=x&gt;&lt;/b&gt;');
    expect(written).not.toContain('<img');
    expect(written).not.toContain('<b>');
  });

  it('resolves when GITHUB_STEP_SUMMARY is unset, logging a debug line instead', async () => {
    delete process.env.GITHUB_STEP_SUMMARY;
    const debug = vi.spyOn(core, 'debug');

    await expect(emitToCore(new ActionError('Boom', 'details'))).resolves.toBeUndefined();

    expect(debug).toHaveBeenCalledWith(expect.stringContaining('job summary'));
    // The unwritten summary must not leak into the next write.
    expect(core.summary.stringify()).toBe('');
  });
});
