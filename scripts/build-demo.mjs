import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

async function main() {
  console.log("Building GitHub Pages demo...");

  const distHtmlPath = path.join(rootDir, "dist", "orchestration.html");
  let html = "";
  try {
    html = await readFile(distHtmlPath, "utf8");
  } catch (error) {
    console.error("Error reading dist/orchestration.html. Make sure to run 'node build.mjs' first.");
    process.exit(1);
  }

  // 1. Remove external font imports to ensure no external network requests (fully self-contained)
  const importRegex = /@import\s+url\(['"]?https?:\/\/[^)]+['"]?\);?/gi;
  html = html.replace(importRegex, "/* Font import removed for self-contained offline demo */");

  const outDir =
    process.env.BMC_DEMO_OUT_DIR && process.env.BMC_DEMO_OUT_DIR.trim() !== ""
      ? path.resolve(process.env.BMC_DEMO_OUT_DIR)
      : path.join(rootDir, "docs");
  await mkdir(outDir, { recursive: true });

  // 2. Write index.html
  const indexPath = path.join(outDir, "index.html");
  await writeFile(indexPath, html, "utf8");
  console.log(`Created ${indexPath}`);

  // 3. Write orchestration.config.js
  const configContent = `window.BMC_CONFIG = {
  title: "bd-mission-control // live demo",
  strings: {
    search_placeholder: "Filter telemetry...",
    footer_text: "TAKY MISSION CONTROL HUD • demo data = synthetic fixture"
  }
  };
`;
  const configPath = path.join(outDir, "orchestration.config.js");
  await writeFile(configPath, configContent, "utf8");
  console.log(`Created ${configPath}`);

  // 4. Read only the synthetic fixture; no tracker discovery or bd enrichment.
  const dataPath = path.join(outDir, "orchestration-data.js");
  console.log(`Generating ${dataPath}...`);

  try {
    const issuesJsonl = (await readFile(path.join(rootDir, "demo", "issues.jsonl"), "utf8"))
      .replace(/\r\n/g, "\n");
    const snapshot = {
      // Fixed fixture timestamp keeps published demo artifacts reproducible.
      generated_at: "2031-04-14T16:00:00.000Z",
      source: "demo/issues.jsonl",
      issues_jsonl: issuesJsonl,
    };
    await writeFile(
      dataPath,
      `window.BMC_SNAPSHOT = ${JSON.stringify(snapshot)};\n`,
      "utf8"
    );
    console.log(`Generated ${dataPath} successfully.`);
  } catch (error) {
    console.error("Error generating orchestration-data.js:", error.message);
    process.exit(1);
  }

  console.log("\nDemo build complete!");
  console.log("To regenerate the demo in the future, run the single command:");
  console.log("  node scripts/build-demo.mjs");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
