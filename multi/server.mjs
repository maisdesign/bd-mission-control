#!/usr/bin/env node
// Mission Control generale — zero dipendenze.
// Legge il registro delle sessioni Claude Code vive (sessions/<pid>.json di ogni profilo),
// raggruppa per progetto e serve una shell con navbar a etichette; ogni tab ospita il pannello
// bd-mission-control originale alimentato da un `bd export` fresco (mai --all, mai nel repo).
// Vive in multi/ dentro il repo bd-mission-control e usa il pannello costruito in ../dist.
// sessionRoots copre sia <profilo>/sessions sia <profilo>/.runtime/sessions; profileLabel toglie
// il segmento ".runtime" dall'etichetta del profilo.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();

function loadConfig() {
  const defaults = {
    port: 4747,
    host: "127.0.0.1",
    sessionRoots: [
      path.join(HOME, "MultiCliProfiles", "*", "*", "sessions"),
      path.join(HOME, "MultiCliProfiles", "*", "*", ".runtime", "sessions"),
      path.join(HOME, ".claude", "sessions"),
    ],
    panelPaths: [
      // vendor/ (ignorata da Git) permette di fissare una copia del pannello; altrimenti quello del repo.
      path.join(HERE, "vendor", "orchestration.html"),
      path.join(HERE, "..", "dist", "orchestration.html"),
    ],
    bd: "bd",
    minExportIntervalMs: 15000,
    exportCacheMs: 30000,
    sessionCacheMs: 2000,
    panelRefreshMs: 10000,
    pinned: [],
    // { "cartella dove si aprono le sessioni": "cartella che contiene .beads" } quando il tracker sta in una sottocartella.
    trackers: {},
    // { "<slug>": "Nome mostrato" } per rinominare una scheda.
    labels: {},
    // true = /api/state non espone percorsi, sessioni Claude e nome del PC (solo progetti e bead).
    hideSessions: false,
    // Cartelle in cui cercare tutti i progetti con un tracker bd (fino a scanDepth livelli), anche senza sessione aperta.
    scanRoots: [],
    scanDepth: 3,
    // Progetti da non mostrare mai (percorso della cartella che contiene .beads), nemmeno con una sessione aperta.
    scanExclude: [],
    scanCacheMs: 60000,
    // Quanti `bd export` al massimo insieme (all'avvio i progetti scoperti sono tanti).
    maxParallelExports: 3,
  };
  const file = path.join(HERE, "mission-control.config.json");
  if (!fs.existsSync(file)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (err) {
    console.error(`Config non valida (${file}): ${err.message} — uso i default`);
    return defaults;
  }
}

const CFG = loadConfig();

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 * 1024, ...opts },
      (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout || ""), stderr: String(stderr || ""), error }));
  });
}

function expandGlob(pattern) {
  const parts = path.resolve(pattern).split(path.sep);
  let bases = [parts.shift() + path.sep];
  for (const part of parts) {
    const next = [];
    for (const base of bases) {
      if (part === "*") {
        let entries = [];
        try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { }
        for (const e of entries) if (e.isDirectory()) next.push(path.join(base, e.name));
      } else {
        const p = path.join(base, part);
        if (fs.existsSync(p)) next.push(p);
      }
    }
    bases = next;
  }
  return bases;
}

function profileLabel(sessionsDir) {
  let parent = path.dirname(sessionsDir);
  if (path.basename(parent) === ".runtime") parent = path.dirname(parent);
  const rel = path.relative(path.join(HOME, "MultiCliProfiles"), parent);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  return path.basename(parent) === ".claude" ? "default" : path.basename(parent);
}

let liveCache = { at: 0, pids: new Set() };
async function livePids() {
  if (Date.now() - liveCache.at < CFG.sessionCacheMs) return liveCache.pids;
  const pids = new Set();
  if (process.platform === "win32") {
    const r = await run("tasklist", ["/FO", "CSV", "/NH", "/FI", "IMAGENAME eq claude.exe"]);
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.match(/^"[^"]+","(\d+)"/);
      if (m) pids.add(Number(m[1]));
    }
  } else {
    const r = await run("ps", ["-eo", "pid=,comm="]);
    for (const line of r.stdout.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m && /claude/i.test(m[2])) pids.add(Number(m[1]));
    }
  }
  liveCache = { at: Date.now(), pids };
  return pids;
}

