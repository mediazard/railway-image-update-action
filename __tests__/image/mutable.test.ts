import { isMutableRef } from '../../src/image/mutable';

describe('isMutableRef', () => {
  describe('mutable refs', () => {
    it('treats tagless ref as mutable (defaults to :latest)', () => {
      expect(isMutableRef('ghcr.io/org/app')).toBe(true);
    });

    it('treats :latest as mutable', () => {
      expect(isMutableRef('ghcr.io/org/app:latest')).toBe(true);
    });

    it('treats :main as mutable', () => {
      expect(isMutableRef('ghcr.io/org/app:main')).toBe(true);
    });

    it('treats :master as mutable', () => {
      expect(isMutableRef('ghcr.io/org/app:master')).toBe(true);
    });

    it('treats :develop as mutable', () => {
      expect(isMutableRef('ghcr.io/org/app:develop')).toBe(true);
    });

    it('treats :stable as mutable', () => {
      expect(isMutableRef('ghcr.io/org/app:stable')).toBe(true);
    });
  });

  describe('immutable refs', () => {
    it('treats semver tag as immutable', () => {
      expect(isMutableRef('ghcr.io/org/app:v1.2.3')).toBe(false);
    });

    it('treats sha-prefixed tag as immutable', () => {
      expect(isMutableRef('ghcr.io/org/app:sha-abc123')).toBe(false);
    });

    it('treats date-build tag as immutable', () => {
      expect(isMutableRef('ghcr.io/org/app:20240101-1')).toBe(false);
    });

    it('treats digest-pinned ref as immutable', () => {
      expect(
        isMutableRef(
          'ghcr.io/org/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        ),
      ).toBe(false);
    });
  });

  describe('registry port handling', () => {
    it('treats localhost:5000/org/app:latest as mutable (tag is latest, not 5000)', () => {
      expect(isMutableRef('localhost:5000/org/app:latest')).toBe(true);
    });

    it('treats localhost:5000/org/app (tagless) as mutable', () => {
      expect(isMutableRef('localhost:5000/org/app')).toBe(true);
    });

    it('treats localhost:5000/org/app:v1 as immutable', () => {
      expect(isMutableRef('localhost:5000/org/app:v1')).toBe(false);
    });
  });

  describe('digest takes precedence', () => {
    it('treats digest-pinned ref containing :latest substring as immutable', () => {
      // Digest pins win even if other parts of the ref include 'latest'.
      expect(
        isMutableRef(
          'ghcr.io/org/app:latest@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        ),
      ).toBe(false);
    });
  });
});
