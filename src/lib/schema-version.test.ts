import { describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  migrateSettingsV3,
  normalizeSchemaVersion,
  planSchemaMigration,
} from "./schema-version";

describe("normalizeSchemaVersion", () => {
  it("keeps a valid stored version without stamping", () => {
    expect(normalizeSchemaVersion(1)).toEqual({ version: 1, stamp: false });
    expect(normalizeSchemaVersion(7)).toEqual({ version: 7, stamp: false });
  });

  it("keeps a NEWER version untouched (downgrade must not clobber)", () => {
    const newer = CURRENT_SCHEMA_VERSION + 5;
    expect(normalizeSchemaVersion(newer)).toEqual({
      version: newer,
      stamp: false,
    });
  });

  it("stamps a missing key (pre-versioning store)", () => {
    expect(normalizeSchemaVersion(undefined)).toEqual({
      version: CURRENT_SCHEMA_VERSION,
      stamp: true,
    });
    expect(normalizeSchemaVersion(null)).toEqual({
      version: CURRENT_SCHEMA_VERSION,
      stamp: true,
    });
  });

  it("stamps invalid values", () => {
    for (const bad of ["1", 0, -3, 1.5, NaN, Infinity, {}, [], true]) {
      expect(normalizeSchemaVersion(bad)).toEqual({
        version: CURRENT_SCHEMA_VERSION,
        stamp: true,
      });
    }
  });
});

describe("planSchemaMigration", () => {
  it("does nothing for a current or newer store", () => {
    expect(planSchemaMigration(CURRENT_SCHEMA_VERSION)).toEqual({
      cleanupDeadKeys: false,
      cleanupLegacyPersona: false,
      stampVersion: null,
    });
    expect(planSchemaMigration(CURRENT_SCHEMA_VERSION + 3)).toEqual({
      cleanupDeadKeys: false,
      cleanupLegacyPersona: false,
      stampVersion: null,
    });
  });

  it("cleans pane-era keys and persona settings in a v1 store", () => {
    expect(planSchemaMigration(1)).toEqual({
      cleanupDeadKeys: true,
      cleanupLegacyPersona: true,
      stampVersion: CURRENT_SCHEMA_VERSION,
    });
  });

  it("only cleans persona settings in a v2 store", () => {
    expect(planSchemaMigration(2)).toEqual({
      cleanupDeadKeys: false,
      cleanupLegacyPersona: true,
      stampVersion: CURRENT_SCHEMA_VERSION,
    });
  });

  it("cleans up + stamps a pre-versioning / invalid store (may still carry pane-era keys)", () => {
    for (const raw of [undefined, null, "2", 0, -1, 1.5]) {
      expect(planSchemaMigration(raw)).toEqual({
        cleanupDeadKeys: true,
        cleanupLegacyPersona: true,
        stampVersion: CURRENT_SCHEMA_VERSION,
      });
    }
  });

  it("is idempotent: after the stamp, a re-run plans nothing", () => {
    const first = planSchemaMigration(1);
    expect(first.stampVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(planSchemaMigration(first.stampVersion)).toEqual({
      cleanupDeadKeys: false,
      cleanupLegacyPersona: false,
      stampVersion: null,
    });
  });
});

describe("migrateSettingsV3", () => {
  it("removes only the legacy persona value", () => {
    const result = migrateSettingsV3({
      codexPath: "/usr/bin/codex",
      orchestratorPersona: { name: "Hive" },
      githubIntegration: true,
    });
    expect(result).toEqual({
      settings: {
        codexPath: "/usr/bin/codex",
        githubIntegration: true,
      },
      removedLegacyPersona: true,
    });
  });

  it("leaves already-clean settings unchanged", () => {
    const settings = { codexPath: "/usr/bin/codex" };
    const result = migrateSettingsV3(settings);
    expect(result.settings).toBe(settings);
    expect(result.removedLegacyPersona).toBe(false);
  });
});
