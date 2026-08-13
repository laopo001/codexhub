import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const outfile = "dist-node/electron/main.cjs";
const preloadOutfile = "dist-node/electron/preload.cjs";
const authorityServiceOutfile = "dist-node/electron/authority-service.cjs";

await mkdir(path.dirname(outfile), { recursive: true });
await build({
  entryPoints: ["targets/electron/src/main.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  sourcemap: false,
  minify: false,
  treeShaking: true,
  logLevel: "silent"
});

const info = await stat(outfile);
await build({
  entryPoints: ["targets/electron/src/preload.ts"],
  outfile: preloadOutfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron"],
  sourcemap: false,
  minify: false,
  treeShaking: true,
  logLevel: "silent"
});
const preloadInfo = await stat(preloadOutfile);
await build({
  entryPoints: ["targets/vscode/src/authorityService.ts"],
  outfile: authorityServiceOutfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  define: { navigator: "undefined" },
  sourcemap: false,
  minify: false,
  treeShaking: true,
  logLevel: "silent"
});
const authorityInfo = await stat(authorityServiceOutfile);
console.error(`built Electron main: ${outfile} (${info.size} bytes)`);
console.error(`built Electron preload: ${preloadOutfile} (${preloadInfo.size} bytes)`);
console.error(`built Electron authority service: ${authorityServiceOutfile} (${authorityInfo.size} bytes)`);
