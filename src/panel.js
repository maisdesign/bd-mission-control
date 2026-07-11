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
  const unverifiedOnly = filters?.unverifiedOnly === true;

  return cards.filter((card) => {
    if (statusFilter !== "all" && card.state !== statusFilter) {
      return false;
    }

    if (trackFilter !== "all" && (card.track || "").toUpperCase() !== trackFilter) {
      return false;
    }

    if (unverifiedOnly && !(card.state === "done" && card.verification === null)) {
      return false;
    }

    return matchesSearch(card, query);
  });
}

function decideRefreshCycle({ mode, inFlight, timerTick }) {
  const keepModel = true;
  if (inFlight) {
    return { shouldFetch: false, keepModel, queueNext: true };
  }

  if (timerTick && mode !== "live") {
    return { shouldFetch: false, keepModel, queueNext: false };
  }

  return { shouldFetch: true, keepModel, queueNext: false };
}

function shouldCommitRefreshResult({ hasCurrentModel, liveFetchFailed }) {
  if (liveFetchFailed && hasCurrentModel) {
    return false;
  }

  return true;
}

const DEMO_HINT = "no data - run refresh or serve over HTTP";
const DEFAULT_DATA_PATH = "../.beads/issues.jsonl";
const DEFAULT_REFRESH_INTERVAL = 15000;
const SOUND_STORAGE_KEY = "bmc-sound";
const ANNOUNCE_STORAGE_KEY = "bmc-announce";
const AUTO_REFRESH_STORAGE_KEY = "bmc-auto";
const THEME_STORAGE_KEY = "bmc-theme";
const SEARCH_DEBOUNCE_MS = 150;
const SOUND_DEFAULTS = Object.freeze({
  enabled: false,
  volume: 0.5
});
const DEFAULT_ANNOUNCE_TEMPLATE = "Status report. {ready} ready, {inprogress} in progress, {blocked} blocked. {done} of {all} complete, {pct} percent.";
const DEFAULT_COMPLETION_TEMPLATE = "Completed: {newlyDone}.";
const ANNOUNCE_DEFAULTS = Object.freeze({
  enabled: false,
  everyMs: 0,
  everyDone: 0,
  voice: "",
  lang: "en-US",
  rate: 1,
  pitch: 1,
  template: DEFAULT_ANNOUNCE_TEMPLATE,
  completionTemplate: DEFAULT_COMPLETION_TEMPLATE
});

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

function hasAudioContextSupport() {
  return typeof window !== "undefined"
    && (typeof window.AudioContext === "function" || typeof window.webkitAudioContext === "function");
}

function readStoredSoundEnabled(storage = globalThis?.localStorage) {
  try {
    const raw = storage?.getItem?.(SOUND_STORAGE_KEY);
    if (raw === "1" || raw === "true") {
      return true;
    }
    if (raw === "0" || raw === "false") {
      return false;
    }
  } catch {
    // Ignore storage failures.
  }

  return null;
}

function readStoredAnnounceEnabled(storage = globalThis?.localStorage) {
  try {
    const raw = storage?.getItem?.(ANNOUNCE_STORAGE_KEY);
    if (raw === "1" || raw === "true") {
      return true;
    }
    if (raw === "0" || raw === "false") {
      return false;
    }
  } catch {
    // Ignore storage failures.
  }

  return null;
}

function readStoredAutoRefreshEnabled(storage = globalThis?.localStorage) {
  try {
    const raw = storage?.getItem?.(AUTO_REFRESH_STORAGE_KEY);
    if (raw === "1" || raw === "true") {
      return true;
    }
    if (raw === "0" || raw === "false") {
      return false;
    }
  } catch {
    // Ignore storage failures.
  }

  return null;
}

function clampSoundVolume(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return SOUND_DEFAULTS.volume;
  }

  return Math.min(1, Math.max(0, numeric));
}

function mergeSoundConfig(soundConfig, storedEnabled = null) {
  const input = soundConfig && typeof soundConfig === "object" ? soundConfig : {};
  const enabled = typeof storedEnabled === "boolean"
    ? storedEnabled
    : input.enabled === true;

  return {
    enabled,
    volume: clampSoundVolume(input.volume)
  };
}

function normalizeInterval(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return Math.floor(numeric);
}

function clampRate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return ANNOUNCE_DEFAULTS.rate;
  }

  return Math.min(10, Math.max(0.1, numeric));
}

function clampPitch(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return ANNOUNCE_DEFAULTS.pitch;
  }

  return Math.min(2, Math.max(0, numeric));
}

function resolveAnnouncementString(strings, key) {
  return resolveI18nValue(strings, `announce.${key}`)
    || resolveI18nValue(strings, `announce_${key}`);
}