const normPath = (p) => path.resolve(p).toLowerCase();
const TRACKERS = new Map(Object.entries(CFG.trackers || {}).map(([from, to]) => [normPath(from), path.resolve(to)]));

const PINNED = new Set((CFG.pinned || []).map(normPath));

const rootCache = new Map();
async function resolveProject(cwd) {
  if (rootCache.has(cwd)) return rootCache.get(cwd);
  let beadsRoot = null;
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const mapped = TRACKERS.get(normPath(dir));
    if (mapped) {
      const info = { root: mapped, hasBeads: fs.existsSync(path.join(mapped, ".beads")) };
      rootCache.set(cwd, info);
      return info;
    }
    if (fs.existsSync(path.join(dir, ".beads"))) { beadsRoot = dir; break; }
    if (path.dirname(dir) === dir) break;
  }
  let gitRoot = null;
  const g = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (g.ok && g.stdout.trim()) gitRoot = path.resolve(g.stdout.trim());
  const root = beadsRoot && (!gitRoot || beadsRoot.length >= gitRoot.length) ? beadsRoot : (gitRoot || path.resolve(cwd));
  const info = { root, hasBeads: fs.existsSync(path.join(root, ".beads")) };
  rootCache.set(cwd, info);
  return info;
}

// Firma del DB bd (size + contenuto dei file piccoli, esclusi i lock). Anche `bd export` scrive nel
// journal Dolt, quindi la firma va presa DOPO il nostro export.
async function beadsSignature(root) {
  const base = path.join(root, ".beads");
  const parts = [];
  async function walk(dir, depth) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 8) await walk(p, depth + 1); continue; }
      if (/\.lock$/i.test(e.name) || e.name === "issues.jsonl" || e.name === "last-touched") continue;
      try {
        const st = await fsp.stat(p);
        const small = st.size <= 4096 ? (await fsp.readFile(p)).toString("base64") : "";
        parts.push(`${p}|${st.size}|${small}`);
      } catch { }
    }
  }
  for (const sub of ["embeddeddolt", "dolt"]) await walk(path.join(base, sub), 0);
  if (!parts.length) return null;
  return parts.sort().join("\n");
}

// Progetti con tracker bd sotto scanRoots: cartelle con .beads che contiene un DB (embeddeddolt|dolt).
// Esclusi i worktree git (.git e' un file) e le cartelle di servizio; non scende dentro un progetto trovato.
let scanCache = { at: 0, roots: [] };
async function discoverProjects() {
  if (!(CFG.scanRoots || []).length) return [];
  if (scanCache.at && Date.now() - scanCache.at < CFG.scanCacheMs) return scanCache.roots;
  const excluded = new Set((CFG.scanExclude || []).map(normPath));
  const found = [];
  async function walk(dir, depth) {
    if (excluded.has(normPath(dir))) return;
    const beads = path.join(dir, ".beads");
    if (fs.existsSync(path.join(beads, "embeddeddolt")) || fs.existsSync(path.join(beads, "dolt"))) {
      let isWorktree = false;
      try { isWorktree = fs.statSync(path.join(dir, ".git")).isFile(); } catch { }
      if (!isWorktree) found.push(dir);
      return;
    }
    if (depth >= CFG.scanDepth) return;
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "vendor")
      .map((e) => walk(path.join(dir, e.name), depth + 1)));
  }
  for (const r of CFG.scanRoots) await walk(path.resolve(r), 0);
  scanCache = { at: Date.now(), roots: found.sort() };
  return scanCache.roots;
}

let exportsRunning = 0;
const exportWaiters = [];
async function withExportSlot(fn) {
  if (exportsRunning >= CFG.maxParallelExports) await new Promise((r) => exportWaiters.push(r));
  else exportsRunning++;
  try { return await fn(); } finally {
    const next = exportWaiters.shift();
    if (next) next(); else exportsRunning--;
  }
}

