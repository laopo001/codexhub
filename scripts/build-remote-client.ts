import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const outfile = "dist-node/ssh/remote-client.cjs";

await mkdir(path.dirname(outfile), { recursive: true });
await build({
  entryPoints: ["src/cli/codexhubRemoteClient.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: false,
  minify: false,
  treeShaking: true,
  logLevel: "silent"
});

const output = await readFile(outfile, "utf8");
if (output.includes("node_modules/.pnpm")) {
  throw new Error("remote client bundle unexpectedly references package-manager store paths");
}

const info = await stat(outfile);
console.error(`built SSH remote client: ${outfile} (${info.size} bytes)`);