function mergeAnnounceConfig(announceConfig, storedEnabled = null, strings = {}) {
  const input = announceConfig && typeof announceConfig === "object" ? announceConfig : {};
  const enabled = typeof storedEnabled === "boolean"
    ? storedEnabled
    : input.enabled === true;
  const template = typeof input.template === "string" && input.template.trim()
    ? input.template
    : resolveAnnouncementString(strings, "template") || ANNOUNCE_DEFAULTS.template;
  const completionTemplate = typeof input.completionTemplate === "string" && input.completionTemplate.trim()
    ? input.completionTemplate
    : resolveAnnouncementString(strings, "completionTemplate") || ANNOUNCE_DEFAULTS.completionTemplate;

  return {
    enabled,
    everyMs: normalizeInterval(input.everyMs),
    everyDone: normalizeInterval(input.everyDone),
    voice: typeof input.voice === "string" ? input.voice.trim() : "",
    lang: typeof input.lang === "string" && input.lang.trim()
      ? input.lang.trim()
      : ANNOUNCE_DEFAULTS.lang,
    rate: clampRate(input.rate),
    pitch: clampPitch(input.pitch),
    template,
    completionTemplate
  };
}

function mergeAutoRefreshConfig(autoRefreshConfig, storedEnabled = null) {
  if (typeof storedEnabled === "boolean") {
    return storedEnabled;
  }

  if (typeof autoRefreshConfig === "boolean") {
    return autoRefreshConfig;
  }

  return true;
}

function interpolateAnnouncementTemplate(template, values = {}) {
  const source = typeof template === "string" && template.trim()
    ? template
    : DEFAULT_ANNOUNCE_TEMPLATE;

  return source.replace(/\{([^{}]+)\}/g, (_match, key) => {
    if (!Object.hasOwn(values, key)) {
      return "";
    }

    const value = values[key];
    return value === null || value === undefined ? "" : String(value);
  });
}

function buildAnnouncementValues(model, newlyDone = "") {
  const counts = model?.counts || {};

  return {
    ready: counts.ready ?? 0,
    inprogress: counts.inprogress ?? 0,
    blocked: counts.blocked ?? 0,
    done: counts.done ?? 0,
    deferred: counts.deferred ?? 0,
    all: counts.all ?? 0,
    pct: model?.pct ?? 0,
    newlyDone
  };
}

function selectAnnouncementVoice(voices, preferredName, preferredLang = ANNOUNCE_DEFAULTS.lang) {
  const available = Array.isArray(voices)
    ? voices.filter((voice) => voice && typeof voice.name === "string")
    : [];

  if (available.length === 0) {
    return null;
  }

  const needle = String(preferredName || "").trim().toLowerCase();
  if (needle) {
    const exact = available.find((voice) => voice.name.toLowerCase() === needle);
    if (exact) {
      return exact;
    }

    const preferred = available.find((voice) => voice.name.toLowerCase().includes(needle));
    if (preferred) {
      return preferred;
    }
  }

  const normalizedLang = String(preferredLang || "").trim().toLowerCase();
  const englishNameHints = [
    "google us english",
    "microsoft zira",
    "microsoft aria",
    "microsoft jenny"
  ];

  const rankVoice = (voice) => {
    const voiceName = voice.name.toLowerCase();
    const voiceLang = String(voice.lang || "").trim().toLowerCase();
    const langBase = normalizedLang.split("-")[0];
    const voiceIsEnglish = voiceLang.startsWith("en");
    let score = voice.default === true ? 5 : 0;

    if (normalizedLang) {
      if (voiceLang === normalizedLang) {
        score += 200;
      } else if (voiceLang.startsWith(`${langBase}-`) || voiceLang === langBase) {
        score += 160;
      }
    }

    if (voiceIsEnglish && (normalizedLang.startsWith("en") || !normalizedLang)) {
      if (englishNameHints.some((hint) => voiceName.includes(hint))) {
        score += 120;
      }

      score += 100;
    }

    if (voice.default === true) {
      score += 20;
    }

    return score;
  };

  return [...available].sort((left, right) => rankVoice(right) - rankVoice(left))[0] || null;
}

function shouldAnnounce({ everyMs = 0, elapsedMs = 0, everyDone = 0, doneCount = 0, changed = false }) {
  return {
    timer: everyMs > 0 && changed === true && elapsedMs >= everyMs,
    completion: everyDone > 0 && doneCount >= everyDone
  };
}

function buildAnnouncementSignature(model) {
  const counts = model?.counts || {};
  return [
    counts.ready ?? 0,
    counts.inprogress ?? 0,
    counts.blocked ?? 0,
    counts.done ?? 0,
    counts.deferred ?? 0,
    counts.all ?? 0,
    model?.pct ?? 0
  ].join("|");
}

function collectDoneIds(model) {
  const doneIds = [];

  for (const [id, bead] of Object.entries(model?.beads || {})) {
    if (bead?.state === "done") {
      doneIds.push(id);
    }
  }

  doneIds.sort();
  return doneIds;
}

function diffDoneIds(previousDoneIds, nextDoneIds) {
  if (!Array.isArray(previousDoneIds) || previousDoneIds.length === 0) {
    return [];
  }

  const knownDoneIds = new Set(previousDoneIds);
  return nextDoneIds.filter((id) => !knownDoneIds.has(id));
}

