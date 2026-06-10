import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import nodePty from "node-pty";
import {
  usageForDir,
  usageForSession,
  usageTotals,
  claudeProjectsDir,
} from "./usage.mjs";

const { spawn } = nodePty;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SWARMZ_PORT || process.env.PORT || 4178);
const DIST = path.join(__dirname, "..", "dist");

const app = express();

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.get("/api/home", (_req, res) => res.json({ home: os.homedir() }));

app.get("/api/usage/totals", async (_req, res) => {
  res.json(await usageTotals());
});

app.get("/api/usage/dir", async (req, res) => {
  const cwd = String(req.query.cwd || "");
  if (!cwd) return res.json(null);
  res.json(await usageForDir(cwd));
});

app.get("/api/usage/session", async (req, res) => {
  const cwd = String(req.query.cwd || "");
  const since = Number(req.query.since || 0);
  const sid = req.query.sid ? String(req.query.sid) : undefined;
  const exclude = req.query.exclude
    ? String(req.query.exclude).split(",").filter(Boolean)
    : [];
  if (!cwd) return res.json(null);
  res.json(await usageForSession(cwd, since, sid, exclude));
});

// directory browser for the web folder-picker
app.get("/api/fs/list", (req, res) => {
  const target = req.query.path ? String(req.query.path) : os.homedir();
  let resolved = path.resolve(target);
  let entries = [];
  try {
    entries = fs
      .readdirSync(resolved, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => ({ name: d.name, path: path.join(resolved, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return res.status(400).json({ error: "cannot read directory" });
  }
  const parent = path.dirname(resolved);
  res.json({
    path: resolved,
    parent: parent === resolved ? null : parent,
    home: os.homedir(),
    entries,
  });
});

// ---- read-only git status for agent panes ----
// Keep the queries and parsing in sync with src-tauri/src/git.rs (native backend).
function gitRun(cwd, args, bin = "git") {
  return new Promise((resolve) => {
    execFile(bin, ["-C", cwd, ...args], { timeout: 4000 }, (err, stdout) =>
      resolve(err ? null : stdout.trim()),
    );
  });
}

// git@host:user/repo.git / ssh://git@host/user/repo.git → browsable https URL
function gitRemoteToHttps(remote) {
  const r = (remote || "").trim();
  let url = null;
  if (r.startsWith("git@")) {
    const i = r.indexOf(":");
    if (i > 0) url = `https://${r.slice(4, i)}/${r.slice(i + 1)}`;
  } else if (r.startsWith("ssh://")) {
    url = "https://" + r.slice(6).replace(/^git@/, "");
  } else if (r.startsWith("http://") || r.startsWith("https://")) {
    url = r;
  }
  return url ? url.replace(/\/+$/, "").replace(/\.git$/, "") : null;
}

app.get("/api/git", async (req, res) => {
  const cwd = String(req.query.cwd || "");
  if (!cwd) return res.json(null);
  // optional git binary override (Settings → Paths)
  const bin = String(req.query.bin || "").trim() || "git";
  const toplevel = await gitRun(cwd, ["rev-parse", "--show-toplevel"], bin);
  if (!toplevel) return res.json(null);

  const [branchRef, numstat, untrackedList, remote] = await Promise.all([
    gitRun(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], bin),
    // staged + unstaged line counts vs HEAD; fails on a repo without commits → 0/0
    gitRun(cwd, ["diff", "--numstat", "HEAD"], bin),
    gitRun(cwd, ["ls-files", "--others", "--exclude-standard"], bin),
    gitRun(cwd, ["remote", "get-url", "origin"], bin),
  ]);
  // detached HEAD → short SHA; unborn branch (fresh repo) has neither
  const branch =
    branchRef ||
    (await gitRun(cwd, ["rev-parse", "--short", "HEAD"], bin)) ||
    "(no commits)";

  let insertions = 0;
  let deletions = 0;
  for (const line of (numstat || "").split("\n")) {
    if (!line) continue;
    const [a, d] = line.split("\t");
    // binary files report "-" in both columns → count as 0
    insertions += Number.parseInt(a, 10) || 0;
    deletions += Number.parseInt(d, 10) || 0;
  }

  res.json({
    repo: path.basename(toplevel),
    branch,
    insertions,
    deletions,
    untracked: (untrackedList || "").split("\n").filter(Boolean).length,
    remote_url: gitRemoteToHttps(remote),
  });
});

// ---- Claude subscription limits (5h / 7d windows) ----
// Claude Code stores its OAuth credentials in the macOS Keychain
// ("Claude Code-credentials"); on other setups a plain file exists at
// ~/.claude/.credentials.json. Both hold {"claudeAiOauth":{"accessToken":…}}.
function readKeychainCredentials() {
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      (err, stdout) => resolve(err ? null : stdout.trim() || null),
    );
  });
}