const exportCache = new Map();
async function projectIssues(root) {
  const hit = exportCache.get(root);
  if (hit?.promise) return hit.promise;
  if (hit?.text !== undefined) {
    const age = Date.now() - hit.at;
    if (age < CFG.minExportIntervalMs) return hit;
    if (hit.sig !== null) {
      if ((await beadsSignature(root)) === hit.sig) return hit;
    } else if (age < CFG.exportCacheMs) {
      return hit;
    }
  }
  const promise = (async () => {
    const tmp = path.join(os.tmpdir(), `mission-control-${process.pid}-${Buffer.from(root).toString("hex").slice(-24)}.jsonl`);
    let text = null;
    let source = "bd export";
    if (process.env.MC_DEBUG) console.log(new Date().toISOString(), "bd export", root);
    const r = await withExportSlot(() => run(CFG.bd, ["export", "-o", tmp], { cwd: root }));
    if (r.ok) {
      try { text = await fsp.readFile(tmp, "utf8"); } catch { text = null; }
      fsp.rm(tmp, { force: true }).catch(() => {});
    }
    if (text === null && hit?.text !== undefined) {
      text = hit.text;
      source = "ultimo export (bd occupato, riprovo)";
    }
    if (text === null) {
      source = "issues.jsonl (fallback: bd export fallito)";
      try { text = await fsp.readFile(path.join(root, ".beads", "issues.jsonl"), "utf8"); } catch { text = ""; source = "nessun dato"; }
    }
    const sig = await beadsSignature(root);
    const entry = { at: Date.now(), text, source, counts: countIssues(text), epics: epicList(text), sig: r.ok ? sig : "__retry__" };
    exportCache.set(root, entry);
    return entry;
  })();
  exportCache.set(root, { ...(hit || {}), promise });
  try { return await promise; } catch (err) { exportCache.delete(root); throw err; }
}

function parseIssues(text) {
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let it;
    try { it = JSON.parse(line); } catch { continue; }
    if (it._type && it._type !== "issue") continue;
    items.push({ it, line });
  }
  return items;
}

// Bead di un epic: l'epic stesso, gli id gerarchici (epic.N...) e i discendenti via dipendenze parent-child.
function epicMembers(items, epicId) {
  const inSet = new Set();
  for (const { it } of items) if (it.id === epicId || String(it.id).startsWith(epicId + ".")) inSet.add(it.id);
  for (let grew = true; grew;) {
    grew = false;
    for (const { it } of items) {
      if (inSet.has(it.id)) continue;
      if ((it.dependencies || []).some((d) => d.type === "parent-child" && d.issue_id === it.id && inSet.has(d.depends_on_id))) { inSet.add(it.id); grew = true; }
    }
  }
  return inSet;
}

function filterEpic(entry, epicId) {
  entry.epicCache ??= new Map();
  if (entry.epicCache.has(epicId)) return entry.epicCache.get(epicId);
  const items = parseIssues(entry.text);
  const inSet = epicMembers(items, epicId);
  const text = items.filter(({ it }) => inSet.has(it.id)).map(({ line }) => line).join("\n") + "\n";
  entry.epicCache.set(epicId, text);
  return text;
}

function epicList(text) {
  const items = parseIssues(text);
  return items.filter(({ it }) => it.issue_type === "epic").map(({ it }) => {
    const inSet = epicMembers(items, it.id);
    const e = { id: it.id, title: it.title || "", status: it.status || "open", total: 0, open: 0, in_progress: 0, closed: 0 };
    for (const { it: x } of items) {
      if (!inSet.has(x.id) || x.id === it.id) continue;
      e.total++;
      const st = x.status || "open";
      if (st in e && typeof e[st] === "number") e[st]++;
    }
    return e;
  });
}

function countIssues(text) {
  const c = { total: 0, open: 0, in_progress: 0, blocked: 0, deferred: 0, closed: 0, epics: 0, closedVerified: 0, lastUpdate: null, active: [] };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let it;
    try { it = JSON.parse(line); } catch { continue; }
    if (it._type && it._type !== "issue") continue;
    c.total++;
    if (it.issue_type === "epic") c.epics++;
    const st = it.status || "open";
    if (st in c && typeof c[st] === "number") c[st]++;
    if (st === "closed") {
      const comments = Array.isArray(it.comments) ? it.comments : [];
      if (comments.some((cm) => /^VERIFIED\b.*result=pass/m.test(cm.text || cm.body || ""))) c.closedVerified++;
    }
    if (st === "in_progress") c.active.push({ id: it.id, title: it.title, assignee: it.assignee || "" });
    const u = it.updated_at || it.closed_at || it.created_at;
    if (u && (!c.lastUpdate || u > c.lastUpdate)) c.lastUpdate = u;
  }
  c.active = c.active.slice(0, 6);
  return c;
}

