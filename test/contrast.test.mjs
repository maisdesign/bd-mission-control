import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

function parseVarBlock(block) {
  const vars = {};
  for (const match of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    vars[match[1]] = match[2].trim();
  }
  return vars;
}

function extractThemeVars(css) {
  const rootBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  const darkBlock = css.match(/\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  const lightBlock = css.match(/\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  const rootVars = parseVarBlock(rootBlock);

  return {
    dark: { ...rootVars, ...parseVarBlock(darkBlock) },
    light: { ...rootVars, ...parseVarBlock(lightBlock) }
  };
}

function resolveValue(value, vars, seen = new Set()) {
  return String(value).replace(/var\((--[\w-]+)\)/g, (_match, name) => {
    if (seen.has(name)) {
      throw new Error(`Circular var() reference for ${name}`);
    }

    const next = vars[name];
    if (!next) {
      throw new Error(`Missing CSS variable ${name}`);
    }

    seen.add(name);
    const resolved = resolveValue(next, vars, seen);
    seen.delete(name);
    return resolved;
  }).trim();
}

function parseColor(value, vars) {
  const resolved = resolveValue(value, vars);
  if (resolved.startsWith("#")) {
    const hex = resolved.slice(1);
    const normalized = hex.length === 3
      ? hex.split("").map((char) => char + char).join("")
      : hex;

    return {
      r: Number.parseInt(normalized.slice(0, 2), 16),
      g: Number.parseInt(normalized.slice(2, 4), 16),
      b: Number.parseInt(normalized.slice(4, 6), 16),
      a: 1
    };
  }

  const rgbMatch = resolved.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(",").map((part) => part.trim());
    return {
      r: Number(parts[0]),
      g: Number(parts[1]),
      b: Number(parts[2]),
      a: parts[3] === undefined ? 1 : Number(parts[3])
    };
  }

  throw new Error(`Unsupported color expression: ${value} -> ${resolved}`);
}

function composite(foreground, background) {
  const alpha = foreground.a ?? 1;
  return {
    r: Math.round((foreground.r * alpha) + (background.r * (1 - alpha))),
    g: Math.round((foreground.g * alpha) + (background.g * (1 - alpha))),
    b: Math.round((foreground.b * alpha) + (background.b * (1 - alpha))),
    a: 1
  };
}

function flattenBackground(layers, vars) {
  const colors = layers.map((layer) => parseColor(layer, vars));
  return colors.reduceRight((background, layer) => composite(layer, background));
}

function toLuminance(color) {
  const channels = [color.r, color.g, color.b].map((value) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrastRatio(foreground, background) {
  const [lighter, darker] = [toLuminance(foreground), toLuminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const textPairs = [
  {
    name: "hud button",
    foreground: "var(--bmc-button-text)",
    backgroundLayers: ["var(--bmc-button-bg)", "var(--bmc-card-bg)", "var(--bmc-bg)"]
  },
  {
    name: "armed voice/sound button",
    foreground: "var(--bmc-armed-button-text)",
    backgroundLayers: ["var(--bmc-armed-button-bg)", "var(--bmc-card-bg)", "var(--bmc-bg)"]
  },
  {
    name: "filter chip",
    foreground: "var(--bmc-chip-text)",
    backgroundLayers: ["var(--bmc-chip-bg)", "var(--bmc-bg)"]
  },
  {
    name: "active chip",
    foreground: "var(--bmc-chip-active-text)",
    backgroundLayers: ["var(--bmc-chip-active-bg)"]
  },
  {
    name: "ready pill",
    foreground: "var(--bmc-ready-tone)",
    backgroundLayers: ["var(--bmc-ready-bg)", "var(--bmc-card-bg)", "var(--bmc-bg)"]
  },
  {
    name: "inprogress pill",
    foreground: "var(--bmc-progress-tone)",
    backgroundLayers: ["var(--bmc-progress-bg)", "var(--bmc-card-bg)", "var(--bmc-bg)"]
  },
  {
    name: "blocked pill",
    foreground: "var(--bmc-blocked-tone)",
    backgroundLayers: ["var(--bmc-blocked-bg)", "var(--bmc-card-bg)", "var(--bmc-bg)"]
  },
  {
    name: "done pill",
    foreground: "var(--bmc-done-tone)",
    backgroundLayers: ["var(--bmc-done-bg)", "var(--bmc-card-bg)", "var(--bmc-bg)"]
  },
  {
    name: "deferred pill",
    foreground: "var(--bmc-deferred-tone)",
    backgroundLayers: ["var(--bmc-deferred-bg)", "var(--bmc-card-bg)", "var(--bmc-bg)"]
  },
  {
    name: "think high pill",
    foreground: "var(--bmc-think-high-tone)",
    backgroundLayers: ["var(--bmc-think-high-bg)", "var(--bmc-card-bg)", "var(--bmc-bg)"]
  },
  {
    name: "think medhi pill",
    foreground: "var(--bmc-think-medhi-tone)",
    backgroundLayers: ["var(--bmc-think-medhi-bg)", "var(--bmc-card-bg)", "var(--bmc-bg)"]
  },
  {
    name: "think med pill",
    foreground: "var(--bmc-think-med-tone)",
    backgroundLayers: ["var(--bmc-think-med-bg)", "var(--bmc-card-bg)", "var(--bmc-bg)"]
  },
  {
    name: "think low pill",
    foreground: "var(--bmc-think-low-tone)",
    backgroundLayers: ["var(--bmc-think-low-bg)", "var(--bmc-card-bg)", "var(--bmc-bg)"]
  },
  {
    name: "verify pass pill",
    foreground: "var(--bmc-verify-pass-tone)",
    backgroundLayers: ["var(--bmc-verify-pass-bg)", "var(--bmc-card-bg)", "var(--bmc-bg)"]
  },
  {
    name: "verify fail pill",
    foreground: "var(--bmc-verify-fail-tone)",
    backgroundLayers: ["var(--bmc-verify-fail-bg)", "var(--bmc-card-bg)", "var(--bmc-bg)"]
  },
  {
    name: "verify drift pill",
    foreground: "var(--bmc-verify-drift-tone)",
    backgroundLayers: ["var(--bmc-verify-drift-bg)", "var(--bmc-card-bg)", "var(--bmc-bg)"]
  }
];

test("button, pill, and chip text pairs stay at or above AA contrast in both themes", async () => {
  const css = await readFile(path.join(rootDir, "src", "panel.css"), "utf8");
  const themeVars = extractThemeVars(css);
  const failures = [];

  for (const [themeName, vars] of Object.entries(themeVars)) {
    for (const pair of textPairs) {
      const foreground = parseColor(pair.foreground, vars);
      const background = flattenBackground(pair.backgroundLayers, vars);
      const ratio = contrastRatio(foreground, background);

      if (ratio < 4.5) {
        failures.push(`${themeName} ${pair.name} = ${ratio.toFixed(2)}:1`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("panel.css does not hide horizontal overflow on html/body", async () => {
  const css = await readFile(path.join(rootDir, "src", "panel.css"), "utf8");
  const forbidden = Array.from(css.matchAll(/(?:^|\n)(html|body)\s*\{([\s\S]*?)\n\}/g))
    .filter(([, , block]) => /\boverflow(?:-x)?\s*:\s*hidden\b/i.test(block))
    .map(([fullMatch]) => fullMatch.trim().split("\n")[0]);

  assert.deepEqual(
    forbidden,
    [],
    "Do not reintroduce overflow:hidden on html/body; fix the overflowing element instead"
  );
});
