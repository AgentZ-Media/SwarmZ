// Main-thread client for the diff worker pool (diff-worker.ts). Two workers is
// plenty for our load (t3code caps at 6; we render one diff card at a time per
// visible session). Lazily spawned on first use so grid-only users never pay
// for it. Requests are deduped in-flight by cache key and resolved bundles are
// briefly LRU-cached on the main thread too, so toggling a card collapsed/open
// re-highlights instantly. Everything degrades to plain rendering on failure —
// the DiffView `data` path never needs this module.

import type { DiffData } from "./diff";

type Bundle = unknown;

interface WorkerMsg {
  id: number;
  bundle?: Bundle;
  error?: string;
}

interface Waiter {
  resolve: (b: Bundle) => void;
  reject: (e: Error) => void;
}

const POOL_SIZE = 2;
const RESULT_LRU_MAX = 40;

let workers: Worker[] | null = null;
let rr = 0;
let seq = 0;
const waiters = new Map<number, Waiter>();
const resultCache = new Map<string, Bundle>();
const inflight = new Map<string, Promise<Bundle>>();

function spawn(): Worker {
  const w = new Worker(new URL("./diff-worker.ts", import.meta.url), {
    type: "module",
  });
  w.onmessage = (e: MessageEvent<WorkerMsg>) => {
    const { id, bundle, error } = e.data;
    const waiter = waiters.get(id);
    if (!waiter) return;
    waiters.delete(id);
    if (error) waiter.reject(new Error(error));
    else waiter.resolve(bundle);
  };
  w.onerror = () => {
    /* individual requests time out / reject via their own path */
  };
  return w;
}

function pool(): Worker[] {
  if (!workers) {
    workers = Array.from({ length: POOL_SIZE }, spawn);
  }
  return workers;
}

function post(key: string, data: DiffData, mode: "unified" | "split"): Promise<Bundle> {
  const ws = pool();
  const worker = ws[rr % ws.length];
  rr = (rr + 1) % ws.length;
  const id = ++seq;
  return new Promise<Bundle>((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    worker.postMessage({ id, key, data, mode, highlight: true });
  });
}

/**
 * Request a highlighted bundle for one diff. `key` is the FNV diff hash — the
 * same input always returns the same bundle (main + worker LRU). Resolves with
 * a bundle to feed `DiffFile._mergeFullBundle`; rejects on parse failure so the
 * caller stays on the plain path.
 */
export function requestDiffBundle(
  key: string,
  data: DiffData,
  mode: "unified" | "split" = "unified",
): Promise<Bundle> {
  const ck = `${key}:${mode}`;
  const cached = resultCache.get(ck);
  if (cached) {
    resultCache.delete(ck);
    resultCache.set(ck, cached);
    return Promise.resolve(cached);
  }
  const pending = inflight.get(ck);
  if (pending) return pending;
  const p = post(key, data, mode)
    .then((bundle) => {
      resultCache.set(ck, bundle);
      if (resultCache.size > RESULT_LRU_MAX) {
        const oldest = resultCache.keys().next().value;
        if (oldest !== undefined) resultCache.delete(oldest);
      }
      inflight.delete(ck);
      return bundle;
    })
    .catch((err) => {
      inflight.delete(ck);
      throw err;
    });
  inflight.set(ck, p);
  return p;
}
