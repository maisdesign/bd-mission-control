import test from "node:test";
import assert from "node:assert/strict";

await import("../src/panel.js");

const {
  acceptLiveResult,
  applyCardFilters,
  computeGridFingerprint,
  decideRefreshCycle,
  decideSourceMode,
  formatSnapshotAge,
  matchesSearch,
  nextTheme,
  shouldRebuildGrid,
  shouldCommitRefreshResult
} = globalThis.BMC_PANEL_HELPERS;

test("decideSourceMode prefers live, then snapshot, then demo", () => {
  assert.equal(decideSourceMode({ fetchOk: true, snapshotPresent: true }), "live");
  assert.equal(decideSourceMode({ fetchOk: false, snapshotPresent: true }), "snapshot");
  assert.equal(decideSourceMode({ fetchOk: false, snapshotPresent: false }), "demo");
});

test("decideRefreshCycle blocks overlapping fetches and skips timer fetches outside live mode", () => {
  assert.deepEqual(
    decideRefreshCycle({ mode: "live", inFlight: false, timerTick: false }),
    { shouldFetch: true, keepModel: true, queueNext: false }
  );

  assert.deepEqual(
    decideRefreshCycle({ mode: "snapshot", inFlight: false, timerTick: true }),
    { shouldFetch: false, keepModel: true, queueNext: false }
  );

  assert.deepEqual(
    decideRefreshCycle({ mode: "live", inFlight: true, timerTick: true }),
    { shouldFetch: false, keepModel: true, queueNext: true }
  );
});

test("acceptLiveResult decision table rejects bad live payloads and allows first-load empties", () => {
  assert.deepEqual(
    acceptLiveResult({ ok: false, contentType: "application/json", parsedCount: 19, currentCount: 19 }),
    { accepted: false, reason: "status" }
  );

  assert.deepEqual(
    acceptLiveResult({ ok: true, contentType: "text/html; charset=utf-8", parsedCount: 19, currentCount: 19 }),
    { accepted: false, reason: "content-type" }
  );

  assert.deepEqual(
    acceptLiveResult({ ok: true, contentType: "application/json", parsedCount: 0, currentCount: 19 }),
    { accepted: false, reason: "empty-parse" }
  );

  assert.deepEqual(
    acceptLiveResult({ ok: true, contentType: "application/json", parsedCount: 0, currentCount: 0 }),
    { accepted: true, reason: "" }
  );

  assert.deepEqual(
    acceptLiveResult({ ok: true, contentType: "application/x-ndjson", parsedCount: 19, currentCount: 19 }),
    { accepted: true, reason: "" }
  );
});

test("shouldCommitRefreshResult keeps the last good model for rejected live or snapshot refreshes", () => {
  assert.equal(
    shouldCommitRefreshResult({
      currentCount: 19,
      source: {
        mode: "snapshot",
        issues: [{ id: "snap-1" }],
        liveResult: { ok: false, status: 404, contentType: "", issues: [] }
      }
    }),
    false
  );

  assert.equal(
    shouldCommitRefreshResult({
      currentCount: 19,
      source: {
        mode: "snapshot",
        issues: [],
        liveResult: { ok: false, status: 404, contentType: "", issues: [] }
      }
    }),
    false
  );

  assert.equal(
    shouldCommitRefreshResult({
      currentCount: 0,
      source: {
        mode: "snapshot",
        issues: [],
        liveResult: { ok: false, status: 404, contentType: "", issues: [] }
      }
    }),
    true
  );

  assert.equal(
    shouldCommitRefreshResult({
      currentCount: 19,
      source: {
        mode: "live",
        issues: [{ id: "live-1" }],
        liveResult: { ok: true, status: 200, contentType: "application/x-ndjson", issues: [{ id: "live-1" }] }
      }
    }),
    true
  );
});

test("formatSnapshotAge renders minute, hour, day, and invalid cases", () => {
  const now = Date.parse("2026-07-11T12:00:00Z");

  assert.equal(formatSnapshotAge("2026-07-11T11:59:40Z", now), "just now");
  assert.equal(formatSnapshotAge("2026-07-11T11:42:00Z", now), "18m ago");
  assert.equal(formatSnapshotAge("2026-07-11T08:00:00Z", now), "4h ago");
  assert.equal(formatSnapshotAge("2026-07-08T12:00:00Z", now), "3d ago");
  assert.equal(formatSnapshotAge("not-a-date", now), "age unknown");
});

test("nextTheme cycles auto, dark, light", () => {
  assert.equal(nextTheme("auto"), "dark");
  assert.equal(nextTheme("dark"), "light");
  assert.equal(nextTheme("light"), "auto");
  assert.equal(nextTheme("unexpected"), "dark");
});

