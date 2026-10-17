// Builds the unpacked extension into dist/. Load dist/ via chrome://extensions.
// `--e2e` builds the supervised end-to-end test variant into dist-e2e/
// (submission on, one worker, confirm-before-Generate; see src/shared/features.ts).
import * as esbuild from "esbuild";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderIcon } from "./icons.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const e2e = process.argv.includes("--e2e");
const dist = resolve(root, e2e ? "dist-e2e" : "dist");
const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  target: "chrome116",
  sourcemap: "linked",
  logLevel: "info",
  legalComments: "none",
  define: {
    __STUDIO_E2E__: e2e ? "true" : "false",
    __STUDIO_BUILD_ID__: JSON.stringify(`${e2e ? "e2e" : "prod"}-${new Date().toISOString()}`),
  },
};

const builds = [
  { entryPoints: [resolve(root, "src/background/service-worker.ts")], outfile: resolve(dist, "background/service-worker.js"), format: "esm" },
  { entryPoints: [resolve(root, "src/content/content-script.ts")], outfile: resolve(dist, "content/content-script.js"), format: "iife" },
  { entryPoints: [resolve(root, "src/popup/main.ts")], outfile: resolve(dist, "popup/main.js"), format: "iife" },
];

async function copyStatic() {
  await mkdir(resolve(dist, "popup"), { recursive: true });
  await mkdir(resolve(dist, "icons"), { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  if (e2e) {
    manifest.name = `${manifest.name} (E2E TEST BUILD)`;
    manifest.action.default_title = "Studio — E2E test";
  }
  await writeFile(resolve(dist, "manifest.json"), JSON.stringify(manifest, null, 2));
  await copyFile(resolve(root, "src/popup/index.html"), resolve(dist, "popup/index.html"));
  await copyFile(resolve(root, "src/popup/styles.css"), resolve(dist, "popup/styles.css"));
  for (const size of [16, 32, 48, 128]) {
    await writeFile(resolve(dist, `icons/icon-${size}.png`), renderIcon(size));
  }
}

await rm(dist, { recursive: true, force: true });
await copyStatic();

if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context({ ...common, ...b });
    await ctx.watch();
  }
  console.log("watching… (static files are copied once; restart for manifest/html/css changes)");
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...common, ...b })));
  console.log(`build id: ${common.define.__STUDIO_BUILD_ID__}`);
}
