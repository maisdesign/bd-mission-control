import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  deepMergeStrings,
  defaultStrings,
  deriveModel,
  parseJSONL
} from "../src/engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

test("parseJSONL skips blank and corrupt lines without throwing", () => {
  const parsed = parseJSONL([
    "",
    "not json",
    "{\"id\":\"ok-1\",\"status\":\"open\"}",
    "   ",
    "{\"id\":\"ok-2\",\"status\":\"closed\"}",
    "{broken"
  ].join("\n"));

  assert.deepEqual(
    parsed.map((issue) => issue.id),
    ["ok-1", "ok-2"]
  );
});

test("deepMergeStrings overlays nested user strings over defaults", () => {
  const merged = deepMergeStrings({
    status: { ready: "Pronto" },
    empty: { title: "Nessun bead" }
  });

  assert.equal(merged.status.ready, "Pronto");
  assert.equal(merged.status.done, defaultStrings.status.done);
  assert.equal(merged.empty.title, "Nessun bead");
  assert.equal(merged.empty.body, defaultStrings.empty.body);
});

test("deriveModel builds the expected fixture summary", async () => {
  const fixtureText = await readFile(
    path.join(rootDir, "fixtures", "issues.sample.jsonl"),
    "utf8"
  );
  const issues = parseJSONL(fixtureText);
  const model = deriveModel(issues);

  assert.equal(issues.length, 26);
  assert.deepEqual(model.counts, {
    all: 26,
    ready: 2,
    inprogress: 4,
    blocked: 8,
    done: 8,
    deferred: 4
  });
  assert.equal(model.pct, 31);

  assert.equal(model.beads["smp-a1.4"].state, "ready");
  assert.equal(model.beads["smp-c4"].state, "blocked");
  assert.deepEqual(model.beads["smp-c4"].blockedBy, ["smp-c5"]);
  assert.equal(model.beads["smp-a2.2"].verification, "fail");
  assert.equal(model.beads["smp-c8"].verification, "pass");
  assert.equal(model.beads["smp-c9"].verification, null);
  assert.equal(model.beads["smp-c6"].epic, null);
  assert.equal(model.beads["smp-c6"].track, "OPS");
  assert.equal(model.beads["smp-c6"].thinking, "low");
  assert.equal(model.beads["smp-a1.1"].epic, "smp-a1");

  assert.deepEqual(
    model.waves.map((wave) => wave.key),
    ["smp-a1", "smp-a2", "1", "2", "backlog", "3", "4"]
  );
  assert.deepEqual(model.waves.find((wave) => wave.key === "backlog")?.ids, ["smp-c6"]);
});

test("deriveModel handles a blocked chain with open blockers only", () => {
  const issues = [
    { id: "chain-a", title: "A", status: "open", issue_type: "task" },
    {
      id: "chain-b",
      title: "B",
      status: "open",
      issue_type: "task",
      dependencies: [{ depends_on_id: "chain-a", type: "blocks" }]
    },
    {
      id: "chain-c",
      title: "C",
      status: "open",
      issue_type: "task",
      dependencies: [{ depends_on_id: "chain-b", type: "blocks" }]
    },
    {
      id: "chain-d",
      title: "D",
      status: "open",
      issue_type: "task",
      dependencies: [{ depends_on_id: "missing", type: "blocks" }]
    }
  ];

  const model = deriveModel(issues);

  assert.equal(model.beads["chain-a"].state, "ready");
  assert.equal(model.beads["chain-b"].state, "blocked");
  assert.equal(model.beads["chain-c"].state, "blocked");
  assert.deepEqual(model.beads["chain-c"].blockedBy, ["chain-b"]);
  assert.equal(model.beads["chain-d"].state, "ready");
});

test("deriveModel groups dot-id and parent-child issues into epic waves", () => {
  const issues = [
    {
      id: "epic-1",
      title: "Epic one",
      status: "open",
      issue_type: "epic",
      created_at: "2026-07-01T08:00:00Z"
    },
    {
      id: "epic-1.1",
      title: "Dot child",
      status: "open",
      issue_type: "task"
    },
    {
      id: "task-2",
      title: "Dependency child",
      status: "open",
      issue_type: "task",
      dependencies: [{ depends_on_id: "epic-1", type: "parent-child" }]
    }
  ];

  const model = deriveModel(issues);

  assert.deepEqual(model.waves.map((wave) => wave.key), ["epic-1"]);
  assert.deepEqual(model.waves[0].ids, ["epic-1", "epic-1.1", "task-2"]);
  assert.equal(model.beads["epic-1.1"].epic, "epic-1");
  assert.equal(model.beads["task-2"].epic, "epic-1");
});

test("labels override heuristics and meta overrides labels", () => {
  const issues = [
    {
      id: "meta-1",
      title: "Meta bead",
      status: "open",
      priority: 4,
      issue_type: "task",
      labels: ["track:UI", "thinking:low", "wave:7"]
    }
  ];

  const model = deriveModel(issues, {
    waves: {
      custom: {
        title: "Curated Wave",
        subtitle: "Overlay wins",
        order: 0
      }
    },
    beads: {
      "meta-1": {
        wave: "custom",
        phase: "beta",
        track: "OPS",
        thinking: "high",
        note: "Decision changed",
        flag: true
      }
    }
  });

  assert.equal(model.beads["meta-1"].track, "OPS");
  assert.equal(model.beads["meta-1"].thinking, "high");
  assert.equal(model.beads["meta-1"].phase, "beta");
  assert.equal(model.beads["meta-1"].note, "Decision changed");
  assert.equal(model.beads["meta-1"].flag, true);
  assert.deepEqual(model.waves, [
    {
      key: "custom",
      title: "Curated Wave",
      subtitle: "Overlay wins",
      ids: ["meta-1"]
    }
  ]);
});

test("deferred label overrides open status and missing optional fields never throw", () => {
  const issues = [
    {
      id: "defer-1",
      title: "Deferred by label",
      status: "open",
      issue_type: "task",
      labels: ["deferred"]
    },
    {
      id: "bare-1",
      title: "Bare minimum",
      status: "open",
      issue_type: "bug",
      priority: 1
    }
  ];

  const model = deriveModel(issues);

  assert.equal(model.beads["defer-1"].state, "deferred");
  assert.equal(model.beads["bare-1"].state, "ready");
  assert.equal(model.beads["bare-1"].track, "BUG");
  assert.equal(model.beads["bare-1"].thinking, "medhi");
  assert.equal(model.beads["bare-1"].verification, null);
  assert.deepEqual(model.beads["bare-1"].blockedBy, []);
  assert.equal(model.beads["bare-1"].assignee, "");
});

test("wave ordering sinks exhausted waves while preserving active-wave order", () => {
  const issues = [
    {
      id: "wave-2-live",
      title: "Active numeric wave",
      status: "open",
      issue_type: "task",
      labels: ["wave:2"]
    },
    {
      id: "wave-1-done",
      title: "Exhausted numeric wave",
      status: "closed",
      issue_type: "task",
      labels: ["wave:1"]
    },
    {
      id: "backlog-live",
      title: "Active backlog",
      status: "in_progress",
      issue_type: "task"
    }
  ];

  const model = deriveModel(issues);

  assert.deepEqual(
    model.waves.map((wave) => wave.key),
    ["2", "backlog", "1"]
  );
});
