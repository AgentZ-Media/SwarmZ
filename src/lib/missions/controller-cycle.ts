/**
 * Dependency-injected controller phase router. Keeping the ordering pure and
 * explicit prevents lifecycle refactors from moving admission ahead of
 * recovery or attempting settlement before stop enforcement.
 */
export interface MissionControllerCycleOps<TAttempt> {
  pauseRuntimeDrift(): Promise<void>;
  enforceStops(): Promise<void>;
  recover(): Promise<void>;
  attempts(): readonly TAttempt[];
  isRunning(attempt: TAttempt): boolean;
  settle(attempt: TAttempt): Promise<void>;
  admit(): Promise<void>;
}

export async function runMissionControllerCycle<TAttempt>(
  ops: MissionControllerCycleOps<TAttempt>,
): Promise<void> {
  await ops.pauseRuntimeDrift();
  await ops.enforceStops();
  await ops.recover();
  for (const attempt of ops.attempts()) {
    if (ops.isRunning(attempt)) await ops.settle(attempt);
  }
  await ops.admit();
}
