// Dev-only smoke-test surface for Vibe Mode. Loaded from App.tsx via a
// DEV-guarded dynamic import, so production builds tree-shake the whole module.
//
// Live backend (needs the native app):
//   const id = await __vibe.start({ name: "probe", projectDir: "/path/to/repo" })
//   await __vibe.send(id, "list the files here and summarize the project")
//   __vibe.interrupt(id) · await __vibe.approve(id, approvalId, "accept")
//   await __vibe.setAccess(id, "workspace") · await __vibe.close(id)
//
// Rendering-only seeding (works in the plain Vite dev server, no backend) —
// Phase 4 verification of the diff stack + approval takeover:
//   const id = __vibe.seed.session()          // a fake session in the store
//   __vibe.seed.bigDiff(id)                    // ~3000-line diff over 15 files
//   __vibe.seed.approval(id, "command")        // a pending command approval
//   __vibe.seed.approval(id, "fileChange")     // + a linked fileChange item
//   __vibe.seed.queue(id, 3)                   // 3 pending approvals (takeover 1/3)
//   __vibe.seed.crossSession()                 // a second session that needs you

import { nanoid } from "nanoid";
import {
  closeSession,
  interrupt,
  respondApproval,
  sendMessage,
  setAccess,
  startSession,
  type StartSessionOpts,
  type VibeApprovalDecision,
} from "./controller";
import { buildVibePersistSnapshot, useVibe } from "./session-store";
import type { VibeAccess, VibeFileChange } from "@/types";

// ---- fake-diff generators (rendering-only) ----

const SEED_FILES = [
  "src/lib/vibe/controller.ts",
  "src/components/vibe/FocusStage.tsx",
  "src/store.ts",
  "src-tauri/src/codex/sessions.rs",
  "src/lib/orchestrator/bus.ts",
  "src/styles.css",
  "src/components/Deck.tsx",
  "scripts/build.py",
  "src/lib/git.ts",
  "src/components/vibe/ItemFeed.tsx",
  "docs/ARCHITECTURE.md",
  "src/lib/vibe/diff.ts",
  "src-tauri/src/lib.rs",
  "src/components/TitleBar.tsx",
  "src/lib/limits.ts",
];

/** A per-file unified diff whose hunk header counts match its body. */
function fileDiff(path: string, n: number): string {
  const rows: string[] = [];
  let oldC = 0;
  let newC = 0;
  for (let i = 0; i < n; i++) {
    const mod = i % 7;
    if (mod === 0) {
      rows.push(`-  const removed_${i} = ${i};`);
      oldC++;
    } else if (mod === 1) {
      rows.push(`+  const added_${i} = compute(${i}) * 2;`);
      newC++;
    } else if (mod === 2) {
      rows.push(`-  legacy(${i});`);
      rows.push(`+  modern(${i}, { flag: true });`);
      oldC++;
      newC++;
    } else {
      rows.push(`   const kept_${i} = ${i};`);
      oldC++;
      newC++;
    }
  }
  return (
    `diff --git a/${path} b/${path}\n` +
    `index 1111111..2222222 100644\n` +
    `--- a/${path}\n+++ b/${path}\n` +
    `@@ -1,${oldC} +1,${newC} @@\n` +
    rows.join("\n") +
    "\n"
  );
}

/** Raw content for a synthesized "new file" (kind add). */
function newFileContent(path: string, n: number): string {
  const rows: string[] = [`// ${path} — generated`];
  for (let i = 0; i < n; i++) rows.push(`export const field_${i} = ${i};`);
  return rows.join("\n") + "\n";
}

function buildBigDiff(files: number, linesPerFile: number): {
  aggregate: string;
  changes: VibeFileChange[];
} {
  const chunks: string[] = [];
  const changes: VibeFileChange[] = [];
  for (let f = 0; f < files; f++) {
    const path = SEED_FILES[f % SEED_FILES.length];
    const isNew = f % 5 === 4; // every 5th file is a brand-new file
    if (isNew) {
      const content = newFileContent(path, Math.floor(linesPerFile / 3));
      changes.push({ path, kind: { type: "add" }, diff: content });
      // an add still contributes to the aggregate as a +++ hunk
      const lines = content.trimEnd().split("\n");
      chunks.push(
        `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n` +
          lines.map((l) => `+${l}`).join("\n") +
          "\n",
      );
    } else {
      const d = fileDiff(path, linesPerFile);
      changes.push({ path, kind: { type: "update" }, diff: d });
      chunks.push(d);
    }
  }
  return { aggregate: chunks.join(""), changes };
}

// ---- store seeding ----

