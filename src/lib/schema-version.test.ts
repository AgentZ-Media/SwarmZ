import { describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  normalizeSchemaVersion,
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
