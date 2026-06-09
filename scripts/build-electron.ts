import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const outfile = "dist-node/electron/main.js";

await mkdir(path.dirname(outfile), { recursive: true });
await build({
  entryPoints: ["targets/electron/src/main.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  sourcemap: false,
  minify: false,
  treeShaking: true,
  logLevel: "silent"
});

const info = await stat(outfile);
console.error(`built Electron main: ${outfile} (${info.size} bytes)`);