async function readClaudeAccessToken() {
  let raw = null;
  if (process.platform === "darwin") raw = await readKeychainCredentials();
  if (!raw) {
    try {
      raw = fs.readFileSync(
        path.join(os.homedir(), ".claude", ".credentials.json"),
        "utf8",
      );
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(raw)?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

// `null` body means "no Claude login on this machine" (UI hides the meters);
// transient problems (network, non-2xx, parse) respond 502 so the frontend
// can keep showing the last known values instead of blanking out.
app.get("/api/limits", async (_req, res) => {
  try {
    const token = await readClaudeAccessToken();
    if (!token) return res.json(null);
    const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return res.status(502).json({ error: `usage endpoint returned ${r.status}` });
    const data = await r.json();
    res.json({
      five_hour: data.five_hour ?? null,
      seven_day: data.seven_day ?? null,
      seven_day_sonnet: data.seven_day_sonnet ?? null,
      seven_day_opus: data.seven_day_opus ?? null,
    });
  } catch (e) {
    res.status(502).json({ error: String(e?.message ?? e) });
  }
});

// live usage stream (SSE)
app.get("/api/usage/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(": connected\n\n");
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  const onChange = (dirs) =>
    res.write(`event: changed\ndata: ${JSON.stringify({ dirs })}\n\n`);
  usageWatchers.add(onChange);
  req.on("close", () => {
    clearInterval(ping);
    usageWatchers.delete(onChange);
  });
});

// static frontend (production); in dev, Vite proxies /api + /ws here
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  // SPA fallback — Express 5 rejects "*" routes, so use a terminal middleware.
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    res.sendFile(path.join(DIST, "index.html"));
  });
}

const server = http.createServer(app);

// ---- usage file watcher → fan out to SSE clients ----
const usageWatchers = new Set();
(function startUsageWatch() {
  const dir = claudeProjectsDir();
  if (!fs.existsSync(dir)) return;
  let timer = null;
  // collect the project-dir names touched during the debounce window so the
  // frontend can skip refreshes for sessions it isn't displaying
  let pendingDirs = new Set();
  try {
    fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (filename) {
        const seg = String(filename).split(path.sep)[0];
        if (seg) pendingDirs.add(seg);
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const dirs = [...pendingDirs];
        pendingDirs = new Set();
        for (const w of usageWatchers) w(dirs);
      }, 500);
    });
  } catch (e) {
    console.error("usage watch failed:", e.message);
  }
})();

// ---- PTY over WebSocket ----
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  /** @type {Map<string, import('node-pty').IPty>} */
  const ptys = new Map();

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === "spawn") {
      if (ptys.has(msg.id)) return;
      const shell = process.env.SHELL || "/bin/zsh";
      const cwd =
        msg.cwd && fs.existsSync(msg.cwd) ? msg.cwd : os.homedir();
      let term;
      try {
        term = spawn(shell, ["-i", "-l"], {
          name: "xterm-256color",
          cols: msg.cols || 80,
          rows: msg.rows || 24,
          cwd,
          env: {
            ...process.env,
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
            SWARMZ: "1",
            // makes Claude Code emit OSC 9;4 progress (busy/idle status dot);
            // least invasive support marker — see src-tauri/src/pty.rs
            ConEmuANSI: "ON",
          },
        });
      } catch (e) {
        send({ t: "data", id: msg.id, data: b64(`\r\n[spawn failed: ${e.message}]\r\n`) });
        send({ t: "exit", id: msg.id });
        return;
      }
      ptys.set(msg.id, term);
      // coalesce output bursts (≤12 ms / 128 KiB) into one WS message so the
      // browser isn't woken for every tiny chunk a TUI redraw produces
      let pending = [];
      let pendingLen = 0;
      let flushTimer = null;
      const flush = () => {
        flushTimer = null;
        if (!pendingLen) return;
        const data = pending.join("");
        pending = [];
        pendingLen = 0;
        send({ t: "data", id: msg.id, data: b64(data) });
      };
      term.onData((d) => {
        pending.push(d);
        pendingLen += d.length;
        if (pendingLen >= 128 * 1024) {
          if (flushTimer) clearTimeout(flushTimer);
          flush();
        } else if (!flushTimer) {
          flushTimer = setTimeout(flush, 12);
        }
      });
      term.onExit(() => {
        if (flushTimer) clearTimeout(flushTimer);
        flush();
        ptys.delete(msg.id);
        send({ t: "exit", id: msg.id });
      });
      if (msg.startup && msg.startup.trim()) {
        // `clear` wipes the screen + scrollback so the pane boots straight into
        // the program (no shell prompt / typed-command echo left visible).
        const line = `clear; ${msg.startup}`;
        setTimeout(() => {
          try {
            term.write(line + "\r");
          } catch {
            /* gone */
          }
        }, 700);
      }
    } else if (msg.t === "input") {
      ptys.get(msg.id)?.write(msg.data);
    } else if (msg.t === "resize") {
      try {
        ptys.get(msg.id)?.resize(msg.cols, msg.rows);
      } catch {
        /* ignore */
      }
    } else if (msg.t === "kill") {
      const term = ptys.get(msg.id);
      if (term) {
        ptys.delete(msg.id);
        try {
          term.kill();
        } catch {
          /* ignore */
        }
      }
    }
  });

  ws.on("close", () => {
    for (const term of ptys.values()) {
      try {
        term.kill();
      } catch {
        /* ignore */
      }
    }
    ptys.clear();
  });
});

function b64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  SwarmZ engine running → http://localhost:${PORT}\n`);
});
