function decideSourceMode({ fetchOk, snapshotPresent }) {
  if (fetchOk) {
    return "live";
  }

  if (snapshotPresent) {
    return "snapshot";
  }

  return "demo";
}

function formatSnapshotAge(generatedAt, now = Date.now()) {
  const parsed = Date.parse(generatedAt);
  if (!Number.isFinite(parsed)) {
    return "age unknown";
  }

  const deltaMs = Math.max(0, now - parsed);
  const deltaMinutes = Math.floor(deltaMs / 60000);

  if (deltaMinutes < 1) {
    return "just now";
  }

  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function nextTheme(theme) {
  if (theme === "dark") {
    return "light";
  }

  if (theme === "light") {
    return "auto";
  }

  return "dark";
}

function matchesSearch(card, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) {
    return true;
  }

  const haystack = [
    card?.id,
    card?.label,
    card?.track,
    card?.assignee
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(needle);
}

function applyCardFilters(cards, filters) {
  const statusFilter = filters?.status || "all";
  const trackFilter = filters?.track || "all";
  const query = filters?.query || "";

  return cards.filter((card) => {
    if (statusFilter !== "all" && card.state !== statusFilter) {
      return false;
    }

    if (trackFilter !== "all" && (card.track || "").toUpperCase() !== trackFilter) {
      return false;
    }

    return matchesSearch(card, query);
  });
}

const DEMO_HINT = "no data - run refresh or serve over HTTP";
const DEFAULT_DATA_PATH = "../.beads/issues.jsonl";
const DEFAULT_REFRESH_INTERVAL = 15000;
const THEME_STORAGE_KEY = "bmc-theme";
const SEARCH_DEBOUNCE_MS = 150;

const warnOnceKeys = new Set();

const STATUS_TO_I18N = {
  ready: "filter_ready",
  inprogress: "filter_inprogress",
  blocked: "filter_blocked",
  done: "filter_done",
  deferred: "filter_deferred"
};

const DEMO_ISSUES = [
  {
    id: "demo-1",
    title: "Bootstrap panel controller",
    status: "open",
    priority: 1,
    issue_type: "task",
    assignee: "codex-lavoro",
    labels: ["track:UI", "wave:1", "thinking:medhi"]
  },
  {
    id: "demo-2",
    title: "Derive filtered issue model",
    status: "in_progress",
    priority: 0,
    issue_type: "task",
    assignee: "codex-lavoro",
    labels: ["track:CORE", "wave:1", "thinking:high"]
  },
  {
    id: "demo-3",
    title: "Wire config overlays",
    status: "open",
    priority: 2,
    issue_type: "task",
    assignee: "system",
    labels: ["track:OPS", "wave:2"],
    dependencies: [{ depends_on_id: "demo-2", type: "blocks" }]
  },
  {
    id: "demo-4",
    title: "Snapshot fallback validation",
    status: "closed",
    priority: 3,
    issue_type: "task",
    assignee: "reviewer",
    labels: ["track:QA", "wave:2"],
    comments: [{ text: "VERIFIED result=pass smoke=demo" }]
  },
  {
    id: "demo-5",
    title: "Track chip generation",
    status: "open",
    priority: 2,
    issue_type: "task",
    assignee: "agy",
    labels: ["track:UI", "wave:2"]
  },
  {
    id: "demo-6",
    title: "Manual refresh on demand",
    status: "deferred",
    priority: 4,
    issue_type: "task",
    assignee: "",
    labels: ["track:OPS", "wave:3", "deferred"]
  },
  {
    id: "demo-7",
    title: "Theme toggle persistence",
    status: "closed",
    priority: 2,
    issue_type: "task",
    assignee: "system",
    labels: ["track:UI", "wave:3"]
  },
  {
    id: "demo-8",
    title: "Live fetch telemetry",
    status: "open",
    priority: 2,
    issue_type: "task",
    assignee: "operator",
    labels: ["track:NET"],
    dependencies: [{ depends_on_id: "demo-2", type: "blocks" }]
  }
];

function warnMissingHook(name) {
  if (warnOnceKeys.has(name)) {
    return;
  }

  warnOnceKeys.add(name);
  console.warn(`BMC hook missing: ${name}`);
}

function byId(id) {
  const node = document.getElementById(id);
  if (!node) {
    warnMissingHook(`#${id}`);
  }
  return node;
}

function queryOne(selector, root = document) {
  const node = root.querySelector(selector);
  if (!node) {
    warnMissingHook(selector);
  }
  return node;
}

function setText(node, value) {
  if (node) {
    node.textContent = value;
  }
}

function setDisplay(node, visible) {
  if (node) {
    node.style.display = visible ? "" : "none";
  }
}

function resolveI18nValue(strings, key) {
  if (!key) {
    return "";
  }

  const direct = strings?.[key];
  if (typeof direct === "string") {
    return direct;
  }

  const nested = key.split(".").reduce((value, part) => {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    return value[part];
  }, strings);

  return typeof nested === "string" ? nested : "";
}

function applyI18n(strings, configTitle) {
  const nodes = document.querySelectorAll("[data-i18n]");
  for (const node of nodes) {
    const key = node.getAttribute("data-i18n");
    if (!key) {
      continue;
    }

    const value = key === "title" && configTitle
      ? configTitle
      : resolveI18nValue(strings, key);

    if (!value) {
      continue;
    }

    if (node.tagName === "INPUT") {
      node.setAttribute("placeholder", value);
      continue;
    }

    node.textContent = value;
  }
}

function parseHexAccent(value) {
  if (typeof value !== "string") {
    return null;
  }

  const hex = value.trim().replace(/^#/, "");
  if (!/^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) {
    return null;
  }

  const normalized = hex.length === 3
    ? hex.split("").map((char) => char + char).join("")
    : hex;

  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16)
  ];
}