function seedSession(opts?: Partial<StartSessionOpts>): string {
  const id = nanoid(10);
  useVibe.getState().createSession({
    id,
    name: opts?.name ?? "seeded session",
    projectDir: opts?.projectDir ?? "/Users/you/Code/SwarmZ",
    model: opts?.model ?? "gpt-5-codex",
    effort: opts?.effort ?? "medium",
    access: opts?.access ?? "workspace",
    threadId: null,
  });
  return id;
}

function seedBigDiff(sessionId: string, files = 15, linesPerFile = 200): void {
  const { aggregate, changes } = buildBigDiff(files, linesPerFile);
  const store = useVibe.getState();
  store.upsertItem(sessionId, {
    id: `fc-${nanoid(6)}`,
    at: Date.now(),
    kind: "fileChange",
    status: "completed",
    changes,
  });
  store.setDiff(sessionId, aggregate);
}

function seedApproval(
  sessionId: string,
  kind: "command" | "fileChange",
): string {
  const store = useVibe.getState();
  const approvalId = `appr-${nanoid(6)}`;
  if (kind === "fileChange") {
    // a linked fileChange item the takeover previews via payload.itemId
    const fcId = `fc-${nanoid(6)}`;
    const changes: VibeFileChange[] = [
      { path: "src/lib/vibe/diff.ts", kind: { type: "update" }, diff: fileDiff("src/lib/vibe/diff.ts", 24) },
      { path: "src/components/vibe/DiffCard.tsx", kind: { type: "update" }, diff: fileDiff("src/components/vibe/DiffCard.tsx", 12) },
    ];
    store.upsertItem(sessionId, {
      id: fcId,
      at: Date.now(),
      kind: "fileChange",
      status: "pending",
      changes,
    });
    store.upsertItem(sessionId, {
      id: approvalId,
      at: Date.now(),
      kind: "approval",
      approvalKind: "fileChange",
      status: "pending",
      payload: { itemId: fcId, reason: "Apply the diff-stack changes" },
    });
  } else {
    store.upsertItem(sessionId, {
      id: approvalId,
      at: Date.now(),
      kind: "approval",
      approvalKind: "command",
      status: "pending",
      payload: {
        command: "pnpm build && ./node_modules/.bin/tsc --noEmit",
        cwd: "/Users/you/Code/SwarmZ",
        reason: "Verify the change type-checks and builds",
      },
    });
  }
  return approvalId;
}

function seedQueue(sessionId: string, n = 3): void {
  for (let i = 0; i < n; i++) {
    seedApproval(sessionId, i % 2 === 0 ? "command" : "fileChange");
  }
}

function seedCrossSession(): string {
  const id = seedSession({ name: "db-migration", projectDir: "/Users/you/Code/api" });
  seedApproval(id, "command");
  return id;
}

// ---- performance seeds (rendering-only, no backend) ----

/**
 * Append `n` mixed transcript items to one session — user/assistant (markdown)
 * / command / plan, with a large fileChange diff mixed in every ~12th item —
 * for the long-thread scroll + virtualization check. The store caps at 500
 * items/session, so a big `n` exercises the cap path too.
 */
function seedLongThread(sessionId: string, n = 1200): void {
  const store = useVibe.getState();
  const base = Date.now();
  for (let i = 0; i < n; i++) {
    const at = base + i;
    const idp = `${i}-${nanoid(4)}`;
    const mod = i % 12;
    if (mod === 0) {
      store.upsertItem(sessionId, {
        id: `u-${idp}`,
        at,
        kind: "user",
        text: `Step ${i}: continue with the plan and keep going.`,
      });
    } else if (mod <= 6) {
      store.upsertItem(sessionId, {
        id: `a-${idp}`,
        at,
        kind: "assistant",
        text: `Working on step ${i}. Here is **what** changed and \`why\`:\n\n- adjusted the parser\n- added a guard\n\nDone for now.`,
      });
    } else if (mod === 7 || mod === 8) {
      store.upsertItem(sessionId, {
        id: `c-${idp}`,
        at,
        kind: "command",
        command: `pnpm test --filter step-${i}`,
        status: "completed",
        exitCode: i % 5 === 0 ? 1 : 0,
        output:
          Array.from({ length: 40 }, (_, k) => `log line ${k} for step ${i}`).join("\n") + "\n",
      });
    } else if (mod === 9) {
      const { changes } = buildBigDiff(8, 120);
      store.upsertItem(sessionId, {
        id: `fc-${idp}`,
        at,
        kind: "fileChange",
        status: "completed",
        changes,
      });
    } else {
      store.upsertItem(sessionId, {
        id: `p-${idp}`,
        at,
        kind: "plan",
        explanation: `Plan revision ${i}`,
        steps: [
          { step: "analyze", status: "completed" },
          { step: "implement", status: "in_progress" },
          { step: "verify", status: "pending" },
        ],
      });
    }
  }
}

