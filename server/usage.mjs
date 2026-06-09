import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Fallback pricing USD per million tokens: [input, output, cacheWrite, cacheRead].
 * Only used while the live OpenRouter catalog hasn't loaded (e.g. offline) or
 * for model ids it doesn't know.
 */
function fallbackPricing(model) {
  const m = (model || "").toLowerCase();
  if (m.includes("fable")) return [10, 50, 12.5, 1];
  if (m.includes("opus")) return [5, 25, 6.25, 0.5];
  if (m.includes("haiku")) return [1, 5, 1.25, 0.1];
  return [3, 15, 3.75, 0.3]; // sonnet + default
}

// Live pricing from the free, key-less OpenRouter model catalog, keyed by
// normalized model id (vendor prefix stripped, dots → dashes, no `[1m]` or
// date-snapshot suffix). Refreshed daily; retried hourly after a failure.
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const PRICING_TTL_MS = 24 * 60 * 60 * 1000;
const PRICING_RETRY_MS = 60 * 60 * 1000;
let livePricing = null; // Map<string, [input, output, cacheWrite, cacheRead]>
let pricingFetchedAt = -Infinity;
let pricingFetch = null;

function normalizeModelId(id) {
  return id
    .toLowerCase()
    .replace(/\[1m\]$/, "")
    .replace(/-\d{8}$/, "") // date-suffixed snapshot ids
    .replaceAll(".", "-");
}

async function fetchLivePricing() {
  const res = await fetch(OPENROUTER_MODELS_URL);
  if (!res.ok) throw new Error(`openrouter: HTTP ${res.status}`);
  const { data } = await res.json();
  const map = new Map();
  for (const m of data ?? []) {
    if (!m?.id?.startsWith("anthropic/")) continue;
    const p = m.pricing ?? {};
    const perMTok = (v) => Number(v) * 1_000_000;
    const input = perMTok(p.prompt);
    const output = perMTok(p.completion);
    if (!(input >= 0) || !(output >= 0)) continue; // skips NaN and "-1" entries
    const cw = perMTok(p.input_cache_write);
    const cr = perMTok(p.input_cache_read);
    map.set(normalizeModelId(m.id.slice("anthropic/".length)), [
      input,
      output,
      cw >= 0 ? cw : input * 1.25,
      cr >= 0 ? cr : input * 0.1,
    ]);
  }
  if (map.size === 0) throw new Error("openrouter: no anthropic models");
  return map;
}

function refreshPricing() {
  const ttl = livePricing ? PRICING_TTL_MS : PRICING_RETRY_MS;
  if (pricingFetch || Date.now() - pricingFetchedAt < ttl) return;
  pricingFetchedAt = Date.now();
  pricingFetch = fetchLivePricing()
    .then((map) => {
      // no cache invalidation needed: costs are recomputed from the cached
      // token counters on every read, so the new table applies immediately
      livePricing = map;
    })
    .catch(() => {})
    .finally(() => {
      pricingFetch = null;
    });
}

refreshPricing();

/** Pricing USD per million tokens: [input, output, cacheWrite, cacheRead]. */
function pricing(model) {
  refreshPricing();
  return livePricing?.get(normalizeModelId(model || "")) ?? fallbackPricing(model);
}

/**
 * The JSONL stores the bare model id even for 1M-context sessions, so the
 * window size has to be inferred: explicit `[1m]` suffix, the user's global
 * default model being the `[1m]` variant of this model, or an observed
 * context that simply doesn't fit into 200k.
 */
function readSettingsModel() {
  try {
    const p = path.join(os.homedir(), ".claude", "settings.json");
    return JSON.parse(fs.readFileSync(p, "utf8")).model ?? null;
  } catch {
    return null;
  }
}

function contextLimit(model, settingsModel, contextTokens) {
  const m = model || "";
  if (m.includes("[1m]")) return 1_000_000;
  if (settingsModel?.includes("[1m]") && settingsModel.startsWith(m)) {
    return 1_000_000;
  }
  if (contextTokens > 200_000) return 1_000_000;
  return 200_000;
}

export function claudeProjectsDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

