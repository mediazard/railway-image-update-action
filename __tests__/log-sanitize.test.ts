import { scrubSecrets, sanitizeForLog } from '../src/log-sanitize';
import { expectNoWorkflowCommands } from './fixtures/log-assert';

describe('sanitizeForLog', () => {
  it('neutralises the legacy ##[ command form anywhere in a line', () => {
    const out = sanitizeForLog('a ##[add-mask]x');
    expect(out).not.toContain('##[');
    expectNoWorkflowCommands([out]);
  });

  it('strips CR and replaces :: (V2 command form)', () => {
    const out = sanitizeForLog('x\r::y');
    expect(out).not.toContain('\r');
    expect(out).not.toContain('::');
  });

  it('keeps \\n so multi-line details stay multi-line', () => {
    expect(sanitizeForLog('a\nb')).toBe('a\nb');
  });

  it('is idempotent', () => {
    for (const s of ['a ##[add-mask]x', 'x\r::y', ':\r:a:::b', '#\r#[x', 'plain']) {
      expect(sanitizeForLog(sanitizeForLog(s))).toBe(sanitizeForLog(s));
    }
  });

  it('cannot create a command by stripping CR between the marker characters', () => {
    for (const s of [':\r:add-mask:\r:x', '#\r#[add-mask]x']) {
      const out = sanitizeForLog(s);
      expect(out).not.toContain('::');
      expect(out).not.toContain('##[');
      expectNoWorkflowCommands([out]);
    }
  });
});

describe('scrubSecrets', () => {
  it('replaces the raw and the JSON-escaped form of each secret', () => {
    const secret = 'pa"ss\\word-SECRET';
    const text = `got { password: "pa\\"ss\\\\word-SECRET" } and raw ${secret}`;
    const out = scrubSecrets(text, [secret]);
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain(secret);
    expect(out).toContain('***');
  });

  it('ignores empty secrets', () => {
    expect(scrubSecrets('abc', [''])).toBe('abc');
  });

  it('replaces longer secrets first so overlapping secrets are fully covered', () => {
    expect(scrubSecrets('x abcdef y', ['abc', 'abcdef'])).toBe('x *** y');
  });
});
