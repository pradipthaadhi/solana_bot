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
 * Wraps an adapter so each distinct `(barIndex, timeMs)` fires at most once per kind across polls.
 * Without this, `tail_bar_only` hooks can repeat the same historical `SIGNAL_*` on every poll.
 */
export function createDedupingExecutionAdapter(
  inner: ExecutionAdapter,
  seen: Set<string> = new Set(),
): ExecutionAdapter {
  const dedupe = (kind: "ENTRY" | "EXIT", payload: ExecutionSignalPayload): boolean => {
    const key = `${kind}:${payload.barIndex}:${payload.timeMs}`;
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