function buildCompletionChime({ now = 0, volume = SOUND_DEFAULTS.volume, nextPct = 0, previousPct = 0 }) {
  const gain = clampSoundVolume(volume);
  const resolved = nextPct >= 100 && previousPct < 100;
  const baseEnvelope = { attack: 0.006, decay: 0.24 };

  if (resolved) {
    return [
      { frequency: 880, start: now, duration: 0.1, gain: gain * 0.16, type: "triangle", ...baseEnvelope },
      { frequency: 1320, start: now + 0.045, duration: 0.12, gain: gain * 0.12, type: "sine", ...baseEnvelope },
      { frequency: 1760, start: now + 0.12, duration: 0.2, gain: gain * 0.14, type: "triangle", attack: 0.008, decay: 0.3 }
    ];
  }

  return [
    { frequency: 880, start: now, duration: 0.11, gain: gain * 0.16, type: "triangle", ...baseEnvelope },
    { frequency: 1320, start: now + 0.038, duration: 0.16, gain: gain * 0.11, type: "sine", attack: 0.004, decay: 0.26 }
  ];
}

function createCompletionEvents() {
  const listeners = new Set();

  return {
    onBeadsCompleted(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }

      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(newlyDoneIds) {
      if (!Array.isArray(newlyDoneIds) || newlyDoneIds.length === 0) {
        return;
      }

      for (const listener of listeners) {
        listener([...newlyDoneIds]);
      }
    }
  };
}

function getAudioContextCtor() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.AudioContext || window.webkitAudioContext || null;
}

function ensureAudioContext(state) {
  if (!state.sound.supported) {
    return null;
  }

  if (state.sound.context) {
    return state.sound.context;
  }

  const AudioContextCtor = getAudioContextCtor();
  if (!AudioContextCtor) {
    return null;
  }

  state.sound.context = new AudioContextCtor();
  return state.sound.context;
}

async function unlockAudioContext(state) {
  const context = ensureAudioContext(state);
  if (!context || typeof context.resume !== "function") {
    return false;
  }

  if (context.state === "running") {
    return true;
  }

  try {
    await context.resume();
    return context.state === "running";
  } catch (error) {
    console.info("BMC sound resume skipped", error);
    return false;
  }
}

function playCompletionChime(state, newlyDoneIds) {
  if (!state.sound.enabled || !state.sound.supported || newlyDoneIds.length === 0) {
    return;
  }

  const context = ensureAudioContext(state);
  if (!context || context.state !== "running") {
    return;
  }

  const notes = buildCompletionChime({
    now: context.currentTime + 0.01,
    volume: state.sound.volume,
    previousPct: state.previousPct,
    nextPct: state.model?.pct ?? 0
  });

  for (const note of notes) {
    const oscillator = context.createOscillator();
    const gainNode = context.createGain();
    const start = note.start;
    const peakAt = start + note.attack;
    const stopAt = start + note.duration;

    oscillator.type = note.type;
    oscillator.frequency.setValueAtTime(note.frequency, start);

    gainNode.gain.setValueAtTime(0.0001, start);
    gainNode.gain.linearRampToValueAtTime(note.gain, peakAt);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, stopAt);

    oscillator.connect(gainNode);
    gainNode.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(stopAt + 0.02);
  }
}

function syncSoundToggleUi(state) {
  const button = byId("soundtoggle");
  if (!button) {
    return;
  }

  if (!state.sound.supported) {
    button.hidden = true;
    if (!warnOnceKeys.has("sound-unsupported")) {
      warnOnceKeys.add("sound-unsupported");
      console.info("BMC sound disabled: AudioContext unavailable");
    }
    return;
  }

  button.hidden = false;
  button.setAttribute("aria-pressed", state.sound.enabled ? "true" : "false");
  button.textContent = state.sound.enabled ? "ON" : "OFF";
  button.title = state.sound.enabled ? "Completion chime on" : "Completion chime off";
}

