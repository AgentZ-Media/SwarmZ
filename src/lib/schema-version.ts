// swarmz.json schema version — the anchor for store migrations.
//
// The store file gets a top-level `schemaVersion` key (a plain number).
// `normalizeSchemaVersion` decides which version a loaded store is on;
// `planSchemaMigration` turns that into the (idempotent) actions hydrate
// runs. Version history:
//   1 — the key itself (rebuild Phase 0); no shape changes.
//   2 — projects & swarm data model (rebuild Phase 2): the dead pane-era
//       keys are deleted once, sessions carry projectId (the per-slice
//       hydrators do the actual value migration tolerantly).
//   3 — one fixed Orchestrator identity: the removed persona editor's nested
//       `settings.orchestratorPersona` value is stripped while every other
//       setting (especially memory, stored under separate keys) is retained.

/** The schema version this build reads and writes. */
export const CURRENT_SCHEMA_VERSION = 3;

/**
 * Pane-era store keys that are no longer read anywhere. Deleted once by the
 * v2 migration (deleting a missing key is a no-op, so the cleanup is safe to
 * run against any pre-v2 store — including pre-versioning ones).
 */
export const DEAD_STORE_KEYS = [
  "grid",
  "workspaces",
  "workspacePresets",
  "commandPresets",
  "customCommands",
  "profiles",
] as const;

export interface NormalizedSchemaVersion {
  /** The version the store is considered to be on. */
  version: number;
  /** True when the key is missing/invalid and must be written back. */
  stamp: boolean;
}

/**
 * Normalize a raw `schemaVersion` value read from swarmz.json.
 *
 * - a positive integer is kept as-is (even if NEWER than this build knows —
 *   a downgraded build must not clobber a newer store's version stamp)
 * - anything else (missing key, null, strings, fractions, zero, negatives)
 *   counts as a pre-versioning store: it is treated as the current version
 *   and stamped on the next save.
 */
export function normalizeSchemaVersion(raw: unknown): NormalizedSchemaVersion {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) {
    return { version: raw, stamp: false };
  }
  return { version: CURRENT_SCHEMA_VERSION, stamp: true };
}

export interface SchemaMigrationPlan {
  /** delete the DEAD_STORE_KEYS from swarmz.json (one-time v2 cleanup) */
  cleanupDeadKeys: boolean;
  /** strip the removed nested settings.orchestratorPersona value */
  cleanupLegacyPersona: boolean;
  /** write this version back, or null when the stored stamp already suffices */
  stampVersion: number | null;
}

/**
 * Decide what hydrate must do for a raw stored `schemaVersion`.
 *
 * - `>= 2` (incl. NEWER) → nothing: cleanup already ran, stamp stays.
 * - `1` → the store predates the project model: delete the dead keys, then
 *   stamp 2.
 * - missing/invalid → could be a pre-rebuild store that still carries the
 *   dead pane-era keys: run the (no-op-safe) cleanup too, then stamp 2.
 *
 * The plan is idempotent — running it twice deletes nothing new and writes
 * the same stamp.
 */
export function planSchemaMigration(raw: unknown): SchemaMigrationPlan {
  if (
    typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw >= CURRENT_SCHEMA_VERSION
  ) {
    return {
      cleanupDeadKeys: false,
      cleanupLegacyPersona: false,
      stampVersion: null,
    };
  }
  const version =
    typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : 0;
  return {
    cleanupDeadKeys: version < 2,
    cleanupLegacyPersona: version < 3,
    stampVersion: CURRENT_SCHEMA_VERSION,
  };
}

/**
 * Strip the only nested value removed by schema v3. Memory is deliberately
 * not part of AppSettings and therefore cannot be touched by this migration.
 */
export function migrateSettingsV3<T extends Record<string, unknown>>(
  settings: T,
): { settings: Omit<T, "orchestratorPersona">; removedLegacyPersona: boolean } {
  if (!("orchestratorPersona" in settings)) {
    return { settings, removedLegacyPersona: false };
  }
  const { orchestratorPersona: _removed, ...rest } = settings;
  return { settings: rest, removedLegacyPersona: true };
}
