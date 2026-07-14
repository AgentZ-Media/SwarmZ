import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VibeSessionEntry } from "@/lib/vibe/session-store";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { busyLaneBlocker, canonicalizePath, withWorktreeLock } from "./executor-worktrees";

function entry(id: string, path: string): VibeSessionEntry {
  return { session: { id, name: id, projectDir: path } } as VibeSessionEntry;
}

describe("worktree mutation locks", () => {
  beforeEach(() => invokeMock.mockReset());

  it("fails closed when canonical identity cannot be established", async () => {
    invokeMock.mockRejectedValueOnce(new Error("folder vanished"));
    const operation = vi.fn();

    await expect(withWorktreeLock("/tmp/alias", operation)).rejects.toThrow("folder vanished");
    expect(operation).not.toHaveBeenCalled();
  });

  it("serializes aliases on their canonical path and releases after failure", async () => {
    invokeMock.mockResolvedValue("/private/tmp/repo/.worktrees/lane");
    const order: string[] = [];
    let release!: () => void;
    const firstGate = new Promise<void>((resolve) => { release = resolve; });

    const first = withWorktreeLock("/tmp/lane", async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
      throw new Error("expected failure");
    });
    const second = withWorktreeLock("/private/tmp/repo/.worktrees/lane", async () => {
      order.push("second");
      return 2;
    });

    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    release();
    await expect(first).rejects.toThrow("expected failure");
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(["first:start", "first:end", "second"]);

    // A completed chain is not retained: a later operation starts normally.
    await expect(withWorktreeLock("/tmp/lane", async () => 3)).resolves.toBe(3);
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it("exposes canonicalization as a strict authority boundary", async () => {
    invokeMock.mockResolvedValueOnce("/canonical/repo");
    await expect(canonicalizePath("/alias/repo")).resolves.toBe("/canonical/repo");
    expect(invokeMock).toHaveBeenCalledWith("canonicalize_path", { path: "/alias/repo" });
  });

  it("finds a different busy writer in the same checkout only", () => {
    const entries = [entry("target", "/repo/wt"), entry("writer", "/repo/wt/"), entry("other", "/repo/other")];
    expect(busyLaneBlocker(entries, "/repo/wt", "target", { target: true, writer: true, other: true })?.session.id)
      .toBe("writer");
    expect(busyLaneBlocker(entries, "/repo/wt", "target", { target: true, writer: false, other: true }))
      .toBeNull();
  });
});
