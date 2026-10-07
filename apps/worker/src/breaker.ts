import type { JobType } from "@rephoto/contracts";

/** Job types that talk to the face service; paused while the breaker is open. */
export const FACE_JOB_TYPES: readonly JobType[] = ["index", "attach", "match"];

export const BREAKER_THRESHOLD = 5;
export const BREAKER_PAUSE_MS = 30_000;

/**
 * Per-process circuit breaker on the face service (v5, B). After `threshold`
 * consecutive `FaceServiceUnavailable` outcomes the worker stops claiming
 * `index` / `attach` / `match` for `pauseMs`; any other job type keeps flowing.
 * A successful face job closes it. The open transition is reported once.
 */
export class FaceServiceBreaker {
  private consecutive = 0;
  private pausedUntil = 0;

  constructor(
    private readonly options: {
      threshold?: number;
      pauseMs?: number;
      now?: () => number;
    } = {},
  ) {}

  /** Returns true when this failure opened the breaker (log once). */
  recordUnavailable(): boolean {
    this.consecutive += 1;
    if (this.consecutive < (this.options.threshold ?? BREAKER_THRESHOLD)) return false;
    const wasOpen = this.isOpen();
    this.pausedUntil = this.now() + (this.options.pauseMs ?? BREAKER_PAUSE_MS);
    this.consecutive = 0;
    return !wasOpen;
  }

  recordSuccess(): void {
    this.consecutive = 0;
  }

  isOpen(): boolean {
    return this.now() < this.pausedUntil;
  }

  /** Types the next claim must skip, or undefined when every type may run. */
  excludedTypes(): readonly JobType[] | undefined {
    return this.isOpen() ? FACE_JOB_TYPES : undefined;
  }

  /** Milliseconds until the breaker closes (0 when closed). */
  remainingMs(): number {
    return Math.max(0, this.pausedUntil - this.now());
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