function applyAccent(accent) {
  if (typeof accent !== "string" || !accent.trim()) {
    return;
  }

  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--bmc-accent", accent);

  const rgb = parseHexAccent(accent);
  if (rgb) {
    rootStyle.setProperty("--bmc-accent-rgb", rgb.join(", "));
  }
}

function getThemeMode() {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "dark" || stored === "light" || stored === "auto" ? stored : "auto";
  } catch {
    return "auto";
  }
}

function setThemeMode(theme) {
  const root = document.documentElement;
  if (theme === "auto") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage is optional for embedded contexts.
  }

  const toggle = byId("themetoggle");
  if (toggle) {
    toggle.setAttribute("data-mode", theme);
    toggle.setAttribute("aria-label", `Theme: ${theme}`);
    toggle.title = `Theme: ${theme}`;
  }
}

function createTrackContainer(toolbar) {
  const existing = document.getElementById("trackchips");
  if (existing) {
    return existing;
  }

  if (!toolbar) {
    return null;
  }

  const container = document.createElement("div");
  container.id = "trackchips";
  container.className = "toolbar-left";
  container.setAttribute("aria-label", "Track filters");
  toolbar.insertAdjacentElement("afterend", container);
  return container;
}

function getStatusLabel(strings, state) {
  const key = STATUS_TO_I18N[state];
  return resolveI18nValue(strings, key) || state.toUpperCase();
}

function getWaveBadge(wave, index) {
  const numeric = /^\d+$/.test(wave.key) ? wave.key : `${index + 1}`;
  return `W${numeric}`;
}

function buildCardView(issue, bead) {
  return {
    id: issue.id,
    state: bead.state,
    phase: bead.phase,
    label: bead.label,
    track: bead.track || "TASK",
    thinking: bead.thinking || "low",
    blockedBy: bead.blockedBy || [],
    assignee: bead.assignee || "unassigned",
    note: bead.note || "",
    flag: bead.flag === true
  };
}

function computeTrackOptions(model) {
  const trackSet = new Set();

  for (const bead of Object.values(model?.beads || {})) {
    if (typeof bead.track === "string" && bead.track) {
      trackSet.add(bead.track.toUpperCase());
    }
  }

  return ["all", ...Array.from(trackSet).sort()];
}

