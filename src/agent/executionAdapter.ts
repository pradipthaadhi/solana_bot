/**
 * Stage 4.1 / 5 — execution boundary (swap + Phantom wiring lands in Stage 5).
 */

export interface ExecutionSignalPayload {
  barIndex: number;
  timeMs: number;
  reason: string;
}

export interface ExecutionAdapter {
  onSignalEntry(payload: ExecutionSignalPayload): void | Promise<void>;
  onSignalExit(payload: ExecutionSignalPayload): void | Promise<void>;
}

export class NoopExecutionAdapter implements ExecutionAdapter {
  onSignalEntry(): void {}

  onSignalExit(): void {}
}

export class CapturingExecutionAdapter implements ExecutionAdapter {
  public readonly entries: ExecutionSignalPayload[] = [];

  public readonly exits: ExecutionSignalPayload[] = [];

  onSignalEntry(payload: ExecutionSignalPayload): void {
    this.entries.push(payload);
  }

  onSignalExit(payload: ExecutionSignalPayload): void {
    this.exits.push(payload);
  }
}

/**
 * Wraps an adapter so each distinct `timeMs` fires at most once per kind across polls.
 * Bar index is intentionally omitted: it shifts when prepending history, which would
 * re-fire the same candle’s signal under a new key. Time (bar open/close) is stable.
 * Without this, `tail_bar_only` hooks can repeat the same historical `SIGNAL_*` on every poll.
 *
 * `scope` namespaces the dedupe key (e.g. a pool/pair address) for callers that reuse the same
 * `seen` Set across multiple logical instruments over its lifetime — without it, two different
 * pools whose 1m bars happen to share a wall-clock-aligned `timeMs` (routine, since OHLCV
 * timestamps are minute-aligned regardless of pool) would collide and silently swallow one of
 * them, with no row logged and no error, unlike every other skip path in this codebase. Omit it
 * (the default) for a caller that only ever drives one instrument per `seen` Set for its lifetime.
 */
export function createDedupingExecutionAdapter(
  inner: ExecutionAdapter,
  seen: Set<string> = new Set(),
  scope?: string,
): ExecutionAdapter {
  const prefix = scope !== undefined && scope.length > 0 ? `${scope}:` : "";
  const dedupe = (kind: "ENTRY" | "EXIT", payload: ExecutionSignalPayload): boolean => {
    const key = `${prefix}${kind}:${payload.timeMs}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  };
  return {
    onSignalEntry(payload) {
      if (!dedupe("ENTRY", payload)) {
        return;
      }
      return inner.onSignalEntry(payload);
    },
    onSignalExit(payload) {
      if (!dedupe("EXIT", payload)) {
        return;
      }
      return inner.onSignalExit(payload);
    },
  };
}
