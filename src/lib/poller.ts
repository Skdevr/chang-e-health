export const POLL_INTERVAL_MS = 30_000;

export interface PollControllerOptions {
  intervalMs?: number;
  isDocumentHidden?: () => boolean;
  onTick: (signal: AbortSignal) => Promise<void>;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
}

/**
 * Single-flight poll controller:
 * - Prevents overlapping requests (ignores ticks while previous fetch is in-flight)
 * - Cancels active AbortController on stop/unmount
 * - Pauses ticks while page is hidden and triggers immediate refresh when visible again
 * - Supports resetting the interval countdown after manual refreshes
 */
export class PollScheduler {
  private readonly intervalMs: number;
  private readonly isDocumentHidden: () => boolean;
  private readonly onTick: (signal: AbortSignal) => Promise<void>;
  private readonly setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (id: ReturnType<typeof setInterval>) => void;

  private timerId: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private stopped = false;
  private currentAbort: AbortController | null = null;

  constructor(options: PollControllerOptions) {
    this.intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
    this.isDocumentHidden = options.isDocumentHidden ?? (() => false);
    this.onTick = options.onTick;
    this.setIntervalFn = options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = options.clearIntervalFn ?? ((id) => clearInterval(id));
  }

  public isInFlight(): boolean {
    return this.inFlight;
  }

  public start(): void {
    this.stopped = false;
    this.scheduleTimer();
  }

  public stop(): void {
    this.stopped = true;
    this.clearTimer();
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
  }

  public resetTimer(): void {
    if (this.stopped) return;
    this.scheduleTimer();
  }

  public async triggerNow(options?: { forceWhenHidden?: boolean }): Promise<boolean> {
    if (this.stopped) return false;
    if (!options?.forceWhenHidden && this.isDocumentHidden()) {
      return false;
    }
    if (this.inFlight) {
      return false;
    }

    this.inFlight = true;
    const controller = new AbortController();
    this.currentAbort = controller;

    try {
      await this.onTick(controller.signal);
      return true;
    } finally {
      if (this.currentAbort === controller) {
        this.currentAbort = null;
      }
      this.inFlight = false;
    }
  }

  public handleVisibilityChange(): void {
    if (this.stopped) return;
    if (this.isDocumentHidden()) {
      this.clearTimer();
    } else {
      this.scheduleTimer();
      void this.triggerNow();
    }
  }

  private scheduleTimer(): void {
    this.clearTimer();
    if (this.stopped || this.isDocumentHidden()) return;
    this.timerId = this.setIntervalFn(() => {
      void this.triggerNow();
    }, this.intervalMs);
  }

  private clearTimer(): void {
    if (this.timerId !== null) {
      this.clearIntervalFn(this.timerId);
      this.timerId = null;
    }
  }
}