/** Create `n` sessions (newest-first), each with a little history, return ids. */
function seedManySessions(n = 6, itemsEach = 40): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = seedSession({ name: `session-${i + 1}`, projectDir: `/Users/you/Code/proj-${i + 1}` });
    seedLongThread(id, itemsEach);
    ids.push(id);
  }
  return ids;
}

/**
 * Simulate concurrent streaming: append a live assistant item to each id and
 * grow it on an interval (mirrors the controller's per-session store writes).
 * Returns stop() which clears the timer and finalizes the items.
 */
function seedStreaming(ids: string[], everyMs = 60): () => void {
  const store = useVibe.getState();
  const itemIds = new Map<string, string>();
  for (const id of ids) {
    const iid = `stream-${nanoid(5)}`;
    itemIds.set(id, iid);
    store.upsertItem(id, { id: iid, at: Date.now(), kind: "assistant", text: "", streaming: true });
    store.setBusy(id, true);
  }
  const timer = setInterval(() => {
    for (const id of ids) {
      const iid = itemIds.get(id);
      if (!iid) continue;
      const cur = useVibe.getState().sessions[id]?.items[iid];
      const text = (cur && cur.kind === "assistant" ? cur.text : "") + "word ";
      store.patchItem(id, iid, { text });
    }
  }, everyMs);
  return () => {
    clearInterval(timer);
    for (const id of ids) {
      const iid = itemIds.get(id);
      if (!iid) continue;
      store.patchItem(id, iid, { streaming: false });
      store.setBusy(id, false);
    }
  };
}

/** Time N builds of the exact persist snapshot the ~800 ms debounce writes. */
function benchSnapshot(iterations = 20): { ms: number; sessions: number; items: number } {
  const s = useVibe.getState();
  const items = s.order.reduce((n, id) => n + (s.sessions[id]?.order.length ?? 0), 0);
  // warm up
  buildVibePersistSnapshot();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) buildVibePersistSnapshot();
  const ms = (performance.now() - t0) / iterations;
  return { ms, sessions: s.order.length, items };
}

declare global {
  interface Window {
    __vibe?: {
      start: (opts: StartSessionOpts) => Promise<string>;
      send: typeof sendMessage;
      interrupt: typeof interrupt;
      approve: (
        id: string,
        approvalId: string,
        decision: VibeApprovalDecision,
      ) => Promise<void>;
      setAccess: (id: string, access: VibeAccess) => Promise<void>;
      close: typeof closeSession;
      /** the raw session store — for seeding fake sessions/items in dev */
      store: typeof useVibe;
      /** current store snapshot (sessions, order, busy) */
      list: () => {
        order: string[];
        busy: Record<string, boolean>;
        sessions: ReturnType<typeof useVibe.getState>["sessions"];
      };
      /** rendering-only seeds (Phase 4 verification, no backend) */
      seed: {
        session: (opts?: Partial<StartSessionOpts>) => string;
        bigDiff: (id: string, files?: number, linesPerFile?: number) => void;
        approval: (id: string, kind: "command" | "fileChange") => string;
        queue: (id: string, n?: number) => void;
        crossSession: () => string;
        /** n mixed items into one session (long-thread perf check) */
        longThread: (id: string, n?: number) => void;
        /** n sessions with a little history each, returns ids */
        manySessions: (n?: number, itemsEach?: number) => string[];
        /** stream deltas into each id on an interval, returns stop() */
        streaming: (ids: string[], everyMs?: number) => () => void;
      };
      /** perf bench (no backend): time the persist snapshot builder */
      bench: {
        snapshot: (iterations?: number) => { ms: number; sessions: number; items: number };
      };
    };
  }
}

if (import.meta.env.DEV) {
  window.__vibe = {
    start: (opts) => startSession(opts),
    send: sendMessage,
    interrupt,
    approve: (id, approvalId, decision) =>
      respondApproval(id, approvalId, decision),
    setAccess,
    close: closeSession,
    store: useVibe,
    list: () => {
      const s = useVibe.getState();
      return { order: s.order, busy: s.busy, sessions: s.sessions };
    },
    seed: {
      session: seedSession,
      bigDiff: seedBigDiff,
      approval: seedApproval,
      queue: seedQueue,
      crossSession: seedCrossSession,
      longThread: seedLongThread,
      manySessions: seedManySessions,
      streaming: seedStreaming,
    },
    bench: {
      snapshot: benchSnapshot,
    },
  };
}