function persistSoundEnabled(enabled, storage = globalThis?.localStorage) {
  try {
    storage?.setItem?.(SOUND_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore storage failures.
  }
}

function hasSpeechSynthesisSupport() {
  return typeof window !== "undefined"
    && typeof window.speechSynthesis === "object"
    && typeof window.speechSynthesis?.speak === "function"
    && typeof window.speechSynthesis?.cancel === "function"
    && typeof window.SpeechSynthesisUtterance === "function";
}

function persistAnnounceEnabled(enabled, storage = globalThis?.localStorage) {
  try {
    storage?.setItem?.(ANNOUNCE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore storage failures.
  }
}

function persistAutoRefreshEnabled(enabled, storage = globalThis?.localStorage) {
  try {
    storage?.setItem?.(AUTO_REFRESH_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore storage failures.
  }
}

function syncAnnounceUi(state) {
  const speakButton = byId("announcebutton");
  const toggleButton = byId("announcetoggle");

  if (!speakButton && !toggleButton) {
    return;
  }

  if (!state.announce.supported) {
    if (speakButton) {
      speakButton.hidden = true;
    }
    if (toggleButton) {
      toggleButton.hidden = true;
    }
    if (!warnOnceKeys.has("announce-unsupported")) {
      warnOnceKeys.add("announce-unsupported");
      console.info("BMC announce disabled: speechSynthesis unavailable");
    }
    return;
  }

  if (speakButton) {
    speakButton.hidden = false;
    speakButton.title = "Speak status report";
  }

  if (toggleButton) {
    toggleButton.hidden = false;
    toggleButton.setAttribute("aria-pressed", state.announce.enabled ? "true" : "false");
    toggleButton.textContent = state.announce.enabled ? "ON" : "OFF";
    toggleButton.title = state.announce.enabled ? "Voice announcer on" : "Voice announcer off";
  }
}

function cancelAnnouncement(state) {
  if (!state.announce.supported) {
    return;
  }

  try {
    window.speechSynthesis.cancel();
  } catch {
    // Ignore speech cancellation failures.
  }
}

function buildNewlyDoneText(state, newlyDoneIds) {
  const ids = Array.isArray(newlyDoneIds) ? newlyDoneIds.filter((id) => typeof id === "string" && id) : [];
  if (ids.length === 0) {
    return "";
  }

  const titles = ids.slice(0, 3).map((id) => {
    const beadLabel = state.model?.beads?.[id]?.label;
    const issueTitle = state.issuesById.get(id)?.title;
    return beadLabel || issueTitle || id;
  });

  return titles.join(", ");
}

function buildAnnouncementText(state, { newlyDoneIds = [], completion = false } = {}) {
  const newlyDone = buildNewlyDoneText(state, newlyDoneIds);
  const values = buildAnnouncementValues(state.model, newlyDone);
  const summary = interpolateAnnouncementTemplate(state.announce.template, values).trim();

  if (!completion) {
    return summary;
  }

  const prefix = interpolateAnnouncementTemplate(state.announce.completionTemplate, values).trim();
  return [prefix, summary].filter(Boolean).join(" ");
}

function markAnnouncementBaseline(state) {
  state.announce.lastSignature = buildAnnouncementSignature(state.model);
  state.announce.lastAt = state.now();
  state.announce.baselined = true;
}

function recordAnnouncement(state) {
  state.announce.lastSignature = buildAnnouncementSignature(state.model);
  state.announce.lastAt = state.now();
  state.announce.baselined = true;
}

async function waitForSpeechVoices(speechSynthesis, timeoutMs = 1500) {
  const getVoices = () => {
    try {
      return speechSynthesis.getVoices?.() || [];
    } catch {
      return [];
    }
  };

  const current = getVoices();
  if (current.length > 0) {
    return current;
  }

  return await new Promise((resolve) => {
    let settled = false;
    const previousHandler = speechSynthesis.onvoiceschanged;
    const timerId = window.setTimeout(() => finish(getVoices()), timeoutMs);

    const finish = (voices) => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timerId);
      if (speechSynthesis.onvoiceschanged === handler) {
        speechSynthesis.onvoiceschanged = previousHandler || null;
      }
      resolve(voices);
    };

    const handler = () => {
      const voices = getVoices();
      if (voices.length === 0) {
        return;
      }

      finish(voices);
      if (typeof previousHandler === "function") {
        try {
          previousHandler.call(speechSynthesis);
        } catch {
          // Ignore listener failures.
        }
      }
    };

    speechSynthesis.onvoiceschanged = handler;
  });
}

async function speakAnnouncement(state, options = {}) {
  if (!state.announce.supported || !state.model) {
    return false;
  }

  try {
    const text = buildAnnouncementText(state, options);
    if (!text) {
      return false;
    }

    const utterance = new window.SpeechSynthesisUtterance(text);
    utterance.lang = state.announce.lang;
    utterance.rate = state.announce.rate;
    utterance.pitch = state.announce.pitch;

    const voices = await waitForSpeechVoices(window.speechSynthesis);
    const selectedVoice = selectAnnouncementVoice(
      voices,
      state.announce.voice,
      state.announce.lang
    );
    if (selectedVoice) {
      utterance.voice = selectedVoice;
      if (typeof selectedVoice.lang === "string" && selectedVoice.lang.trim()) {
        utterance.lang = selectedVoice.lang;
      }
    }

    cancelAnnouncement(state);
    window.speechSynthesis.speak(utterance);
    recordAnnouncement(state);
    return true;
  } catch (error) {
    console.info("BMC announce skipped", error);
    return false;
  }
}

function maybeAnnounceOnTimer(state) {
  if (!state.announce.enabled || !state.announce.supported || !state.announce.baselined) {
    return;
  }

  const decision = shouldAnnounce({
    everyMs: state.announce.everyMs,
    elapsedMs: state.now() - state.announce.lastAt,
    changed: buildAnnouncementSignature(state.model) !== state.announce.lastSignature
  });

  if (decision.timer) {
    void speakAnnouncement(state);
  }
}

function syncAnnounceTimer(state) {
  window.clearInterval(state.announce.timerId);
  state.announce.timerId = 0;

  if (!state.announce.enabled || !state.announce.supported || state.announce.everyMs <= 0) {
    return;
  }

  state.announce.timerId = window.setInterval(() => {
    maybeAnnounceOnTimer(state);
  }, Math.max(250, state.announce.everyMs));
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

function mapVerificationBadge(verification, state) {
  if (state !== "done") {
    return null;
  }

  if (verification === "pass") {
    return {
      tone: "pass",
      text: "VERIFIED",
      title: "independent verification passed"
    };
  }

  if (verification === "fail") {
    return {
      tone: "fail",
      text: "VERIFY FAILED",
      title: "independent verification failed"
    };
  }

  return {
    tone: "drift",
    text: "unverified",
    title: "closed without independent verification (drift)"
  };
}

function parseAttemptValue(value) {
  const match = String(value || "").match(/\battempt=(\d+)\b/i);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function previewRawValue(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function parseLockTelemetry(value) {
  const raw = String(value || "");
  const readField = (name) => {
    const match = raw.match(new RegExp(`\\b${name}=(\\S+)`, "i"));
    return match ? match[1] : null;
  };

  return {
    holder: readField("holder"),
    lastConfirmation: readField("last_confirmation"),
    handoffId: readField("handoff_id")
  };
}

function getTelemetryAgeBucket(timestamp, now = Date.now()) {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return {
      tone: "unknown",
      label: "AGE ?"
    };
  }

  const deltaMs = Math.max(0, now - parsed);
  const deltaMinutes = Math.floor(deltaMs / 60000);

  if (deltaMinutes < 30) {
    return {
      tone: "fresh",
      label: deltaMinutes < 1 ? "AGE <1m" : `AGE ${deltaMinutes}m`
    };
  }

  if (deltaMinutes < 120) {
    return {
      tone: "warm",
      label: `AGE ${deltaMinutes}m`
    };
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  return {
    tone: "stale",
    label: `AGE ${deltaHours}h`
  };
}

function summarizeOrchestrator(orchestrator, now = Date.now()) {
  if (!orchestrator || typeof orchestrator !== "object") {
    return null;
  }

  const summary = {
    present: true,
    lock: null,
    age: null,
    handoff: null,
    attemptsByBead: {},
    fallbacks: []
  };

  for (const [key, rawValue] of Object.entries(orchestrator)) {
    if (typeof rawValue !== "string") {
      continue;
    }

    if (key === "orchestrator-lock") {
      const lock = parseLockTelemetry(rawValue);
      const hasUsefulLock = Boolean(lock.holder || lock.lastConfirmation || lock.handoffId);
      if (hasUsefulLock) {
        summary.lock = lock;
        summary.age = getTelemetryAgeBucket(lock.lastConfirmation, now);
        if (lock.handoffId && lock.handoffId !== "none") {
          summary.handoff = lock.handoffId;
        }
      } else {
        summary.fallbacks.push({ key, raw: previewRawValue(rawValue) });
      }
      continue;
    }

    if (key.startsWith("attempts-")) {
      const attempt = parseAttemptValue(rawValue);
      if (attempt !== null) {
        summary.attemptsByBead[key.slice("attempts-".length)] = attempt;
      } else {
        summary.fallbacks.push({ key, raw: previewRawValue(rawValue) });
      }
      continue;
    }

    if (key.startsWith("handoff")) {
      summary.fallbacks.push({ key, raw: previewRawValue(rawValue) });
      continue;
    }

    summary.fallbacks.push({ key, raw: previewRawValue(rawValue) });
  }

  return summary;
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
    flag: bead.flag === true,
    verification: Object.hasOwn(bead, "verification") ? bead.verification : null
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

function ensureUnverifiedChip() {
  const chipsRoot = byId("chips");
  if (!chipsRoot) {
    return null;
  }

  const existing = document.getElementById("c-unverified");
  if (existing) {
    return existing;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.id = "c-unverified";
  button.className = "chip chip-ghost";
  button.textContent = "UNVERIFIED ONLY";
  button.title = "Show only done cards closed without independent verification";
  chipsRoot.appendChild(button);
  return button;
}

function updateUnverifiedChip(state) {
  const chip = ensureUnverifiedChip();
  if (!chip) {
    return;
  }

  chip.classList.toggle("active", state.filters.unverifiedOnly === true);
  chip.setAttribute("aria-pressed", state.filters.unverifiedOnly === true ? "true" : "false");
}

function ensureTelemetryStrip() {
  const waves = byId("waves");
  if (!waves || !waves.parentElement) {
    return null;
  }

  let strip = document.getElementById("orchestrator-strip");
  if (strip) {
    return strip;
  }

  strip = document.createElement("details");
  strip.id = "orchestrator-strip";
  strip.className = "orchestrator-strip";
  strip.open = true;
  waves.parentElement.insertBefore(strip, waves);
  return strip;
}

function createTelemetryChip(text, tone = "") {
  const chip = document.createElement("span");
  chip.className = `telemetry-chip${tone ? ` ${tone}` : ""}`;
  chip.textContent = text;
  return chip;
}

function renderOrchestratorStrip(state) {
  const summary = state.orchestrator;
  const strip = ensureTelemetryStrip();
  if (!strip) {
    return;
  }

  if (!summary?.present) {
    strip.remove();
    return;
  }

  strip.replaceChildren();

  const header = document.createElement("summary");
  header.className = "orchestrator-summary";
  header.textContent = "ORCHESTRATOR HUD";
  strip.appendChild(header);

  const body = document.createElement("div");
  body.className = "orchestrator-body";
  strip.appendChild(body);

  const primary = document.createElement("div");
  primary.className = "orchestrator-primary";
  body.appendChild(primary);

  const secondary = document.createElement("div");
  secondary.className = "orchestrator-secondary";
  body.appendChild(secondary);

  let hasRenderableTelemetry = false;
  let hasStructuredTelemetry = false;

  if (summary.lock?.holder) {
    primary.appendChild(createTelemetryChip(`LOCK ${summary.lock.holder}`, "info"));
    hasRenderableTelemetry = true;
    hasStructuredTelemetry = true;
  }

  if (summary.age?.label) {
    const ageChip = createTelemetryChip(summary.age.label, summary.age.tone);
    if (summary.lock?.lastConfirmation) {
      ageChip.title = summary.lock.lastConfirmation;
    }
    primary.appendChild(ageChip);
    hasRenderableTelemetry = true;
    hasStructuredTelemetry = true;
  }

  if (summary.handoff) {
    const handoffChip = createTelemetryChip(`HANDOFF ${summary.handoff}`, "warn");
    handoffChip.title = "pending handoff";
    primary.appendChild(handoffChip);
    hasRenderableTelemetry = true;
    hasStructuredTelemetry = true;
  }

  const attemptEntries = Object.entries(summary.attemptsByBead).filter(([, attempt]) => attempt >= 2);
  if (attemptEntries.length > 0) {
    secondary.appendChild(createTelemetryChip(`RETRIES ${attemptEntries.length}`, "warn"));
    hasRenderableTelemetry = true;
    hasStructuredTelemetry = true;
  }

  if (summary.fallbacks.length > 0) {
    for (const fallback of summary.fallbacks) {
      const rawChip = createTelemetryChip(`${fallback.key}: ${fallback.raw || "?"}`, "raw");
      rawChip.title = fallback.key;
      secondary.appendChild(rawChip);
    }
    hasRenderableTelemetry = true;
  }

  if (!hasStructuredTelemetry) {
    const empty = document.createElement("div");
    empty.className = "orchestrator-empty";
    empty.textContent = "NO TELEMETRY";
    if (hasRenderableTelemetry) {
      body.insertBefore(empty, primary);
    } else {
      body.replaceChildren(empty);
    }
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

      const verificationBadge = mapVerificationBadge(card.verification, card.state);
      if (verificationBadge) {
        const badge = document.createElement("span");
        badge.className = `verify-badge ${verificationBadge.tone}`;
        badge.textContent = verificationBadge.text;
        badge.title = verificationBadge.title;
        if (think) {
          think.insertAdjacentElement("afterend", badge);
        } else {
          const headerNode = queryOne(".card-header", fragment);
          headerNode?.appendChild(badge);
        }
      }

      const titleNode = queryOne(".card-title", fragment);
      setText(titleNode, card.label);

      const descNode = queryOne(".card-desc", fragment);
      setText(descNode, `PHASE ${card.phase}`);

      const trackNode = queryOne(".tag.trk", fragment);
      setText(trackNode, card.track);

      const fileNode = queryOne(".tag.file", fragment);
      setText(fileNode, card.phase);

      const attempt = state.orchestrator?.attemptsByBead?.[card.id];
      if (attempt >= 2) {
        const tagsRoot = queryOne(".tags", fragment);
        if (tagsRoot) {
          const attemptChip = document.createElement("span");
          attemptChip.className = "tag attempt-tag";
          attemptChip.textContent = `ATT ${attempt}/3`;
          tagsRoot.appendChild(attemptChip);
        }
      }

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
  updateUnverifiedChip(state);
  renderOrchestratorStrip(state);
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
  let liveFetchError = null;

  try {
    liveIssues = await fetchLiveIssues(dataPath);
    fetchOk = true;
  } catch (error) {
    liveFetchError = error;
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
      orchestrator: null,
      hint: "",
      fetchOk,
      liveFetchError
    };
  }

  if (mode === "snapshot") {
    return {
      mode,
      path: snapshot.source || "window.BMC_SNAPSHOT",
      generatedAt: snapshot.generated_at,
      issues: snapshotIssueList || [],
      orchestrator: snapshot.orchestrator && typeof snapshot.orchestrator === "object"
        ? snapshot.orchestrator
        : null,
      hint: "",
      fetchOk,
      liveFetchError
    };
  }

  return {
    mode,
    path: "inline demo",
    issues: DEMO_ISSUES,
    orchestrator: null,
    hint: DEMO_HINT,
    fetchOk,
    liveFetchError
  };
}

function buildState(config) {
  const completionEvents = createCompletionEvents();

  return {
    config,
    filters: {
      status: "all",
      track: "all",
      query: "",
      unverifiedOnly: false
    },
    strings: deepMergeStrings(config.strings),
    issuesById: new Map(),
    trackOptions: ["all"],
    model: null,
    source: { mode: "demo", path: "inline demo", issues: DEMO_ISSUES, hint: DEMO_HINT },
    orchestrator: null,
    onBeadsCompleted: completionEvents.onBeadsCompleted,
    emitBeadsCompleted: completionEvents.emit,
    previousDoneIds: null,
    previousPct: 0,
    sound: {
      enabled: config.sound.enabled,
      volume: config.sound.volume,
      supported: hasAudioContextSupport(),
      context: null
    },
    announce: {
      ...config.announce,
      supported: hasSpeechSynthesisSupport(),
      baselined: false,
      lastSignature: "",
      lastAt: 0,
      completedSince: 0,
      pendingDoneIds: [],
      timerId: 0
    },
    refresh: {
      inFlight: false,
      pending: null,
      pausedModeLogged: ""
    },
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
    const target = event.target instanceof Element ? event.target.closest(".chip") : null;
    if (!target) {
      return;
    }

    if (target.id === "c-unverified") {
      state.filters.unverifiedOnly = !state.filters.unverifiedOnly;
      updateUnverifiedChip(state);
      render(state);
      return;
    }

    if (!target.matches(".chip[data-f]")) {
      return;
    }

    state.filters.status = target.dataset.f || "all";
    for (const node of chipsRoot.querySelectorAll(".chip[data-f]")) {
      node.classList.toggle("active", node === target);
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
    state.refresh.pausedModeLogged = "";
    return;
  }

  if (state.source.mode !== "live") {
    if (state.refresh.pausedModeLogged !== state.source.mode) {
      console.info(`BMC auto-refresh paused in ${state.source.mode} mode`);
      state.refresh.pausedModeLogged = state.source.mode;
    }
    return;
  }

  state.refresh.pausedModeLogged = "";
  state.timerId = window.setInterval(() => {
    refresh(state, { manual: false, timerTick: true });
  }, state.config.refreshInterval || DEFAULT_REFRESH_INTERVAL);
}

function commitRefreshState(state, nextState) {
  const previousDoneIds = state.previousDoneIds;
  const previousPct = state.model?.pct ?? 0;
  const wasBaselined = state.announce.baselined;
  state.source = nextState.source;
  state.issuesById = nextState.issuesById;
  state.model = nextState.model;
  const nextDoneIds = collectDoneIds(state.model);
  const newlyDoneIds = diffDoneIds(previousDoneIds, nextDoneIds);
  state.previousDoneIds = nextDoneIds;
  state.trackOptions = nextState.trackOptions;
  state.orchestrator = nextState.orchestrator;
  state.lastUpdatedLabel = nextState.lastUpdatedLabel;
  render(state);
  setSourceUi(nextState.source, state);
  syncAutoRefresh(state);
  state.previousPct = previousPct;

  if (!wasBaselined) {
    markAnnouncementBaseline(state);
  }

  if (previousDoneIds !== null && newlyDoneIds.length > 0) {
    state.emitBeadsCompleted(newlyDoneIds);
  }

  state.previousPct = state.model?.pct ?? 0;
}

async function refresh(state, options = {}) {
  const manual = options.manual === true;
  const timerTick = options.timerTick === true;
  const decision = decideRefreshCycle({
    mode: state.source.mode,
    inFlight: state.refresh.inFlight,
    timerTick
  });

  if (decision.queueNext) {
    state.refresh.pending = {
      manual: manual || state.refresh.pending?.manual === true,
      timerTick: false
    };
    return;
  }

  if (!decision.shouldFetch) {
    return;
  }

  state.refresh.inFlight = true;

  try {
    const meta = await loadMeta(state.config);
    const source = await resolveData(state.config, state);
    const liveFetchFailed = Boolean(source.liveFetchError);
    const commitAllowed = shouldCommitRefreshResult({
      hasCurrentModel: state.model !== null,
      liveFetchFailed
    });

    if (!commitAllowed) {
      console.info("BMC refresh kept last good model after live fetch failure");
      return;
    }

    const model = deriveModel(source.issues, meta, { strings: state.config.strings });
    const issuesById = new Map(
      source.issues
        .filter((issue) => issue && typeof issue.id === "string")
        .map((issue) => [issue.id, issue])
    );
    const nextState = {
      source,
      issuesById,
      model,
      trackOptions: computeTrackOptions(model),
      orchestrator: summarizeOrchestrator(source.orchestrator, state.now()),
      lastUpdatedLabel: new Date(state.now()).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      })
    };

    commitRefreshState(state, nextState);

    if (manual) {
      showToast(`Refresh complete: ${source.mode}`);
    }
  } catch (error) {
    console.info("BMC refresh failed; keeping last good model", error);
    if (state.model === null) {
      throw error;
    }
  } finally {
    state.refresh.inFlight = false;
    if (state.refresh.pending) {
      const pending = state.refresh.pending;
      state.refresh.pending = null;
      void refresh(state, pending);
    }
  }
}

function bindRefresh(state) {
  const refreshButton = byId("refresh");
  if (!refreshButton) {
    return;
  }

  refreshButton.addEventListener("click", () => {
    refresh(state, { manual: true, timerTick: false });
  });

  const auto = byId("auto");
  if (auto) {
    auto.addEventListener("change", () => {
      if (auto instanceof HTMLInputElement) {
        persistAutoRefreshEnabled(auto.checked);
      }
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

function bindSoundToggle(state) {
  const button = byId("soundtoggle");
  if (!button) {
    return;
  }

  syncSoundToggleUi(state);
  if (!state.sound.supported) {
    return;
  }

  button.addEventListener("click", async () => {
    await unlockAudioContext(state);
    state.sound.enabled = !state.sound.enabled;
    persistSoundEnabled(state.sound.enabled);
    syncSoundToggleUi(state);
    showToast(state.sound.enabled ? "Completion chime armed" : "Completion chime muted");
  });
}

function bindAnnounceButton(state) {
  const button = byId("announcebutton");
  if (!button) {
    return;
  }

  syncAnnounceUi(state);
  if (!state.announce.supported) {
    return;
  }

  button.addEventListener("click", async () => {
    const spoken = await speakAnnouncement(state);
    if (spoken) {
      showToast("Status report spoken");
    }
  });
}

function bindAnnounceToggle(state) {
  const button = byId("announcetoggle");
  if (!button) {
    return;
  }

  syncAnnounceUi(state);
  if (!state.announce.supported) {
    return;
  }

  button.addEventListener("click", () => {
    state.announce.enabled = !state.announce.enabled;
    persistAnnounceEnabled(state.announce.enabled);

    if (!state.announce.enabled) {
      state.announce.completedSince = 0;
      state.announce.pendingDoneIds = [];
      cancelAnnouncement(state);
    } else if (!state.announce.baselined) {
      markAnnouncementBaseline(state);
    }

    syncAnnounceUi(state);
    syncAnnounceTimer(state);
    showToast(state.announce.enabled ? "Voice announcer armed" : "Voice announcer muted");
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
  const storedSoundEnabled = readStoredSoundEnabled();
  const rawStrings = config.strings && typeof config.strings === "object" ? config.strings : {};
  const storedAnnounceEnabled = readStoredAnnounceEnabled();
  const storedAutoRefreshEnabled = readStoredAutoRefreshEnabled();

  return {
    title: config.title || "",
    accent: config.accent || "",
    dataPath: config.dataPath || DEFAULT_DATA_PATH,
    refreshInterval: Number(config.refreshInterval) > 0
      ? Number(config.refreshInterval)
      : DEFAULT_REFRESH_INTERVAL,
    sound: mergeSoundConfig(config.sound, storedSoundEnabled),
    announce: mergeAnnounceConfig(config.announce, storedAnnounceEnabled, rawStrings),
    autoRefresh: mergeAutoRefreshConfig(config.autoRefresh, storedAutoRefreshEnabled),
    strings: rawStrings,
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
  const auto = byId("auto");
  if (auto instanceof HTMLInputElement) {
    auto.checked = config.autoRefresh;
  }
  bindStatusFilters(state);
  bindTrackFilters(state);
  bindSearch(state);
  bindRefresh(state);
  bindCopy();
  bindAnnounceButton(state);
  bindAnnounceToggle(state);
  bindSoundToggle(state);
  bindThemeToggle();
  syncAnnounceTimer(state);
  state.onBeadsCompleted((newlyDoneIds) => {
    playCompletionChime(state, newlyDoneIds);
  });
  state.onBeadsCompleted((newlyDoneIds) => {
    if (!state.announce.enabled || !state.announce.supported) {
      return;
    }

    state.announce.completedSince += newlyDoneIds.length;
    state.announce.pendingDoneIds.push(...newlyDoneIds);

    const decision = shouldAnnounce({
      everyDone: state.announce.everyDone,
      doneCount: state.announce.completedSince,
      changed: true
    });

    if (!decision.completion) {
      return;
    }

    void speakAnnouncement(state, {
      completion: true,
      newlyDoneIds: state.announce.pendingDoneIds
    });
    state.announce.completedSince = 0;
    state.announce.pendingDoneIds = [];
  });

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
    buildAnnouncementSignature,
    buildAnnouncementValues,
    buildCompletionChime,
    collectDoneIds,
    decideRefreshCycle,
    decideSourceMode,
    diffDoneIds,
    formatSnapshotAge,
    interpolateAnnouncementTemplate,
    getTelemetryAgeBucket,
    init,
    mapVerificationBadge,
    mergeAnnounceConfig,
    mergeSoundConfig,
    matchesSearch,
    nextTheme,
    parseAttemptValue,
    parseLockTelemetry,
    readInlineMeta,
    readStoredAnnounceEnabled,
    readStoredAutoRefreshEnabled,
    readStoredSoundEnabled,
    mergeAutoRefreshConfig,
    resolveSnapshotPayload,
    selectAnnouncementVoice,
    shouldCommitRefreshResult,
    shouldAnnounce,
    summarizeOrchestrator,
    snapshotIssues
  };
}

// Synchronous, DOM-free runtime surface: lets generated snapshots be validated
// (e.g. in a vm sandbox) without a browser. Populated at evaluation time.
if (typeof window !== "undefined") {
  window.BMC_RUNTIME = resolveSnapshotPayload();
}
