import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

test("Theme contract gates validation", async () => {
  const cssPath = path.join(rootDir, "src", "panel.css");
  const templatePath = path.join(rootDir, "src", "panel.template.html");
  const panelJsPath = path.join(rootDir, "src", "panel.js");

  const cssContent = await readFile(cssPath, "utf8");
  const templateContent = await readFile(templatePath, "utf8");
  const panelJsContent = await readFile(panelJsPath, "utf8");
  const combined = cssContent + "\n" + templateContent;

  // 1. Zero matches for prohibited project brands (case-insensitive)
  const forbiddenBrands = ["ScuolA+", "Orizzonte"];
  for (const brand of forbiddenBrands) {
    const hasBrand = combined.toLowerCase().includes(brand.toLowerCase());
    assert.strictEqual(
      hasBrand,
      false,
      `Prohibited brand '${brand}' was found in the visual code files`
    );
  }

  // 2. Required features check
  const requiredKeywords = [
    "prefers-color-scheme",
    "prefers-reduced-motion",
    "data-theme",
    "--bmc-accent",
    "--bmc-accent-rgb",
    "data-i18n"
  ];

  for (const keyword of requiredKeywords) {
    const hasKeyword = combined.includes(keyword);
    assert.strictEqual(
      hasKeyword,
      true,
      `Required keyword/feature '${keyword}' was not found in the visual code files`
    );
  }

  // 3. No external URLs in the visual bundle sources.
  assert.strictEqual(
    /https?:\/\//i.test(combined),
    false,
    "Visual code files must not contain external http(s) URLs"
  );

  // 4. The handoff requires broad i18n coverage.
  const i18nMatches = combined.match(/data-i18n=/g) || [];
  assert.ok(
    i18nMatches.length >= 20,
    `Expected at least 20 data-i18n hooks, found ${i18nMatches.length}`
  );

  // 5. Jarvis handoff structural gates.
  const requiredStructures = [
    "boot-overlay",
    "ticker-track",
    "ring-progress",
    "--ring-percent",
    "card-tpl",
    "particle p26"
  ];

  for (const marker of requiredStructures) {
    assert.ok(
      combined.includes(marker),
      `Required Jarvis structure '${marker}' was not found in the visual code files`
    );
  }

  // 6. A11y regression gates for bmc-19.
  const politeLiveMatches = templateContent.match(/aria-live="polite"/g) || [];
  assert.ok(
    politeLiveMatches.length >= 1,
    "Expected at least one polite live region in the template"
  );

  assert.ok(
    templateContent.includes('role="progressbar"'),
    "Expected the template to expose a progressbar role for the completion ring"
  );

  assert.ok(
    panelJsContent.includes("aria-pressed"),
    "Expected panel.js to wire aria-pressed states for interactive toggles"
  );

  const hiddenDecorativeMarkers = [
    'class="particles" aria-hidden="true"',
    'class="ticker-window" aria-hidden="true"'
  ];

  for (const marker of hiddenDecorativeMarkers) {
    assert.ok(
      templateContent.includes(marker),
      `Expected decorative element marker '${marker}' in the template`
    );
  }

  assert.ok(
    cssContent.includes(":focus-visible"),
    "Expected focus-visible styles in panel.css"
  );
});
