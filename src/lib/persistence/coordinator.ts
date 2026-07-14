/**
 * Shared persistence state machine for Zustand slices.
 *
 * Invariants:
 * - a read failure is fail-closed: no write may replace the unreadable key;
 * - writes are serialized and take their snapshot only when they execute;
 * - flush joins every in-flight write and persists the newest dirty revision;
 * - rejected writes are observed here (never as unhandled promises) and stay
 *   dirty so a later mutation/flush can retry them.
 */

export type HydrationStatus = "pending" | "ready" | "failed";
export type PersistWriteStatus = "idle" | "writing" | "failed";

export interface PersistHealth {
  hydration: HydrationStatus;
  write: PersistWriteStatus;
  error: unknown | null;
}

const coordinatorRegistry = new Map<string, PersistenceCoordinator>();
const healthListeners = new Set<() => void>();
let healthRevision = 0;

function notifyHealth(): void {
  healthRevision += 1;
  for (const listener of healthListeners) listener();
}

/** Global health seam for the persistent, user-visible fail-closed banner. */
export function subscribePersistenceHealth(listener: () => void): () => void {
  healthListeners.add(listener);
  return () => healthListeners.delete(listener);
}

export function persistenceHealthRevision(): number {
  return healthRevision;
}

export function persistenceIssues(): Array<{
  name: string;
  health: PersistHealth;
}> {
  const issues: Array<{ name: string; health: PersistHealth }> = [];
  for (const [name, coordinator] of coordinatorRegistry) {
    const health = coordinator.health();
    if (health.hydration === "failed" || health.write === "failed") {
      issues.push({ name, health });
    }
  }
  return issues.sort((a, b) => a.name.localeCompare(b.name));
}

/** Retry dirty write failures. Read failures intentionally remain gated. */
export async function retryPersistenceWrites(): Promise<void> {
  await Promise.allSettled(
    [...coordinatorRegistry.values()].map((coordinator) => coordinator.flush()),
  );
  notifyHealth();
}

export interface PersistenceCoordinator {
  /** Mark the key readable (including a genuinely missing key). */
  hydrationSucceeded(): void;
  /** Mark the key unreadable. Future schedules/flushes remain write-gated. */
  hydrationFailed(error: unknown): void;
  /** Record a state mutation and debounce its durable write. */
  schedule(): void;
  /** Persist/join the newest dirty state now. No-op after a failed read. */
  flush(): Promise<void>;
  /** Join already-running work without creating a new write. */
  join(): Promise<void>;
  health(): PersistHealth;
  /** Test/lifecycle escape hatch. */
  reset(): void;
}

export interface PersistenceCoordinatorOptions<T> {
  name: string;
  debounceMs: number;
  snapshot: () => T;
  save: (value: T) => Promise<void>;
  onWriteError?: (error: unknown) => void;
}

export function createPersistenceCoordinator<T>(
  opts: PersistenceCoordinatorOptions<T>,
): PersistenceCoordinator {
  let hydration: HydrationStatus = "pending";
  let write: PersistWriteStatus = "idle";
  let error: unknown | null = null;
  let revision = 0;
  let persistedRevision = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  const enqueue = (): Promise<void> => {
    chain = chain.then(async () => {
      if (hydration !== "ready" || persistedRevision >= revision) return;

      // A mutation can land while save() is awaiting. Keep draining until the
      // newest revision that existed during this chain is durable.
      while (hydration === "ready" && persistedRevision < revision) {
        const targetRevision = revision;
        write = "writing";
        try {
          await opts.save(opts.snapshot());
          persistedRevision = targetRevision;
          write = "idle";
          error = null;
          notifyHealth();
        } catch (cause) {
          write = "failed";
          error = cause;
          opts.onWriteError?.(cause);
          notifyHealth();
          // The revision deliberately remains dirty. A later flush/mutation
          // retries it, without an unbounded retry loop during shutdown.
          return;
        }
      }
    });
    return chain;
  };

  const arm = () => {
    if (hydration !== "ready" || timer || persistedRevision >= revision) return;
    timer = setTimeout(() => {
      timer = null;
      void enqueue();
    }, opts.debounceMs);
  };

  const coordinator: PersistenceCoordinator = {
    hydrationSucceeded() {
      if (hydration === "failed") return;
      hydration = "ready";
      error = null;
      arm();
      notifyHealth();
    },

    hydrationFailed(cause) {
      clearTimer();
      hydration = "failed";
      error = cause;
      notifyHealth();
    },

    schedule() {
      revision += 1;
      arm();
    },

    async flush() {
      clearTimer();
      if (hydration === "ready" && persistedRevision < revision) enqueue();
      await chain;
    },

    async join() {
      await chain;
    },

    health() {
      return { hydration, write, error };
    },

    reset() {
      clearTimer();
      hydration = "pending";
      write = "idle";
      error = null;
      revision = 0;
      persistedRevision = 0;
      chain = Promise.resolve();
      notifyHealth();
    },
  };
  coordinatorRegistry.set(opts.name, coordinator);
  return coordinator;
}
