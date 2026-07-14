import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersistenceCoordinator } from "./coordinator";

afterEach(() => {
  vi.useRealTimers();
});

describe("persistence coordinator", () => {
  it("never writes after hydration failed", async () => {
    const save = vi.fn(async (_value: number) => {});
    let value = 1;
    const p = createPersistenceCoordinator({
      name: "test",
      debounceMs: 10,
      snapshot: () => value,
      save,
    });

    p.hydrationFailed(new Error("unreadable"));
    value = 2;
    p.schedule();
    await p.flush();

    expect(save).not.toHaveBeenCalled();
    expect(p.health().hydration).toBe("failed");
  });

  it("serializes writes and persists a mutation that lands in flight", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => (releaseFirst = resolve));
    const saved: number[] = [];
    let calls = 0;
    const save = vi.fn(async (value: number) => {
      saved.push(value);
      calls += 1;
      if (calls === 1) await first;
    });
    let value = 1;
    const p = createPersistenceCoordinator({
      name: "test",
      debounceMs: 0,
      snapshot: () => value,
      save,
    });
    p.hydrationSucceeded();
    p.schedule();
    const flushing = p.flush();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    value = 2;
    p.schedule();
    releaseFirst();
    await flushing;

    expect(saved).toEqual([1, 2]);
  });

  it("keeps a rejected write dirty and retries it on a later flush", async () => {
    const save = vi
      .fn<(value: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const p = createPersistenceCoordinator({
      name: "test",
      debounceMs: 50,
      snapshot: () => 7,
      save,
    });
    p.hydrationSucceeded();
    p.schedule();

    await p.flush();
    expect(p.health().write).toBe("failed");
    await p.flush();

    expect(save).toHaveBeenCalledTimes(2);
    expect(p.health()).toEqual({
      hydration: "ready",
      write: "idle",
      error: null,
    });
  });

  it("does not mint a write on a clean fresh hydration", async () => {
    const save = vi.fn(async (_value: number) => {});
    const p = createPersistenceCoordinator({
      name: "test",
      debounceMs: 10,
      snapshot: () => 0,
      save,
    });
    p.hydrationSucceeded();
    await p.flush();
    expect(save).not.toHaveBeenCalled();
  });
});
