/**
 * Runtime-agnostic lifecycle, bounded caching, and adaptive scheduling primitives
 * shared across Node services, Electron host processes, and browser Studio views.
 */

export type BoundedLruCacheOptions<K, V> = {
  maxEntries: number;
  maxBytes?: number;
  sizeOf?: (value: V, key: K) => number;
  onEvict?: (value: V, key: K) => void;
};

/**
 * Bounded Map-backed LRU cache supporting both entry-count and byte-size budgets
 * with deterministic eviction callbacks (e.g. revoking Object URLs or freeing buffers).
 */
export class BoundedLruCache<K, V> {
  readonly maxEntries: number;
  readonly maxBytes: number | undefined;
  private readonly sizeOf: (value: V, key: K) => number;
  private readonly onEvict?: (value: V, key: K) => void;
  private readonly entries = new Map<K, { value: V; bytes: number }>();
  private totalBytes = 0;

  constructor(options: BoundedLruCacheOptions<K, V>) {
    if (!Number.isFinite(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError('BoundedLruCache requires maxEntries >= 1');
    }
    this.maxEntries = Math.floor(options.maxEntries);
    this.maxBytes =
      options.maxBytes !== undefined && Number.isFinite(options.maxBytes) && options.maxBytes > 0
        ? Math.floor(options.maxBytes)
        : undefined;
    this.sizeOf = options.sizeOf ?? (() => 0);
    this.onEvict = options.onEvict;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Refresh recency while maintaining O(1) Map operations.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): this {
    const bytes = Math.max(0, Math.floor(this.sizeOf(value, key)));
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.totalBytes = Math.max(0, this.totalBytes - existing.bytes);
      if (existing.value !== value) {
        this.safeEvict(existing.value, key);
      }
    }

    if (this.maxBytes !== undefined && bytes > this.maxBytes) {
      this.safeEvict(value, key);
      return this;
    }

    while (
      this.entries.size >= this.maxEntries
      || (this.maxBytes !== undefined && this.entries.size > 0 && this.totalBytes + bytes > this.maxBytes)
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey)!;
      this.entries.delete(oldestKey);
      this.totalBytes = Math.max(0, this.totalBytes - oldest.bytes);
      this.safeEvict(oldest.value, oldestKey);
    }

    this.entries.set(key, { value, bytes });
    this.totalBytes += bytes;
    return this;
  }

  delete(key: K): boolean {
    const existing = this.entries.get(key);
    if (!existing) return false;
    this.entries.delete(key);
    this.totalBytes = Math.max(0, this.totalBytes - existing.bytes);
    this.safeEvict(existing.value, key);
    return true;
  }

  clear(): void {
    const items = Array.from(this.entries.entries());
    this.entries.clear();
    this.totalBytes = 0;
    for (const [key, entry] of items) {
      this.safeEvict(entry.value, key);
    }
  }

  private safeEvict(value: V, key: K): void {
    try {
      this.onEvict?.(value, key);
    } catch {
      // Cleanup callbacks must never break cache invariants.
    }
  }
}

export type CleanupFn = () => unknown;

/**
 * Deterministic LIFO resource cleanup stack for timers, listeners, and handles.
 */
export class DisposableStack {
  private cleanups: CleanupFn[] = [];
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  add(cleanup: CleanupFn): () => void {
    if (this.disposed) {
      try {
        void cleanup();
      } catch {
        // Ignore cleanup errors on already-disposed stack.
      }
      return () => {};
    }
    this.cleanups.push(cleanup);
    return cleanup;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const tasks = this.cleanups.splice(0, this.cleanups.length).reverse();
    for (const fn of tasks) {
      try {
        await fn();
      } catch {
        // Best-effort teardown ensures remaining resources still dispose.
      }
    }
  }

  disposeSync(): void {
    if (this.disposed) return;
    this.disposed = true;
    const tasks = this.cleanups.splice(0, this.cleanups.length).reverse();
    for (const fn of tasks) {
      try {
        void fn();
      } catch {
        // Best-effort sync teardown.
      }
    }
  }
}

export type AdaptivePollerOptions = {
  activeIntervalMs: number;
  idleIntervalsMs: readonly number[];
  run: () => Promise<boolean> | boolean;
  unref?: boolean;
  onError?: (error: unknown) => void;
};

/**
 * Self-tuning background poller that wakes rapidly while work is active, backs off
 * through `idleIntervalsMs` when idle, and supports instant `nudge()` wakeups.
 */
export class AdaptivePoller {
  private readonly activeIntervalMs: number;
  private readonly idleIntervalsMs: readonly number[];
  private readonly run: () => Promise<boolean> | boolean;
  private readonly shouldUnref: boolean;
  private readonly onError?: (error: unknown) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private idleStep = 0;
  private started = false;
  private stopped = false;
  private running = false;
  private nudgedWhileRunning = false;

  constructor(options: AdaptivePollerOptions) {
    this.activeIntervalMs = Math.max(20, options.activeIntervalMs);
    this.idleIntervalsMs =
      options.idleIntervalsMs.length > 0 ? options.idleIntervalsMs : [this.activeIntervalMs];
    this.run = options.run;
    this.shouldUnref = options.unref ?? false;
    this.onError = options.onError;
  }

  start(): void {
    if (this.started && !this.stopped) return;
    this.started = true;
    this.stopped = false;
    this.idleStep = 0;
    this.schedule(0);
  }

  nudge(): void {
    if (this.stopped || !this.started) return;
    this.idleStep = 0;
    if (this.running) {
      this.nudgedWhileRunning = true;
      return;
    }
    this.clearTimer();
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    this.nudgedWhileRunning = false;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.clearTimer();
    const timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
    if (
      this.shouldUnref
      && typeof timer === 'object'
      && timer !== null
      && 'unref' in timer
      && typeof (timer as { unref?: () => void }).unref === 'function'
    ) {
      (timer as { unref: () => void }).unref();
    }
    this.timer = timer;
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    this.nudgedWhileRunning = false;
    let active = false;
    try {
      active = Boolean(await this.run());
    } catch (error) {
      this.onError?.(error);
    } finally {
      this.running = false;
    }
    if (this.stopped) return;
    if (this.nudgedWhileRunning) {
      this.nudgedWhileRunning = false;
      this.idleStep = 0;
      this.schedule(0);
      return;
    }
    if (active) {
      this.idleStep = 0;
      this.schedule(this.activeIntervalMs);
      return;
    }
    const idx = Math.min(this.idleStep, this.idleIntervalsMs.length - 1);
    const delay = this.idleIntervalsMs[idx]!;
    if (this.idleStep < this.idleIntervalsMs.length - 1) {
      this.idleStep += 1;
    }
    this.schedule(delay);
  }
}
