import { beforeEach, describe, expect, it } from "vitest";
import {
  clearConductorDrafts,
  conductorDraftKey,
  readConductorDraft,
  writeConductorDraft,
} from "./composer-drafts";

describe("Conductor composer drafts", () => {
  beforeEach(clearConductorDrafts);

  it("isolates drafts by project and chat", () => {
    const a = conductorDraftKey("project-a", "chat-1");
    const b = conductorDraftKey("project-b", "chat-1");
    const c = conductorDraftKey("project-a", "chat-2");
    writeConductorDraft(a, "only A/1");

    expect(readConductorDraft(a)).toBe("only A/1");
    expect(readConductorDraft(b)).toBe("");
    expect(readConductorDraft(c)).toBe("");
  });

  it("keeps an unsent new-chat draft separate and deletes empty drafts", () => {
    const key = conductorDraftKey("project-a", null);
    writeConductorDraft(key, "mission brief");
    expect(readConductorDraft(key)).toBe("mission brief");

    writeConductorDraft(key, "");
    expect(readConductorDraft(key)).toBe("");
  });
});
