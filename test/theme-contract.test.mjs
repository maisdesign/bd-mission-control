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

  const cssContent = await readFile(cssPath, "utf8");
  const templateContent = await readFile(templatePath, "utf8");
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
});