const slugByRoot = new Map();
const rootBySlug = new Map();
function slugFor(root) {
  if (slugByRoot.has(root)) return slugByRoot.get(root);
  const base = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "progetto";
  let slug = base;
  for (let i = 2; rootBySlug.has(slug); i++) slug = `${base}-${i}`;
  slugByRoot.set(root, slug);
  rootBySlug.set(slug, root);
  return slug;
}

async function readSessions() {
  const alive = await livePids();
  const out = [];
  for (const pattern of CFG.sessionRoots) {
    for (const dir of expandGlob(pattern)) {
      let files = [];
      try { files = await fsp.readdir(dir); } catch { continue; }
      for (const f of files) {
        if (!/^\d+\.json$/.test(f)) continue;
        let s;
        try { s = JSON.parse(await fsp.readFile(path.join(dir, f), "utf8")); } catch { continue; }
        if (!s || !s.pid || !s.cwd || !alive.has(Number(s.pid))) continue;
        out.push({
          pid: s.pid, sessionId: s.sessionId, name: s.name || path.basename(s.cwd),
          status: s.status || "unknown", waitingFor: s.waitingFor || "", cwd: s.cwd,
          profile: profileLabel(dir), kind: s.kind || "",
          startedAt: s.startedAt || null, updatedAt: s.statusUpdatedAt || s.updatedAt || null,
        });
      }
    }
  }
  return out;
}

let stateCache = { at: 0, value: null, promise: null };
async function getState() {
  if (stateCache.promise) return stateCache.promise;
  if (stateCache.value && Date.now() - stateCache.at < CFG.sessionCacheMs) return stateCache.value;
  stateCache.promise = (async () => {
    const sessions = await readSessions();
    const byRoot = new Map();
    const resolved = await Promise.all(sessions.map((s) => resolveProject(s.cwd)));
    for (const [i, s] of sessions.entries()) {
      const { root, hasBeads } = resolved[i];
      if (!byRoot.has(root)) byRoot.set(root, { root, hasBeads, sessions: [] });
      byRoot.get(root).sessions.push(s);
    }
    for (const p of CFG.pinned || []) {
      const root = path.resolve(p);
      if (!byRoot.has(root)) byRoot.set(root, { root, hasBeads: fs.existsSync(path.join(root, ".beads")), sessions: [], pinned: true });
    }
    const have = new Set([...byRoot.keys()].map(normPath));
    for (const root of await discoverProjects()) {
      if (!have.has(normPath(root))) byRoot.set(root, { root, hasBeads: true, sessions: [], discovered: true });
    }
    // scanExclude vale per tutto: un progetto escluso non compare nemmeno con una sessione aperta o se fissato.
    for (const ex of CFG.scanExclude || []) for (const root of [...byRoot.keys()]) if (normPath(root) === normPath(ex)) byRoot.delete(root);
    const projects = await Promise.all([...byRoot.values()].map(async (p) => {
      const slug = slugFor(p.root);
      let counts = null, source = null, epics = [];
      if (p.hasBeads) { const data = await projectIssues(p.root); counts = data.counts; source = data.source; epics = data.epics || []; }
      p.sessions.sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0));
      const label = (CFG.labels || {})[slug] || path.basename(p.root);
      const pinned = !!p.pinned || PINNED.has(normPath(p.root));
      if (CFG.hideSessions) return { slug, label, root: "", hasBeads: p.hasBeads, pinned, discovered: !!p.discovered, sessions: [], counts, source, epics };
      return { slug, label, root: p.root, hasBeads: p.hasBeads, pinned, discovered: !!p.discovered, sessions: p.sessions, counts, source, epics };
    }));
    const shown = CFG.hideSessions ? projects.filter((p) => p.hasBeads) : projects;
    shown.sort((a, b) => (b.hasBeads - a.hasBeads) || a.label.localeCompare(b.label, "it"));
    const value = CFG.hideSessions
      ? { generatedAt: new Date().toISOString(), host: "", hideSessions: true, projects: shown }
      : { generatedAt: new Date().toISOString(), host: os.hostname(), hideSessions: false, projects: shown };
    stateCache = { at: Date.now(), value, promise: null };
    return value;
  })();
  try { return await stateCache.promise; } finally { stateCache.promise = null; }
}

function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}

function panelHtml() {
  for (const p of CFG.panelPaths) if (fs.existsSync(p)) return fs.readFileSync(p);
  return null;
}