/** Claude encodes a cwd as the dir name by replacing every `/` and `.` with `-`. */
function encodeProjectDir(cwd) {
  return cwd.replace(/[/.]/g, "-");
}

// ---- Incremental per-file parsing ----
//
// Session files are append-only JSONL, so we remember how many bytes of
// complete lines were already consumed per (file, since-filter) and only
// parse what was appended since the previous call. Costs and the by_model
// breakdown are derived from the running counters on every call, so live
// pricing updates apply without invalidating cached state.
const parseCache = new Map(); // `${path}\0${sinceMs}` -> ParseState

function newParseState(filePath) {
  return {
    mtime: 0,
    size: -1,
    offset: 0, // bytes consumed so far (always ends on a line boundary)
    models: new Map(),
    session: {
      session_id: path.basename(filePath, ".jsonl"),
      cwd: null,
      primary_model: null,
      service_tier: null,
      git_branch: null,
      last_activity: null,
      context_tokens: 0,
      context_limit: 200_000,
      message_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      cost_usd: 0,
      by_model: [],
    },
  };
}

function processLine(line, state, sinceMs, settingsModel) {
  const { session, models } = state;
  let v;
  try {
    v = JSON.parse(line);
  } catch {
    return;
  }
  if (v.type !== "assistant") {
    if (!session.cwd && typeof v.cwd === "string") session.cwd = v.cwd;
    if (!session.git_branch && v.gitBranch) session.git_branch = v.gitBranch;
    return;
  }
  const msg = v.message;
  if (!msg || !msg.usage) return;
  const u = msg.usage;
  if (sinceMs != null) {
    const ts = v.timestamp ? Date.parse(v.timestamp) : 0;
    if (!(ts >= sinceMs)) return;
  }
  const model = msg.model || "unknown";
  const inp = u.input_tokens || 0;
  const out = u.output_tokens || 0;
  const cc = u.cache_creation_input_tokens || 0;
  const cr = u.cache_read_input_tokens || 0;

  let e = models.get(model);
  if (!e) {
    e = {
      model,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      message_count: 0,
      cost_usd: 0,
    };
    models.set(model, e);
  }
  e.input_tokens += inp;
  e.output_tokens += out;
  e.cache_creation_tokens += cc;
  e.cache_read_tokens += cr;
  e.message_count += 1;

  // context occupancy: full prompt of the latest main-chain turn.
  // Sidechain (subagent) turns run in their own, smaller context.
  if (v.isSidechain !== true) {
    session.context_tokens = inp + cc + cr;
    session.context_limit = contextLimit(
      model,
      settingsModel,
      session.context_tokens,
    );
  }

  session.input_tokens += inp;
  session.output_tokens += out;
  session.cache_creation_tokens += cc;
  session.cache_read_tokens += cr;
  session.message_count += 1;
  if (u.service_tier) session.service_tier = u.service_tier;
  if (v.timestamp) session.last_activity = v.timestamp;
  if (!session.cwd && typeof v.cwd === "string") session.cwd = v.cwd;
}

/** Snapshot of the accumulated state with costs / by_model / primary recomputed. */
function finalize(state) {
  const session = { ...state.session };
  const byModel = [...state.models.values()].map((m) => ({ ...m }));
  session.cost_usd = 0;
  for (const m of byModel) {
    const [i, o, cw, cr] = pricing(m.model);
    m.cost_usd =
      (m.input_tokens * i +
        m.output_tokens * o +
        m.cache_creation_tokens * cw +
        m.cache_read_tokens * cr) /
      1_000_000;
    session.cost_usd += m.cost_usd;
  }
  byModel.sort((a, b) => b.cost_usd - a.cost_usd);
  const top = byModel.reduce(
    (best, m) => (!best || m.message_count > best.message_count ? m : best),
    null,
  );
  if (top) session.primary_model = top.model;
  session.by_model = byModel;
  return session;
}

