import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

/** Pricing USD per million tokens: [input, output, cacheWrite, cacheRead]. */
function pricing(model) {
  const m = (model || "").toLowerCase();
  if (m.includes("opus")) return [15, 75, 18.75, 1.5];
  if (m.includes("haiku")) return [1, 5, 1.25, 0.1];
  return [3, 15, 3.75, 0.3]; // sonnet + default
}

export function claudeProjectsDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

/** Claude encodes a cwd as the dir name by replacing every `/` and `.` with `-`. */
function encodeProjectDir(cwd) {
  return cwd.replace(/[/.]/g, "-");
}

async function parseFile(filePath, sinceMs = null) {
  const session = {
    session_id: path.basename(filePath, ".jsonl"),
    cwd: null,
    primary_model: null,
    service_tier: null,
    git_branch: null,
    last_activity: null,
    message_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: 0,
    by_model: [],
  };
  const models = new Map();

  let stream;
  try {
    stream = fs.createReadStream(filePath, { encoding: "utf8" });
  } catch {
    return session;
  }

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      let v;
      try {
        v = JSON.parse(line);
      } catch {
        continue;
      }
      if (v.type !== "assistant") {
        if (!session.cwd && typeof v.cwd === "string") session.cwd = v.cwd;
        if (!session.git_branch && v.gitBranch) session.git_branch = v.gitBranch;
        continue;
      }
      const msg = v.message;
      if (!msg || !msg.usage) continue;
      const u = msg.usage;
      if (sinceMs != null) {
        const ts = v.timestamp ? Date.parse(v.timestamp) : 0;
        if (!(ts >= sinceMs)) continue;
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

      session.input_tokens += inp;
      session.output_tokens += out;
      session.cache_creation_tokens += cc;
      session.cache_read_tokens += cr;
      session.message_count += 1;
      if (u.service_tier) session.service_tier = u.service_tier;
      if (v.timestamp) session.last_activity = v.timestamp;
      if (!session.cwd && typeof v.cwd === "string") session.cwd = v.cwd;
    }
  } finally {
    rl.close();
  }

  const byModel = [...models.values()];
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

// mtime-keyed cache so we don't re-read unchanged files
const cache = new Map(); // path -> { mtime, usage }

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
      let mt = 0;
      try {
        mt = fs.statSync(p).mtimeMs;
      } catch {
        continue;
      }
      let session;
      const cached = cache.get(p);
      if (cached && cached.mtime === mt) {
        session = cached.usage;
      } else {
        session = await parseFile(p);
        cache.set(p, { mtime: mt, usage: session });
      }
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
