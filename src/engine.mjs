/**
 * @typedef {object} Issue
 * @property {string} [id]
 * @property {string} [title]
 * @property {string} [status]
 * @property {number} [priority]
 * @property {string} [issue_type]
 * @property {string} [assignee]
 * @property {string[]} [labels]
 * @property {Array<object>} [dependencies]
 * @property {Array<object>} [comments]
 * @property {string} [created_at]
 * @property {string | null} [closed_at]
 */

export const defaultStrings = {
  status: {
    all: "All",
    ready: "Ready",
    inprogress: "In Progress",
    blocked: "Blocked",
    done: "Done",
    deferred: "Deferred"
  },
  sources: {
    live: "Live",
    snapshot: "Snapshot",
    demo: "Demo"
  },
  empty: {
    title: "No beads found",
    body: "Point the panel at a beads export to populate this view."
  }
};

/**
 * Deep-merge user-facing strings over the built-in English defaults.
 *
 * @param {Record<string, unknown> | undefined} user
 * @returns {Record<string, unknown>}
 */
export function deepMergeStrings(user) {
  return deepMerge(defaultStrings, user);
}

/**
 * Parse a JSONL export without throwing on blank or corrupt lines.
 *
 * @param {string} text
 * @returns {Issue[]}
 */
export function parseJSONL(text) {
  if (typeof text !== "string" || text.length === 0) {
    return [];
  }

  const issues = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        issues.push(parsed);
      }
    } catch {
      // Tolerant parser: malformed lines are skipped.
    }
  }

  return issues;
}

/**
 * Derive dashboard-ready structure from a beads export plus optional curation.
 *
 * @param {Issue[]} issues
 * @param {object} [meta]
 * @param {Record<string, object>} [meta.waves]
 * @param {Record<string, object>} [meta.beads]
 * @param {object} [config]
 * @param {Record<string, unknown>} [config.strings]
 * @returns {object}
 */
export function deriveModel(issues, meta = {}, config = {}) {
  deepMergeStrings(config.strings);

  const safeIssues = Array.isArray(issues) ? issues : [];
  const issueMap = new Map();

  for (const issue of safeIssues) {
    if (issue && typeof issue.id === "string" && issue.id) {
      issueMap.set(issue.id, issue);
    }
  }

  const metaWaves = meta?.waves && typeof meta.waves === "object" ? meta.waves : {};
  const metaBeads = meta?.beads && typeof meta.beads === "object" ? meta.beads : {};
  const epicById = resolveEpicMembership(safeIssues, issueMap);
  const beads = {};
  const waves = new Map();
  const counts = {
    all: 0,
    ready: 0,
    inprogress: 0,
    blocked: 0,
    done: 0,
    deferred: 0
  };
  let doneCount = 0;

  for (const issue of safeIssues) {
    if (!issue || typeof issue.id !== "string" || !issue.id) {
      continue;
    }

    const id = issue.id;
    const overlay = metaBeads[id] && typeof metaBeads[id] === "object" ? metaBeads[id] : {};
    const labels = Array.isArray(issue.labels) ? issue.labels : [];
    const blockedBy = getOpenBlockers(issue, issueMap);
    const state = deriveState(issue, labels, blockedBy);
    const waveKey = deriveWaveKey(issue, overlay, epicById, labels);
    const wave = ensureWave(waves, waveKey, metaWaves, issueMap);

    wave.ids.push(id);
    wave.active ||= state === "ready" || state === "inprogress";

    beads[id] = {
      state,
      blockedBy,
      phase: typeof overlay.phase === "string" && overlay.phase ? overlay.phase : shortPhase(id),
      track: deriveTrack(issue, labels, overlay),
      thinking: deriveThinking(issue, labels, overlay),
      label: typeof issue.title === "string" && issue.title ? issue.title : id,
      assignee: typeof issue.assignee === "string" ? issue.assignee : "",
      verification: deriveVerification(issue),
      epic: epicById.get(id) ?? null,
      note: typeof overlay.note === "string" ? overlay.note : "",
      flag: overlay.flag === true
    };

    counts.all += 1;
    counts[state] += 1;

    if (state === "done") {
      doneCount += 1;
    }
  }

  const orderedWaves = [...waves.values()]
    .sort(compareWaves)
    .map(({ active: _active, sortOrder: _sortOrder, stableOrder: _stableOrder, ...wave }) => wave);

  return {
    waves: orderedWaves,
    beads,
    counts,
    pct: counts.all === 0 ? 0 : Math.round((doneCount / counts.all) * 100)
  };
}

