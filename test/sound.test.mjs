import test from "node:test";
import assert from "node:assert/strict";

await import("../src/panel.js");

const {
  buildCompletionChime,
  collectDoneIds,
  diffDoneIds,
  mergeSoundConfig
} = globalThis.BMC_PANEL_HELPERS;

test("collectDoneIds and diffDoneIds detect only newly completed beads across refreshes", () => {
  const baseline = collectDoneIds({
    beads: {
      "bmc-1": { state: "ready" },
      "bmc-2": { state: "done" },
      "bmc-3": { state: "done" }
    }
  });

  const second = collectDoneIds({
    beads: {
      "bmc-1": { state: "done" },
      "bmc-2": { state: "done" },
      "bmc-3": { state: "blocked" },
      "bmc-4": { state: "done" }
    }
  });

  const third = collectDoneIds({
    beads: {
      "bmc-1": { state: "done" },
      "bmc-2": { state: "done" },
      "bmc-3": { state: "done" },
      "bmc-4": { state: "done" }
    }
  });

  assert.deepEqual(baseline, ["bmc-2", "bmc-3"]);
  assert.deepEqual(diffDoneIds(null, baseline), []);
  assert.deepEqual(diffDoneIds(baseline, second), ["bmc-1", "bmc-4"]);
  assert.deepEqual(diffDoneIds(second, third), ["bmc-3"]);
});

test("buildCompletionChime returns a short two-tone ping and a longer 100 percent resolve", () => {
  const ping = buildCompletionChime({
    now: 10,
    volume: 0.5,
    previousPct: 70,
    nextPct: 75
  });

  assert.equal(ping.length, 2);
  assert.deepEqual(ping.map((note) => note.frequency), [880, 1320]);
  assert.equal(ping[0].start, 10);
  assert.equal(ping[1].start > ping[0].start, true);
  assert.equal(ping[0].gain > ping[1].gain, true);

  const resolve = buildCompletionChime({
    now: 20,
    volume: 0.5,
    previousPct: 95,
    nextPct: 100
  });

  assert.equal(resolve.length, 3);
  assert.deepEqual(resolve.map((note) => note.frequency), [880, 1320, 1760]);
  assert.equal(resolve[2].duration > resolve[0].duration, true);
});

test("mergeSoundConfig applies defaults, clamps volume, and honors local storage override", () => {
  assert.deepEqual(mergeSoundConfig(undefined, null), {
    enabled: false,
    volume: 0.5
  });

  assert.deepEqual(mergeSoundConfig({ enabled: true, volume: 2 }, null), {
    enabled: true,
    volume: 1
  });

  assert.deepEqual(mergeSoundConfig({ enabled: false, volume: -1 }, true), {
    enabled: true,
    volume: 0
  });
});
