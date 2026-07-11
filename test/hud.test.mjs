import test from "node:test";
import assert from "node:assert/strict";

await import("../src/panel.js");

const {
  getTelemetryAgeBucket,
  mapVerificationBadge,
  parseAttemptValue,
  parseLockTelemetry
} = globalThis.BMC_PANEL_HELPERS;

test("getTelemetryAgeBucket buckets fresh, warm, stale, and unknown timestamps", () => {
  const now = Date.parse("2026-07-11T14:20:00+02:00");

  assert.deepEqual(getTelemetryAgeBucket("2026-07-11T14:05:00+02:00", now), {
    tone: "fresh",
    label: "AGE 15m"
  });

  assert.deepEqual(getTelemetryAgeBucket("2026-07-11T13:10:00+02:00", now), {
    tone: "warm",
    label: "AGE 70m"
  });

  assert.deepEqual(getTelemetryAgeBucket("2026-07-11T11:05:00+02:00", now), {
    tone: "stale",
    label: "AGE 3h"
  });

  assert.deepEqual(getTelemetryAgeBucket("bad-value", now), {
    tone: "unknown",
    label: "AGE ?"
  });
});

test("mapVerificationBadge maps ledger verification states for done cards", () => {
  assert.deepEqual(mapVerificationBadge("pass", "done"), {
    tone: "pass",
    text: "VERIFIED",
    title: "independent verification passed"
  });

  assert.deepEqual(mapVerificationBadge("fail", "done"), {
    tone: "fail",
    text: "VERIFY FAILED",
    title: "independent verification failed"
  });

  assert.deepEqual(mapVerificationBadge(null, "done"), {
    tone: "drift",
    text: "unverified",
    title: "closed without independent verification (drift)"
  });

  assert.equal(mapVerificationBadge("pass", "ready"), null);
});

test("parseAttemptValue extracts attempt count and ignores unrelated text", () => {
  assert.equal(parseAttemptValue("attempt=2 worker=codex-lavoro base_sha=123"), 2);
  assert.equal(parseAttemptValue("ATTEMPT missing"), null);
  assert.equal(parseAttemptValue("attempt=abc"), null);
});

test("parseLockTelemetry extracts holder, last confirmation, and handoff id", () => {
  const parsed = parseLockTelemetry(
    "ORCHESTRATOR_LOCK holder=claude-fable profile=x session=y acquired=2026-07-11T11:30:00+02:00 last_confirmation=2026-07-11T14:00:00+02:00 handoff_id=none"
  );

  assert.deepEqual(parsed, {
    holder: "claude-fable",
    lastConfirmation: "2026-07-11T14:00:00+02:00",
    handoffId: "none"
  });
});
