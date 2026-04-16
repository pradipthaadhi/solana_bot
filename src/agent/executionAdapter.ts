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
