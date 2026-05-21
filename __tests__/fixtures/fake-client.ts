/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RailwayClient } from '../../src/railway/client';

/**
 * Recorded request data for assertion in tests.
 */
export interface RecordedCall {
  document: string;
  variables: unknown;
  operationName: string | undefined;
}

/**
 * Canned response entry. Either resolve with `response` or reject with `error`.
 * Resolution takes precedence when both are provided.
 */
export interface CannedResponse {
  response?: unknown;
  error?: unknown;
}

/**
 * Test double for `RailwayClient`. Records each `request()` call and returns
 * canned responses keyed by either operation name (preferred) or document
 * substring fallback.
 *
 * Enforces Design Principle 4 — `operations.ts` must drive Railway calls
 * strictly sequentially. Any overlapping `request()` invocation throws.
 */
export class FakeRailwayClient implements RailwayClient {
  /** Recorded calls in invocation order. */
  public readonly calls: RecordedCall[] = [];

  /**
   * Map of `operationName` (or document substring fallback) → CannedResponse.
   * Configure via `setResponse()` per test.
   */
  public readonly responses: Map<string, CannedResponse> = new Map();

  /** Concurrency guard — number of in-flight requests. */
  private inFlight = 0;

  /** Default response used when no key matches; undefined means throw. */
  private defaultResponse: CannedResponse | undefined;

  /**
   * Configure a canned response for a given key. Key is matched against the
   * `operationName` opt first, then against any substring of the GraphQL
   * document string.
   */
  setResponse(key: string, canned: CannedResponse): void {
    this.responses.set(key, canned);
  }

  /** Configure a fallback used when no keyed response matches. */
  setDefaultResponse(canned: CannedResponse): void {
    this.defaultResponse = canned;
  }

  async request<TVars, TResult>(
    document: string,
    variables: TVars,
    opts?: { signal?: AbortSignal; operationName?: string },
  ): Promise<TResult> {
    if (this.inFlight > 0) {
      throw new Error(
        'FakeRailwayClient: concurrent request() detected — sequential iteration invariant violated',
      );
    }
    this.inFlight += 1;
    try {
      this.calls.push({
        document,
        variables,
        operationName: opts?.operationName,
      });

      // Yield a microtask so that any synchronously-issued second call can
      // observe `inFlight > 0` and trigger the concurrency guard. Without
      // this `await`, the async body would run to completion before the
      // caller has a chance to fire a second `request()`.
      await Promise.resolve();

      const canned = this.lookup(document, opts?.operationName);
      if (!canned) {
        throw new Error(
          `FakeRailwayClient: no canned response configured for operation=${
            opts?.operationName ?? '(none)'
          }`,
        );
      }
      if (canned.error !== undefined) {
        throw canned.error;
      }
      return canned.response as TResult;
    } finally {
      this.inFlight -= 1;
    }
  }

  private lookup(document: string, operationName: string | undefined): CannedResponse | undefined {
    if (operationName && this.responses.has(operationName)) {
      return this.responses.get(operationName);
    }
    for (const [key, value] of this.responses.entries()) {
      if (document.includes(key)) return value;
    }
    return this.defaultResponse;
  }
}
