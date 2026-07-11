// The per-project session cap must route EVICTED sessions through the backend
// cleanup sink (T2 — the real process/map leak fix): the store drops the entry
// from its own state, and the sink (controller-registered) ends the Rust child
// process + the per-session controller maps. Without it every eviction leaked a
// codex process. These tests freeze the sink wiring + per-project scoping.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SESSIONS_PER_PROJECT,
  registerSessionEvictionSink,
  useVibe,
  type NewVibeSession,
} from "./session-store";

function resetStore(): void {
  useVibe.setState({
    sessions: {},
    order: [],
    activeId: null,
    activeIdByProject: {},
    busy: {},
  });
}

function make(id: string, projectId: string): NewVibeSession {
  return {
    id,
    name: id,
    projectId,
    projectDir: `/repo/${projectId}`,
    access: "workspace",
  };
}

beforeEach(() => {
  // fake timers so the store's 800 ms persist debounce (which hits the Tauri
  // backend) never fires during the test
  vi.useFakeTimers();
  resetStore();
});

afterEach(() => {
  registerSessionEvictionSink(null);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("per-project session cap eviction sink (T2)", () => {
  it("hands the oldest evicted ids to the sink, not just deletes them", () => {
    const evicted: string[] = [];
    registerSessionEvictionSink((ids) => evicted.push(...ids));

    const total = MAX_SESSIONS_PER_PROJECT + 2;
    for (let i = 0; i < total; i++) {
      useVibe.getState().createSession(make(`a${i}`, "A"));
    }

    // the two OLDEST (a0, a1) are evicted through the sink, in creation order
    expect(evicted).toEqual(["a0", "a1"]);
    // and they are gone from the store's own state
    const st = useVibe.getState();
    expect(st.sessions.a0).toBeUndefined();
    expect(st.sessions.a1).toBeUndefined();
    expect(st.order).toHaveLength(MAX_SESSIONS_PER_PROJECT);
    expect(st.order).not.toContain("a0");
    expect(st.order).toContain(`a${total - 1}`);
  });

  it("caps per project — one project's churn never evicts another's", () => {
    const evicted: string[] = [];
    registerSessionEvictionSink((ids) => evicted.push(...ids));

    // fill B to the brim (kept), then overflow A
    for (let i = 0; i < MAX_SESSIONS_PER_PROJECT; i++) {
      useVibe.getState().createSession(make(`b${i}`, "B"));
    }
    for (let i = 0; i < MAX_SESSIONS_PER_PROJECT + 1; i++) {
      useVibe.getState().createSession(make(`a${i}`, "A"));
    }

    // only A's oldest was evicted; no B session was touched
    expect(evicted).toEqual(["a0"]);
    expect(evicted.every((id) => id.startsWith("a"))).toBe(true);
    const st = useVibe.getState();
    for (let i = 0; i < MAX_SESSIONS_PER_PROJECT; i++)
      expect(st.sessions[`b${i}`]).toBeDefined();
  });

  it("does not call the sink when nothing is evicted", () => {
    let called = 0;
    registerSessionEvictionSink(() => called++);
    useVibe.getState().createSession(make("solo", "A"));
    expect(called).toBe(0);
    expect(useVibe.getState().sessions.solo).toBeDefined();
  });
});
