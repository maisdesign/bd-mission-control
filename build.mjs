import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const packageJson = JSON.parse(
    await readFile(path.join(__dirname, "package.json"), "utf8")
  );

  const [template, css, engine, panel] = await Promise.all([
    readFile(path.join(__dirname, "src", "panel.template.html"), "utf8"),
    readFile(path.join(__dirname, "src", "panel.css"), "utf8"),
    readFile(path.join(__dirname, "src", "engine.mjs"), "utf8"),
    readFile(path.join(__dirname, "src", "panel.js"), "utf8")
  ]);

  // Engine exports must be plain declarations when vendored into the browser bundle.
  const inlinedEngine = engine.replace(/^export\s+/gm, "");

  const output = template
    .replaceAll("{{VERSION}}", packageJson.version)
    .replace("{{CSS}}", css.trimEnd())
    .replace("{{ENGINE_JS}}", inlinedEngine.trimEnd())
    .replace("{{PANEL_JS}}", panel.trimEnd());

  const unresolved = output.match(/\{\{[A-Z_]+\}\}/g);
  if (unresolved) {
    console.error(
      `Unresolved placeholders in dist/orchestration.html: ${unresolved.join(", ")}`
    );
    process.exit(1);
  }

  const distDir = path.join(__dirname, "dist");
  await mkdir(distDir, { recursive: true });
  await writeFile(path.join(distDir, "orchestration.html"), output, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
