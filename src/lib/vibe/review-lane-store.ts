import { create } from "zustand";

export type ReviewLaneStatus = "running" | "completed" | "failed";

export interface ReviewLane {
  id: string;
  sessionId: string;
  projectId: string;
  agentName: string;
  source: "orchestrator" | "auto" | "github" | "mission";
  target: string;
  reviewThreadId: string;
  status: ReviewLaneStatus;
  review: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

interface ReviewLaneState {
  lanes: Record<string, ReviewLane>;
  order: string[];
  start: (lane: Omit<ReviewLane, "status" | "review" | "error" | "finishedAt">) => void;
  complete: (id: string, status: string, review: string | null) => void;
  fail: (id: string, error: string) => void;
  dismiss: (id: string) => void;
  reset: () => void;
}

const MAX_REVIEW_LANES = 24;

export const useReviewLanes = create<ReviewLaneState>((set) => ({
  lanes: {},
  order: [],

  start: (lane) =>
    set((state) => {
      if (state.lanes[lane.id]) return state;
      const lanes = { ...state.lanes };
      lanes[lane.id] = {
        ...lane,
        status: "running",
        review: null,
        error: null,
        finishedAt: null,
      };
      const newest = [lane.id, ...state.order];
      const running = newest.filter((id) => lanes[id]?.status === "running");
      const terminal = newest
        .filter((id) => lanes[id]?.status !== "running")
        .slice(0, MAX_REVIEW_LANES);
      const kept = new Set([...running, ...terminal]);
      const order = newest.filter((id) => kept.has(id));
      for (const id of Object.keys(lanes)) {
        if (!kept.has(id)) delete lanes[id];
      }
      return { lanes, order };
    }),

  complete: (id, status, review) =>
    set((state) => {
      const lane = state.lanes[id];
      if (!lane) return state;
      return {
        lanes: {
          ...state.lanes,
          [id]: {
            ...lane,
            status: status === "completed" ? "completed" : "failed",
            review,
            error: status === "completed" ? null : `Review ended with status ${status}`,
            finishedAt: Date.now(),
          },
        },
      };
    }),

  fail: (id, error) =>
    set((state) => {
      const lane = state.lanes[id];
      if (!lane) return state;
      return {
        lanes: {
          ...state.lanes,
          [id]: {
            ...lane,
            status: "failed",
            error,
            finishedAt: Date.now(),
          },
        },
      };
    }),

  dismiss: (id) =>
    set((state) => {
      const lane = state.lanes[id];
      if (!lane || lane.status === "running") return state;
      const lanes = { ...state.lanes };
      delete lanes[id];
      return { lanes, order: state.order.filter((entry) => entry !== id) };
    }),

  reset: () => set({ lanes: {}, order: [] }),
}));