function updateTrackFilters(state) {
  const toolbar = byId("toolbar");
  const container = createTrackContainer(toolbar);
  if (!container) {
    return;
  }

  container.replaceChildren();
  for (const track of state.trackOptions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chip${state.filters.track === track ? " active" : ""}`;
    button.dataset.track = track;
    button.textContent = track === "all" ? "TRACK: ALL" : `TRACK: ${track}`;
    container.appendChild(button);
  }
}

function updateStatusCounts(counts) {
  const mapping = {
    all: "c-all",
    ready: "c-ready",
    inprogress: "c-prog",
    blocked: "c-blocked",
    done: "c-done",
    deferred: "c-deferred"
  };

  for (const [status, id] of Object.entries(mapping)) {
    const node = byId(id);
    if (!node) {
      continue;
    }

    const base = node.dataset.baseLabel || node.textContent || status.toUpperCase();
    node.dataset.baseLabel = base;
    const value = counts?.[status] ?? 0;
    node.textContent = `${base} ${value}`;
  }
}

function renderCards(state) {
  const wavesRoot = byId("waves");
  if (!wavesRoot) {
    return;
  }

  const template = byId("card-tpl") || byId("card-template");
  if (!(template instanceof HTMLTemplateElement)) {
    warnMissingHook("#card-tpl/#card-template");
    return;
  }

  wavesRoot.replaceChildren();
  const model = state.model;
  if (!model) {
    return;
  }

  for (let waveIndex = 0; waveIndex < model.waves.length; waveIndex += 1) {
    const wave = model.waves[waveIndex];
    const cardViews = wave.ids
      .map((id) => {
        const issue = state.issuesById.get(id);
        const bead = model.beads[id];
        return issue && bead ? buildCardView(issue, bead) : null;
      })
      .filter(Boolean);
    const visibleCards = applyCardFilters(cardViews, state.filters);

    if (visibleCards.length === 0) {
      continue;
    }

    const doneCount = visibleCards.filter((card) => card.state === "done").length;
    const waveNode = document.createElement("section");
    waveNode.className = "wave-container";
    waveNode.dataset.wave = wave.key;

    const header = document.createElement("div");
    header.className = "wave-header";

    const badge = document.createElement("span");
    badge.className = "wave-badge";
    badge.textContent = getWaveBadge(wave, waveIndex);

    const title = document.createElement("span");
    title.className = "wave-title";
    title.textContent = wave.title;

    const subtitle = document.createElement("span");
    subtitle.className = "wave-title";
    subtitle.style.fontSize = "0.8rem";
    subtitle.style.opacity = "0.75";
    subtitle.textContent = wave.subtitle || `${doneCount}/${visibleCards.length} done`;

    const progress = document.createElement("span");
    progress.className = "tag";
    progress.textContent = `${doneCount}/${visibleCards.length} done`;

    header.append(badge, title, subtitle, progress);

    const grid = document.createElement("div");
    grid.className = "wave-grid";

    for (const card of visibleCards) {
      const fragment = template.content.cloneNode(true);
      const root = queryOne(".card", fragment);
      if (!root) {
        continue;
      }

      root.classList.add(card.state);
      const idNode = queryOne(".id", fragment);
      if (idNode) {
        idNode.textContent = card.id;
        idNode.dataset.id = card.id;
        idNode.title = `Copy: bd show ${card.id}`;
        idNode.style.cursor = "pointer";
      }

      const pill = queryOne(".stpill", fragment);
      if (pill) {
        pill.className = `stpill stpill-${card.state}`;
        pill.textContent = getStatusLabel(state.strings, card.state);
      }

      const think = queryOne(".think", fragment);
      if (think) {
        think.className = `think ${card.thinking}`;
        think.textContent = card.thinking;
      }

      const titleNode = queryOne(".card-title", fragment);
      setText(titleNode, card.label);

      const descNode = queryOne(".card-desc", fragment);
      setText(descNode, `PHASE ${card.phase}`);

      const trackNode = queryOne(".tag.trk", fragment);
      setText(trackNode, card.track);

      const fileNode = queryOne(".tag.file", fragment);
      setText(fileNode, card.phase);

      const whoNode = queryOne(".who", fragment);
      const whoValue = whoNode ? queryOne(".value", whoNode) : null;
      if (card.state === "inprogress" && whoValue) {
        whoValue.textContent = card.assignee;
        setDisplay(whoNode, true);
      } else {
        setDisplay(whoNode, false);
      }

      const blockerRoot = queryOne(".card-blockers", fragment) || queryOne(".blk", fragment);
      if (blockerRoot) {
        blockerRoot.replaceChildren();
        if (card.blockedBy.length > 0) {
          const label = document.createElement("span");
          label.textContent = `${resolveI18nValue(state.strings, "card_blocked_by") || "BLOCKED BY:"} `;
          blockerRoot.appendChild(label);

          for (let i = 0; i < card.blockedBy.length; i += 1) {
            const blockerId = card.blockedBy[i];
            const blockerIssue = state.issuesById.get(blockerId);
            const node = document.createElement("span");
            const shortTitle = blockerIssue?.title ? ` ${blockerIssue.title}` : "";
            node.textContent = `${blockerId}${shortTitle ? ` - ${shortTitle}` : ""}`;
            blockerRoot.appendChild(node);
            if (i < card.blockedBy.length - 1) {
              blockerRoot.appendChild(document.createTextNode(", "));
            }
          }

          blockerRoot.className = "blk";
          setDisplay(blockerRoot, true);
        } else {
          setDisplay(blockerRoot, false);
        }
      }

      const warningRoot = queryOne(".card-warnings", fragment) || queryOne(".warn", fragment);
      if (warningRoot) {
        warningRoot.replaceChildren();
        const warnings = [];
        if (card.note) {
          warnings.push(card.note);
        }
        if (card.flag) {
          warnings.push("Decision flag raised");
        }

        if (warnings.length > 0) {
          for (const warning of warnings) {
            const banner = document.createElement("div");
            banner.className = "warn";
            banner.textContent = warning;
            warningRoot.appendChild(banner);
          }
          setDisplay(warningRoot, true);
        } else {
          setDisplay(warningRoot, false);
        }
      }

      grid.appendChild(fragment);
    }

    waveNode.append(header, grid);
    wavesRoot.appendChild(waveNode);
  }
}

function render(state) {
  updateStatusCounts(state.model?.counts);
  updateTrackFilters(state);
  renderCards(state);

  const ring = byId("ring");
  if (ring) {
    ring.style.setProperty("--ring-percent", String(state.model?.pct ?? 0));
  }
  setText(byId("ringpct"), `${state.model?.pct ?? 0}%`);
}

function showToast(message) {
  const toast = byId("toast");
  if (!toast) {
    return;
  }

  const messageNode = toast.querySelector(".toast-message") || toast;
  messageNode.textContent = message;
  toast.style.display = "flex";
  window.clearTimeout(showToast.timerId);
  showToast.timerId = window.setTimeout(() => {
    toast.style.display = "none";
  }, 1400);
}

showToast.timerId = 0;

async function copyIssueCommand(id) {
  const text = `bd show ${id}`;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      showToast(`Copied: ${text}`);
      return;
    }
  } catch {
    // Fallback below.
  }

  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "true");
  input.style.position = "absolute";
  input.style.left = "-9999px";
  document.body.appendChild(input);
  input.select();

  try {
    document.execCommand("copy");
    showToast(`Copied: ${text}`);
  } finally {
    input.remove();
  }
}

function setSourceUi(source, state) {
  const sourceNode = byId("srctxt");
  const updateNode = byId("updtxt");

  if (source.mode === "live") {
    setText(sourceNode, `LIVE ${source.path}`);
    setText(updateNode, `Last sync: ${state.lastUpdatedLabel}`);
    return;
  }

  if (source.mode === "snapshot") {
    setText(sourceNode, `SNAPSHOT ${source.path}`);
    const age = formatSnapshotAge(source.generatedAt, state.now());
    setText(updateNode, `Snapshot age: ${age}`);
    return;
  }

  setText(sourceNode, "DEMO");
  setText(updateNode, `Demo mode: ${DEMO_HINT}`);
}

function stampLastUpdated(state) {
  const now = new Date(state.now());
  state.lastUpdatedLabel = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

async function fetchLiveIssues(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const text = await response.text();
  return parseJSONL(text);
}

function snapshotIssues(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }
  // string payload (bmc-5 contract): the JSONL travels as one escaped string
  // and is parsed by the tolerant engine parser — malicious lines stay inert data.
  if (typeof snapshot.issues_jsonl === "string") {
    return parseJSONL(snapshot.issues_jsonl);
  }
  if (Array.isArray(snapshot.issues)) {
    return snapshot.issues;
  }
  return null;
}

function readInlineMeta() {
  if (typeof window.BMC_META_JSON === "string") {
    try {
      const parsed = JSON.parse(window.BMC_META_JSON);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      console.info("Ignoring invalid BMC_META_JSON payload", error);
    }
  }
  if (window.BMC_META && typeof window.BMC_META === "object") {
    return window.BMC_META;
  }
  return {};
}

async function loadMeta(config) {
  const inline = readInlineMeta();
  if (inline && Object.keys(inline).length > 0) {
    return inline;
  }

  if (!config.metaPath) {
    return {};
  }

  try {
    const response = await fetch(config.metaPath, { cache: "no-store" });
    if (!response.ok) {
      return {};
    }
    return await response.json();
  } catch {
    return {};
  }
}

async function resolveData(config, state) {
  const dataPath = config.dataPath || DEFAULT_DATA_PATH;
  let fetchOk = false;
  let liveIssues = [];

  try {
    liveIssues = await fetchLiveIssues(dataPath);
    fetchOk = true;
  } catch (error) {
    console.info("BMC live fetch failed", error);
  }

  const snapshot = window.BMC_SNAPSHOT && typeof window.BMC_SNAPSHOT === "object"
    ? window.BMC_SNAPSHOT
    : null;
  const snapshotIssueList = snapshotIssues(snapshot);
  const mode = decideSourceMode({
    fetchOk,
    snapshotPresent: snapshotIssueList !== null
  });

  if (mode === "live") {
    return {
      mode,
      path: dataPath,
      issues: liveIssues,
      hint: ""
    };
  }

  if (mode === "snapshot") {
    return {
      mode,
      path: snapshot.source || "window.BMC_SNAPSHOT",
      generatedAt: snapshot.generated_at,
      issues: snapshotIssueList || [],
      hint: ""
    };
  }

  return {
    mode,
    path: "inline demo",
    issues: DEMO_ISSUES,
    hint: DEMO_HINT
  };
}

function buildState(config) {
  return {
    config,
    filters: {
      status: "all",
      track: "all",
      query: ""
    },
    strings: deepMergeStrings(config.strings),
    issuesById: new Map(),
    trackOptions: ["all"],
    model: null,
    source: { mode: "demo", path: "inline demo", issues: DEMO_ISSUES, hint: DEMO_HINT },
    timerId: 0,
    lastUpdatedLabel: "never",
    now: () => Date.now()
  };
}

function bindStatusFilters(state) {
  const chipsRoot = byId("chips");
  if (!chipsRoot) {
    return;
  }

  chipsRoot.addEventListener("click", (event) => {
    const chip = event.target instanceof Element ? event.target.closest(".chip[data-f]") : null;
    if (!chip) {
      return;
    }

    state.filters.status = chip.dataset.f || "all";
    for (const node of chipsRoot.querySelectorAll(".chip[data-f]")) {
      node.classList.toggle("active", node === chip);
    }
    render(state);
  });
}

function bindTrackFilters(state) {
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("#trackchips .chip[data-track]") : null;
    if (!button) {
      return;
    }

    state.filters.track = button.dataset.track || "all";
    for (const node of document.querySelectorAll("#trackchips .chip[data-track]")) {
      node.classList.toggle("active", node === button);
    }
    render(state);
  });
}

function bindSearch(state) {
  const search = byId("search");
  if (!search) {
    return;
  }

  let timeoutId = 0;
  search.addEventListener("input", () => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => {
      state.filters.query = search.value;
      render(state);
    }, SEARCH_DEBOUNCE_MS);
  });
}

function syncAutoRefresh(state) {
  window.clearInterval(state.timerId);
  state.timerId = 0;

  const auto = byId("auto");
  if (!(auto instanceof HTMLInputElement) || !auto.checked) {
    return;
  }

  if (state.source.mode !== "live") {
    return;
  }

  state.timerId = window.setInterval(() => {
    refresh(state, { manual: false });
  }, state.config.refreshInterval || DEFAULT_REFRESH_INTERVAL);
}

async function refresh(state, { manual }) {
  const meta = await loadMeta(state.config);
  const source = await resolveData(state.config, state);
  state.source = source;
  state.issuesById = new Map(
    source.issues
      .filter((issue) => issue && typeof issue.id === "string")
      .map((issue) => [issue.id, issue])
  );
  state.model = deriveModel(source.issues, meta, { strings: state.config.strings });
  state.trackOptions = computeTrackOptions(state.model);
  stampLastUpdated(state);
  render(state);
  setSourceUi(source, state);
  syncAutoRefresh(state);

  if (manual) {
    showToast(`Refresh complete: ${source.mode}`);
  }
}

function bindRefresh(state) {
  const refreshButton = byId("refresh");
  if (!refreshButton) {
    return;
  }

  refreshButton.addEventListener("click", () => {
    refresh(state, { manual: true });
  });

  const auto = byId("auto");
  if (auto) {
    auto.addEventListener("change", () => {
      syncAutoRefresh(state);
    });
  }
}

function bindCopy() {
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest(".id[data-id]") : null;
    if (!target) {
      return;
    }

    copyIssueCommand(target.dataset.id);
  });
}

function bindThemeToggle() {
  const toggle = byId("themetoggle");
  if (!toggle) {
    return;
  }

  toggle.addEventListener("click", () => {
    const next = nextTheme(getThemeMode());
    setThemeMode(next);
    showToast(`Theme: ${next}`);
  });
}

function applyConfig(config, state) {
  if (config.title) {
    document.title = config.title;
  }

  applyAccent(config.accent);
  applyI18n(state.strings, config.title);
  setThemeMode(getThemeMode());
}

function readConfig() {
  const config = window.BMC_CONFIG && typeof window.BMC_CONFIG === "object"
    ? window.BMC_CONFIG
    : {};

  return {
    title: config.title || "",
    accent: config.accent || "",
    dataPath: config.dataPath || DEFAULT_DATA_PATH,
    refreshInterval: Number(config.refreshInterval) > 0
      ? Number(config.refreshInterval)
      : DEFAULT_REFRESH_INTERVAL,
    strings: config.strings && typeof config.strings === "object" ? config.strings : {},
    metaPath: config.metaPath || ""
  };
}

function init() {
  const config = readConfig();
  const state = buildState(config);

  const chipsRoot = byId("chips");
  if (chipsRoot) {
    for (const chip of chipsRoot.querySelectorAll(".chip[data-f]")) {
      chip.dataset.baseLabel = chip.textContent || chip.dataset.f || "";
    }
  }

  applyConfig(config, state);
  bindStatusFilters(state);
  bindTrackFilters(state);
  bindSearch(state);
  bindRefresh(state);
  bindCopy();
  bindThemeToggle();

  refresh(state, { manual: false }).catch((error) => {
    console.error("BMC init failed", error);
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", init);
}

function resolveSnapshotPayload() {
  const snapshot = window.BMC_SNAPSHOT && typeof window.BMC_SNAPSHOT === "object"
    ? window.BMC_SNAPSHOT
    : {};
  return {
    snapshot,
    issues: snapshotIssues(snapshot) || [],
    meta: readInlineMeta()
  };
}

if (typeof globalThis !== "undefined") {
  globalThis.BMC_PANEL_HELPERS = {
    applyCardFilters,
    decideSourceMode,
    formatSnapshotAge,
    init,
    matchesSearch,
    nextTheme,
    readInlineMeta,
    resolveSnapshotPayload,
    snapshotIssues
  };
}

// Synchronous, DOM-free runtime surface: lets generated snapshots be validated
// (e.g. in a vm sandbox) without a browser. Populated at evaluation time.
if (typeof window !== "undefined") {
  window.BMC_RUNTIME = resolveSnapshotPayload();
}