/** Read bytes [offset, size) of a file; resolves short reads. */
function readAppended(filePath, offset, size) {
  const len = size - offset;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(filePath, "r");
  try {
    let read = 0;
    while (read < len) {
      const n = fs.readSync(fd, buf, read, len - read, offset + read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

async function parseFile(filePath, sinceMs = null) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    return finalize(newParseState(filePath));
  }
  const key = `${filePath}\0${sinceMs ?? ""}`;
  let state = parseCache.get(key);
  // a shrunken file was truncated or replaced — start over
  if (state && st.size < state.offset) state = undefined;
  if (!state) {
    state = newParseState(filePath);
    parseCache.set(key, state);
  }

  if (state.mtime !== st.mtimeMs || state.size !== st.size) {
    if (st.size > state.offset) {
      let bytes;
      try {
        bytes = readAppended(filePath, state.offset, st.size);
      } catch {
        bytes = null;
      }
      if (bytes) {
        // only consume complete lines; a partially-written tail line is
        // picked up on a later call once its newline arrives
        const lastNl = bytes.lastIndexOf(0x0a);
        if (lastNl !== -1) {
          const settingsModel = readSettingsModel();
          for (const line of bytes.subarray(0, lastNl + 1).toString("utf8").split("\n")) {
            if (line) processLine(line, state, sinceMs, settingsModel);
          }
          state.offset += lastNl + 1;
        }
      }
    }
    state.mtime = st.mtimeMs;
    state.size = st.size;
  }
  return finalize(state);
}

function newestSessionForDir(cwd) {
  const dir = path.join(claudeProjectsDir(), encodeProjectDir(cwd));
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let newest = null;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const p = path.join(dir, name);
    let mt = 0;
    try {
      mt = fs.statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (!newest || mt > newest.mt) newest = { mt, p };
  }
  return newest ? newest.p : null;
}

export async function usageForDir(cwd) {
  const p = newestSessionForDir(cwd);
  if (!p) return null;
  return parseFile(p);
}

/** Newest session file in `dir` born at/after `sinceMs` (i.e. ours, not history). */
function pickNewSession(dir, sinceMs) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const floor = sinceMs - 3000; // small clock-skew tolerance
  let newest = null;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const p = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.birthtimeMs < floor) continue; // pre-existing session — not ours
    if (!newest || st.mtimeMs > newest.mt) newest = { mt: st.mtimeMs, p };
  }
  return newest ? newest.p : null;
}

/** Usage for a single SwarmZ-launched session only. */
export async function usageForSession(cwd, sinceMs, sessionId) {
  const dir = path.join(claudeProjectsDir(), encodeProjectDir(cwd));
  let p = null;
  if (sessionId) {
    const candidate = path.join(dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) p = candidate;
  }
  if (!p) p = pickNewSession(dir, sinceMs);
  if (!p) return null;
  return parseFile(p, sinceMs);
}

export async function usageTotals() {
  const totals = {
    total_cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    message_count: 0,
    session_count: 0,
    by_model: [],
  };
  const root = claudeProjectsDir();
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return totals;
  }
  const models = new Map();

  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    const dirPath = path.join(root, d.name);
    let files;
    try {
      files = fs.readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const p = path.join(dirPath, name);
      const session = await parseFile(p); // incremental — cheap when unchanged
      if (session.message_count === 0) continue;

      totals.session_count += 1;
      totals.input_tokens += session.input_tokens;
      totals.output_tokens += session.output_tokens;
      totals.cache_creation_tokens += session.cache_creation_tokens;
      totals.cache_read_tokens += session.cache_read_tokens;
      totals.message_count += session.message_count;
      totals.total_cost_usd += session.cost_usd;

      for (const m of session.by_model) {
        let e = models.get(m.model);
        if (!e) {
          e = {
            model: m.model,
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            message_count: 0,
            cost_usd: 0,
          };
          models.set(m.model, e);
        }
        e.input_tokens += m.input_tokens;
        e.output_tokens += m.output_tokens;
        e.cache_creation_tokens += m.cache_creation_tokens;
        e.cache_read_tokens += m.cache_read_tokens;
        e.message_count += m.message_count;
        e.cost_usd += m.cost_usd;
      }
    }
  }

  totals.by_model = [...models.values()].sort((a, b) => b.cost_usd - a.cost_usd);
  return totals;
}
