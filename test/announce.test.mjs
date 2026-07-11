import test from "node:test";
import assert from "node:assert/strict";

await import("../src/panel.js");

const {
  buildAnnouncementValues,
  interpolateAnnouncementTemplate,
  mergeAnnounceConfig,
  selectAnnouncementVoice,
  shouldAnnounce
} = globalThis.BMC_PANEL_HELPERS;

test("interpolateAnnouncementTemplate fills all placeholders and blanks missing keys safely", () => {
  const values = buildAnnouncementValues({
    counts: {
      ready: 3,
      inprogress: 2,
      blocked: 1,
      done: 5,
      deferred: 4,
      all: 15
    },
    pct: 33
  }, "Alpha, Beta");

  assert.equal(
    interpolateAnnouncementTemplate(
      "{ready}|{inprogress}|{blocked}|{done}|{deferred}|{all}|{pct}|{newlyDone}|{missing}",
      values
    ),
    "3|2|1|5|4|15|33|Alpha, Beta|"
  );
});

test("shouldAnnounce decides timer and completion triggers independently", () => {
  assert.deepEqual(
    shouldAnnounce({ everyMs: 30000, elapsedMs: 30000, everyDone: 2, doneCount: 1, changed: true }),
    { timer: true, completion: false }
  );

  assert.deepEqual(
    shouldAnnounce({ everyMs: 30000, elapsedMs: 45000, everyDone: 2, doneCount: 2, changed: false }),
    { timer: false, completion: true }
  );

  assert.deepEqual(
    shouldAnnounce({ everyMs: 0, elapsedMs: 99999, everyDone: 0, doneCount: 10, changed: true }),
    { timer: false, completion: false }
  );
});

test("selectAnnouncementVoice matches by substring and falls back to default voice", () => {
  const voices = [
    { name: "Narrator - English", default: false },
    { name: "Jarvis Prime", default: false },
    { name: "System Default", default: true }
  ];

  assert.equal(selectAnnouncementVoice(voices, "jarvis")?.name, "Jarvis Prime");
  assert.equal(selectAnnouncementVoice(voices, "missing")?.name, "System Default");
  assert.equal(selectAnnouncementVoice([], "jarvis"), null);
});

test("mergeAnnounceConfig applies defaults, local storage override, and string templates", () => {
  assert.deepEqual(
    mergeAnnounceConfig(
      { enabled: false, everyMs: "1200", everyDone: "3", rate: 12, pitch: -1, template: "" },
      true,
      { announce_template: "Rapporto. {done}/{all}.", announce_completionTemplate: "Completati: {newlyDone}." }
    ),
    {
      enabled: true,
      everyMs: 1200,
      everyDone: 3,
      voice: "",
      lang: "en-US",
      rate: 10,
      pitch: 0,
      template: "Rapporto. {done}/{all}.",
      completionTemplate: "Completati: {newlyDone}."
    }
  );
});