async function projectConfigJs(root, label, epicTitle) {
  const conf = { title: `${label}${epicTitle ? " · " + epicTitle : ""} mission control`, dataPath: "issues.jsonl", refreshInterval: CFG.panelRefreshMs };
  for (const meta of [path.join(root, "docs", "orchestration.meta.json"), path.join(root, "orchestration.meta.json")]) {
    if (fs.existsSync(meta)) { conf.metaPath = "orchestration.meta.json"; break; }
  }
  return `window.BMC_CONFIG = ${JSON.stringify(conf, null, 2)};\n`;
}

const handler = async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const p = decodeURIComponent(url.pathname);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "metodo non permesso");
    if (p === "/" || p === "/index.html") return send(res, 200, await fsp.readFile(path.join(HERE, "public", "index.html")), "text/html; charset=utf-8");
    // Vecchio indirizzo del pannello a schede (python http.server): porta alla pagina nuova.
    if (p === "/docs/orchestration.html") { res.writeHead(302, { Location: "/", "Cache-Control": "no-store" }); return res.end(); }
    if (p === "/api/state") return send(res, 200, JSON.stringify(await getState()), "application/json; charset=utf-8");
    const m = p.match(/^\/p\/([a-z0-9-]+)\/(.*)$/);
    if (m) {
      await getState();
      const root = rootBySlug.get(m[1]);
      if (!root) return send(res, 404, "progetto sconosciuto");
      const label = (CFG.labels || {})[m[1]] || path.basename(root);
      let rest = m[2];
      let epicId = null;
      const em = rest.match(/^e\/([A-Za-z0-9._-]+)\/(.*)$/);
      if (em) { epicId = em[1]; rest = em[2]; }
      const file = rest || "orchestration.html";
      switch (file) {
        case "orchestration.html": { const html = panelHtml(); return html ? send(res, 200, html, "text/html; charset=utf-8") : send(res, 500, "pannello bd-mission-control non trovato: esegui update-panel.ps1"); }
        case "orchestration.config.js": {
          let epicTitle = "";
          if (epicId) {
            if (!fs.existsSync(path.join(root, ".beads"))) return send(res, 404, "nessun tracker bd");
            const ep = ((await projectIssues(root)).epics || []).find((e) => e.id === epicId);
            if (!ep) return send(res, 404, "epic sconosciuto");
            epicTitle = ep.title || epicId;
          }
          return send(res, 200, await projectConfigJs(root, label, epicTitle), "text/javascript; charset=utf-8");
        }
        case "orchestration-data.js": return send(res, 200, "/* live mode via mission-control */\n", "text/javascript; charset=utf-8");
        case "issues.jsonl": {
          if (!fs.existsSync(path.join(root, ".beads"))) return send(res, 404, "nessun tracker bd");
          const data = await projectIssues(root);
          if (epicId) {
            if (!(data.epics || []).some((e) => e.id === epicId)) return send(res, 404, "epic sconosciuto");
            return send(res, 200, filterEpic(data, epicId), "application/x-ndjson; charset=utf-8");
          }
          return send(res, 200, data.text, "application/x-ndjson; charset=utf-8");
        }
        case "orchestration.meta.json": {
          for (const meta of [path.join(root, "docs", "orchestration.meta.json"), path.join(root, "orchestration.meta.json")]) {
            if (fs.existsSync(meta)) return send(res, 200, await fsp.readFile(meta), "application/json; charset=utf-8");
          }
          return send(res, 404, "{}");
        }
        default: return send(res, 404, "non trovato");
      }
    }
    return send(res, 404, "non trovato");
  } catch (err) {
    console.error(err);
    return send(res, 500, `errore: ${err.message}`);
  }
};

// host puo essere un indirizzo o un elenco (es. ["127.0.0.1", "192.168.0.2"]): un listener per indirizzo.
for (const host of [].concat(CFG.host)) {
  const server = http.createServer(handler);
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") { console.error(`Porta ${CFG.port} già in uso su ${host}`); process.exit(2); }
    if (err.code === "EADDRNOTAVAIL") { console.error(`Indirizzo ${host} non disponibile su questo PC: salto`); return; }
    throw err;
  });
  server.listen(CFG.port, host, () => console.log(`Mission Control → http://${host}:${CFG.port}/`));
}
