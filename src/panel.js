function getWindowValue(name) {
  if (typeof globalThis[name] !== "undefined") {
    return globalThis[name];
  }

  if (globalThis.window && typeof globalThis.window === "object" && typeof globalThis.window[name] !== "undefined") {
    return globalThis.window[name];
  }

  return undefined;
}

function setWindowValue(name, value) {
  globalThis[name] = value;
  if (globalThis.window && typeof globalThis.window === "object") {
    globalThis.window[name] = value;
  }
}

function resolveSnapshotPayload() {
  const snapshotValue = getWindowValue("BMC_SNAPSHOT");
  const snapshot = snapshotValue && typeof snapshotValue === "object"
    ? snapshotValue
    : {};

  let issues = [];
  if (typeof snapshot.issues_jsonl === "string") {
    issues = parseJSONL(snapshot.issues_jsonl);
  } else if (Array.isArray(snapshot.issues)) {
    issues = snapshot.issues;
  }

  let meta = {};
  const legacyMeta = getWindowValue("BMC_META");
  if (legacyMeta && typeof legacyMeta === "object" && !Array.isArray(legacyMeta)) {
    meta = legacyMeta;
  }

  const metaJson = getWindowValue("BMC_META_JSON");
  if (typeof metaJson === "string") {
    try {
      const parsedMeta = JSON.parse(metaJson);
      if (parsedMeta && typeof parsedMeta === "object" && !Array.isArray(parsedMeta)) {
        meta = parsedMeta;
      }
    } catch (error) {
      if (typeof console !== "undefined" && typeof console.info === "function") {
        console.info("Ignoring invalid BMC_META_JSON payload", error);
      }
    }
  }

  return {
    snapshot,
    issues,
    meta,
    model: deriveModel(issues, meta)
  };
}

function init() {
  setWindowValue("BMC_RUNTIME", resolveSnapshotPayload());
}

setWindowValue("BMC_PANEL", {
  resolveSnapshotPayload,
  init
});

if (typeof document !== "undefined" && document && typeof document.addEventListener === "function") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
