import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, getState } = vi.hoisted(() => ({
  invoke: vi.fn(),
  getState: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/store", () => ({ useSwarm: { getState } }));

import {
  nativeLiveBackendCount,
  resumeNativeSession,
  reviewNativeSession,
  sendNativeTurn,
  startNativeSession,
} from "./native";

describe("native vibe session boundary", () => {
  beforeEach(() => {
    invoke.mockReset();
    getState.mockReturnValue({ settings: { codexPath: "/opt/codex" } });
  });

  it("preserves the exact start wire and the configured Codex path", async () => {
    invoke.mockResolvedValue({ thread_id: "thread-1" });

    await startNativeSession("session-1", {
      projectDir: "/repo",
      model: "gpt-5",
      effort: "high",
      access: "workspace",
    });

    expect(invoke).toHaveBeenCalledWith("vibe_session_start", {
      sessionId: "session-1",
      cwd: "/repo",
      model: "gpt-5",
      effort: "high",
      access: "workspace",
      codexPath: "/opt/codex",
    });
  });

  it("preserves nullable resume defaults", async () => {
    invoke.mockResolvedValue({ thread_id: "thread-1", resumed: true });

    await resumeNativeSession("session-1", "thread-1", {
      projectDir: "/repo",
      access: "workspace",
    });

    expect(invoke).toHaveBeenCalledWith("vibe_session_resume", {
      sessionId: "session-1",
      threadId: "thread-1",
      cwd: "/repo",
      model: null,
      effort: null,
      access: "workspace",
      codexPath: "/opt/codex",
    });
  });

  it("keeps output-schema and workspace enforcement on sends", async () => {
    invoke.mockResolvedValue({ turn_id: "turn-1" });
    const schema = { type: "object" };

    await sendNativeTurn("session-1", "work", schema, true);

    expect(invoke).toHaveBeenCalledWith("vibe_session_send", {
      sessionId: "session-1",
      text: "work",
      outputSchema: schema,
      requireWorkspace: true,
    });
  });

  it("keeps detached review workspace enforcement", async () => {
    invoke.mockResolvedValue({
      status: "completed",
      review: "ok",
      review_thread_id: "review-1",
    });

    await reviewNativeSession("session-1", "branch:main", "review-1", true);

    expect(invoke).toHaveBeenCalledWith("vibe_session_review", {
        sessionId: "session-1",
        target: "branch:main",
        reviewLaneId: "review-1",
        requireWorkspace: true,
    });
  });

  it("reads native process occupancy without session-history arguments", async () => {
    invoke.mockResolvedValue(7);
    await expect(nativeLiveBackendCount()).resolves.toBe(7);
    expect(invoke).toHaveBeenCalledWith("vibe_session_live_backend_count");
  });
});