function deepMerge(base, override) {
  if (!isPlainObject(base)) {
    return override === undefined ? base : override;
  }

  const output = { ...base };
  if (!isPlainObject(override)) {
    return output;
  }

  for (const [key, value] of Object.entries(override)) {
    const current = output[key];
    output[key] = isPlainObject(current) && isPlainObject(value)
      ? deepMerge(current, value)
      : value;
  }

  return output;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveEpicMembership(issues, issueMap) {
  const epicById = new Map();

  for (const issue of issues) {
    if (!issue || typeof issue.id !== "string" || !issue.id) {
      continue;
    }

    let epicId = null;
    const dotEpicId = issue.id.includes(".") ? issue.id.split(".")[0] : null;
    if (dotEpicId && issueMap.has(dotEpicId)) {
      epicId = dotEpicId;
    }

    const dependencies = Array.isArray(issue.dependencies) ? issue.dependencies : [];
    for (const dependency of dependencies) {
      if (dependency?.type !== "parent-child") {
        continue;
      }

      const parentId = dependency.depends_on_id;
      if (typeof parentId === "string" && issueMap.has(parentId)) {
        epicId = parentId;
        break;
      }
    }

    if (!epicId && issue.issue_type === "epic") {
      epicId = issue.id;
    }

    if (epicId) {
      epicById.set(issue.id, epicId);
    }
  }

  return epicById;
}

function getOpenBlockers(issue, issueMap) {
  const dependencies = Array.isArray(issue.dependencies) ? issue.dependencies : [];
  const blockedBy = [];

  for (const dependency of dependencies) {
    if (!dependency || (dependency.type && dependency.type !== "blocks")) {
      continue;
    }

    const blockerId = dependency.depends_on_id;
    if (typeof blockerId !== "string" || !blockerId) {
      continue;
    }

    const blocker = issueMap.get(blockerId);
    if (!blocker) {
      continue;
    }

    if (blocker.status !== "closed") {
      blockedBy.push(blockerId);
    }
  }

  return blockedBy;
}

function hasLabel(labels, expected) {
  return labels.some((label) => label === expected);
}

function labelValue(labels, prefix) {
  for (const label of labels) {
    if (typeof label === "string" && label.startsWith(prefix)) {
      return label.slice(prefix.length);
    }
  }
  return "";
}

function deriveState(issue, labels, blockedBy) {
  if (issue.status === "closed") {
    return "done";
  }

  if (issue.status === "in_progress") {
    return "inprogress";
  }

  if (issue.status === "deferred" || hasLabel(labels, "deferred")) {
    return "deferred";
  }

  if (blockedBy.length > 0) {
    return "blocked";
  }

  return "ready";
}

function deriveTrack(issue, labels, overlay) {
  if (typeof overlay.track === "string" && overlay.track) {
    return overlay.track;
  }

  const fromLabel = labelValue(labels, "track:");
  if (fromLabel) {
    return fromLabel;
  }

  return typeof issue.issue_type === "string" && issue.issue_type
    ? issue.issue_type.toUpperCase()
    : "TASK";
}

function deriveThinking(issue, labels, overlay) {
  if (typeof overlay.thinking === "string" && overlay.thinking) {
    return overlay.thinking;
  }

  const fromLabel = labelValue(labels, "thinking:").toLowerCase();
  if (["high", "medhi", "med", "low"].includes(fromLabel)) {
    return fromLabel;
  }

  if (issue.priority === 0) {
    return "high";
  }

  if (issue.priority === 1) {
    return "medhi";
  }

  if (issue.priority === 2) {
    return "med";
  }

  return "low";
}

function deriveVerification(issue) {
  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  let failed = false;

  for (const comment of comments) {
    const text = typeof comment?.text === "string" ? comment.text : "";
    if (/^VERIFIED\b.*result=pass/m.test(text)) {
      return "pass";
    }

    if (/^VERIFICATION_FAILED\b/m.test(text)) {
      failed = true;
    }
  }

  return failed ? "fail" : null;
}

function deriveWaveKey(issue, overlay, epicById, labels) {
  if (typeof overlay.wave === "string" && overlay.wave) {
    return overlay.wave;
  }

  const epicId = epicById.get(issue.id);
  if (epicId) {
    return epicId;
  }

  const fromLabel = labelValue(labels, "wave:");
  if (fromLabel) {
    return fromLabel;
  }

  return "backlog";
}

function ensureWave(waves, key, metaWaves, issueMap) {
  if (waves.has(key)) {
    return waves.get(key);
  }

  const metaWave = metaWaves[key] && typeof metaWaves[key] === "object" ? metaWaves[key] : {};
  const epic = issueMap.get(key);
  const stableOrder = waves.size;
  const wave = {
    key,
    title: waveTitle(key, metaWave, epic),
    subtitle: typeof metaWave.subtitle === "string" ? metaWave.subtitle : "",
    ids: [],
    active: false,
    sortOrder: waveSortOrder(key, metaWave, epic, stableOrder),
    stableOrder
  };

  waves.set(key, wave);
  return wave;
}

function waveTitle(key, metaWave, epic) {
  if (typeof metaWave.title === "string" && metaWave.title) {
    return metaWave.title;
  }

  if (epic && epic.issue_type === "epic" && typeof epic.title === "string" && epic.title) {
    return epic.title;
  }

  if (key === "backlog") {
    return "Backlog";
  }

  if (/^\d+$/.test(key)) {
    return `Wave ${key}`;
  }

  return key;
}

function waveSortOrder(key, metaWave, epic, stableOrder) {
  if (typeof metaWave.order === "number" && Number.isFinite(metaWave.order)) {
    return metaWave.order;
  }

  if (epic && typeof epic.created_at === "string") {
    const time = Date.parse(epic.created_at);
    if (Number.isFinite(time)) {
      return time;
    }
  }

  if (/^\d+$/.test(key)) {
    return 10 ** 14 + Number(key);
  }

  if (key === "backlog") {
    return 10 ** 15 + stableOrder;
  }

  return 10 ** 16 + stableOrder;
}

function compareWaves(left, right) {
  if (left.active !== right.active) {
    return left.active ? -1 : 1;
  }

  if (left.sortOrder !== right.sortOrder) {
    return left.sortOrder - right.sortOrder;
  }

  return left.stableOrder - right.stableOrder;
}

function shortPhase(id) {
  const match = /([^.:-]+)$/.exec(id);
  return match ? match[1] : id;
}
