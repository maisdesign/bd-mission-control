import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
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

  // 1. Inject orchestration.config.js and orchestration-data.js script tags
  // We place them right before the first <script> tag.
  const scriptInject = `<script src="orchestration.config.js"></script>\n    <script src="orchestration-data.js"></script>\n    <script>`;
  html = html.replace("<script>", scriptInject);

  // 2. Remove external font imports to ensure no external network requests (fully self-contained)
  const importRegex = /@import\s+url\(['"]?https?:\/\/[^)]+['"]?\);?/gi;
  html = html.replace(importRegex, "/* Font import removed for self-contained offline demo */");

  const docsDir = path.join(rootDir, "docs");
  await mkdir(docsDir, { recursive: true });

  // 3. Write docs/index.html
  await writeFile(path.join(docsDir, "index.html"), html, "utf8");
  console.log("Created docs/index.html");

  // 4. Write docs/orchestration.config.js
  const configContent = `window.BMC_CONFIG = {
  title: "bd-mission-control // live demo",
  strings: {
    search_placeholder: "Filter telemetry...",
    footer_text: "MISSION CONTROL HUD &bull; demo data = this repo's own bead tracker"
  }
};
`;
  await writeFile(path.join(docsDir, "orchestration.config.js"), configContent, "utf8");
  console.log("Created docs/orchestration.config.js");

  // 5. Generate docs/orchestration-data.js by running the refresh script
  console.log("Generating docs/orchestration-data.js...");
  const isWindows = process.platform === "win32";
  const cmd = isWindows
    ? "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/refresh.ps1 -Out docs/orchestration-data.js"
    : "sh scripts/refresh.sh --out docs/orchestration-data.js";

  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd: rootDir });
    if (stdout) console.log(stdout.trim());
    if (stderr) console.error(stderr.trim());
    console.log("Generated docs/orchestration-data.js successfully.");
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
