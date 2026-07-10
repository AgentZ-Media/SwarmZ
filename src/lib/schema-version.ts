// swarmz.json schema version — the anchor for future store migrations.
//
// The store file gets a top-level `schemaVersion` key (a plain number).
// There is deliberately NO migration framework yet: `normalizeSchemaVersion`
// is the single pure hook the hydrate path runs — it decides which version a
// loaded store is on and whether the key must be (re)stamped. Later
// migrations (rebuild Phase 2+) bump `CURRENT_SCHEMA_VERSION` and branch on
// the normalized version here.

/** The schema version this build reads and writes. */
export const CURRENT_SCHEMA_VERSION = 1;

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
