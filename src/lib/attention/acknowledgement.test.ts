import { describe, expect, it } from "vitest";
import type { AttentionRow } from "./core";
import {
  acknowledgeGithubAttention,
  isAttentionAcknowledged,
} from "./acknowledgement";

const githubRow = (revision: string): AttentionRow => ({
  key: "github:p1:7",
  source: "github",
  sourceId: "7",
  projectId: "p1",
  missionId: null,
  title: "PR #7",
  place: "SwarmZ · GitHub",
  detail: "CI failed",
  since: 1,
  tone: "failed",
  statusLabel: "CI failed",
  revision,
});

describe("GitHub attention acknowledgement", () => {
  it("marks the observed failure read but resurfaces a changed revision", () => {
    const acknowledged = acknowledgeGithubAttention({}, [githubRow("run-1")]);
    expect(isAttentionAcknowledged(githubRow("run-1"), acknowledged)).toBe(true);
    expect(isAttentionAcknowledged(githubRow("run-2"), acknowledged)).toBe(false);
  });

  it("never dismisses human decisions from other attention sources", () => {
    const worker = { ...githubRow("x"), key: "worker:1", source: "worker" as const };
    const acknowledged = acknowledgeGithubAttention({}, [worker]);
    expect(acknowledged).toEqual({});
    expect(isAttentionAcknowledged(worker, acknowledged)).toBe(false);
  });
});
