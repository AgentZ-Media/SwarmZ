// Session admission is deliberately non-destructive. Large missions can
// exceed the old 30-session display threshold; creating attempt N+1 must not
// delete/stop attempt 1 before the backend for N+1 has even started.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SESSIONS_PER_PROJECT,
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
  vi.useFakeTimers();
  resetStore();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("non-destructive session admission", () => {
  it("keeps every session beyond the former per-project cap", () => {
    const total = MAX_SESSIONS_PER_PROJECT + 20;
    for (let i = 0; i < total; i++) {
      useVibe.getState().createSession(make(`a${i}`, "A"));
    }

    expect(useVibe.getState().order).toHaveLength(total);
    expect(useVibe.getState().sessions.a0).toBeDefined();
    expect(useVibe.getState().sessions[`a${total - 1}`]).toBeDefined();
  });

  it("never lets one project's admission delete another project's history", () => {
    for (let i = 0; i < MAX_SESSIONS_PER_PROJECT + 1; i++) {
      useVibe.getState().createSession(make(`b${i}`, "B"));
      useVibe.getState().createSession(make(`a${i}`, "A"));
    }

    for (let i = 0; i < MAX_SESSIONS_PER_PROJECT + 1; i++) {
      expect(useVibe.getState().sessions[`a${i}`]).toBeDefined();
      expect(useVibe.getState().sessions[`b${i}`]).toBeDefined();
    }
  });
});