test("matchesSearch checks id, label, track, and assignee case-insensitively", () => {
  const card = {
    id: "bmc-4",
    label: "Panel behaviors",
    track: "UI",
    assignee: "codex-lavoro"
  };

  assert.equal(matchesSearch(card, ""), true);
  assert.equal(matchesSearch(card, "behaviors"), true);
  assert.equal(matchesSearch(card, "ui"), true);
  assert.equal(matchesSearch(card, "CODEX"), true);
  assert.equal(matchesSearch(card, "missing"), false);
});

test("applyCardFilters composes status, track, and search with AND semantics", () => {
  const cards = [
    { id: "a-1", label: "Render wave", track: "UI", assignee: "codex", state: "ready" },
    { id: "a-2", label: "Refresh loop", track: "CORE", assignee: "codex", state: "inprogress" },
    { id: "a-3", label: "Blocked card", track: "UI", assignee: "agy", state: "blocked" }
  ];

  assert.deepEqual(
    applyCardFilters(cards, { status: "all", track: "all", query: "" }).map((card) => card.id),
    ["a-1", "a-2", "a-3"]
  );

  assert.deepEqual(
    applyCardFilters(cards, { status: "ready", track: "UI", query: "render" }).map((card) => card.id),
    ["a-1"]
  );

  assert.deepEqual(
    applyCardFilters(cards, { status: "blocked", track: "UI", query: "codex" }).map((card) => card.id),
    []
  );
});

test("computeGridFingerprint is deterministic and ignores timestamp-only source drift", () => {
  const filters = {
    status: "all",
    track: "all",
    query: "",
    unverifiedOnly: false
  };
  const modelA = {
    waves: [
      { key: "wave-1", title: "Wave 1", subtitle: "1/1 done", ids: ["bmc-21"] }
    ],
    beads: {
      "bmc-21": {
        state: "inprogress",
        phase: "wave:8",
        label: "Fix refresh flicker",
        track: "UI",
        thinking: "medhi",
        assignee: "codex-lavoro",
        blockedBy: [],
        note: "",
        flag: false,
        verification: null,
        updated_at: "2026-07-11T12:00:00Z"
      }
    }
  };

  const modelB = {
    waves: [
      { key: "wave-1", title: "Wave 1", subtitle: "1/1 done", ids: ["bmc-21"] }
    ],
    beads: {
      "bmc-21": {
        ...modelA.beads["bmc-21"],
        updated_at: "2026-07-11T12:05:00Z"
      }
    }
  };

  assert.equal(computeGridFingerprint(modelA, filters), computeGridFingerprint(modelA, filters));
  assert.equal(computeGridFingerprint(modelA, filters), computeGridFingerprint(modelB, filters));
});

test("computeGridFingerprint changes when rendered card fields or filters change", () => {
  const baseModel = {
    waves: [
      { key: "wave-1", title: "Wave 1", subtitle: "", ids: ["bmc-21"] }
    ],
    beads: {
      "bmc-21": {
        state: "ready",
        phase: "wave:8",
        label: "Fix refresh flicker",
        track: "UI",
        thinking: "medhi",
        assignee: "codex-lavoro",
        blockedBy: [],
        note: "",
        flag: false,
        verification: null
      }
    }
  };
  const filters = { status: "all", track: "all", query: "", unverifiedOnly: false };

  const changedStatus = {
    ...baseModel,
    beads: {
      "bmc-21": {
        ...baseModel.beads["bmc-21"],
        state: "blocked"
      }
    }
  };

  const changedAssignee = {
    ...baseModel,
    beads: {
      "bmc-21": {
        ...baseModel.beads["bmc-21"],
        assignee: "agy"
      }
    }
  };

  const changedVerification = {
    ...baseModel,
    beads: {
      "bmc-21": {
        ...baseModel.beads["bmc-21"],
        verification: "pass"
      }
    }
  };

  const baseFingerprint = computeGridFingerprint(baseModel, filters);
  assert.notEqual(baseFingerprint, computeGridFingerprint(changedStatus, filters));
  assert.notEqual(baseFingerprint, computeGridFingerprint(changedAssignee, filters));
  assert.notEqual(baseFingerprint, computeGridFingerprint(changedVerification, filters));
  assert.notEqual(baseFingerprint, computeGridFingerprint(baseModel, { ...filters, status: "ready" }));
});

test("shouldRebuildGrid only returns true when the fingerprint changes", () => {
  assert.equal(shouldRebuildGrid(null, "next"), true);
  assert.equal(shouldRebuildGrid("same", "same"), false);
  assert.equal(shouldRebuildGrid("prev", "next"), true);
});
