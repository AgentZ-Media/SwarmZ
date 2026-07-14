import { describe, expect, it } from "vitest";
import { newlyWaitingSessions } from "./sound";

describe("attention sound transitions", () => {
  it("rings only for sessions that newly need the human", () => {
    expect(
      newlyWaitingSessions(new Set(["already-waiting"]), new Set(["already-waiting", "new"])),
    ).toEqual(["new"]);
  });

  it("does not ring again while the same session remains waiting", () => {
    expect(newlyWaitingSessions(new Set(["agent"]), new Set(["agent"]))).toEqual([]);
  });

  it("can ring again after attention was resolved", () => {
    expect(newlyWaitingSessions(new Set(), new Set(["agent"]))).toEqual(["agent"]);
  });
});
