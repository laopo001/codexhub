import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { build, type BuildOptions } from "esbuild";

const outDir = "dist-theia";
const libDir = path.join(outDir, "lib");
const external = ["@theia/*", "@theia/electron", "electron"];

await rm(outDir, { recursive: true, force: true });
await mkdir(libDir, { recursive: true });

const common: BuildOptions = {
  bundle: true,
  format: "cjs",
  target: "node20",
  external,
  sourcemap: false,
  minify: false,
  treeShaking: true,
  logLevel: "silent",
};

await Promise.all([
  build({
    ...common,
    platform: "browser",
    entryPoints: ["targets/theia/src/browser/codexhub-frontend-module.ts"],
    outfile: path.join(libDir, "browser", "codexhub-frontend-module.js"),
  }),
  build({
    ...common,
    platform: "browser",
    entryPoints: ["targets/theia/src/electron-browser/codexhub-electron-frontend-module.ts"],
    outfile: path.join(libDir, "electron-browser", "codexhub-electron-frontend-module.js"),
  }),
  build({
    ...common,
    platform: "node",
    entryPoints: ["targets/theia/src/electron-main/codexhub-electron-main-module.ts"],
    outfile: path.join(libDir, "electron-main", "codexhub-electron-main-module.js"),
  }),
  build({
    ...common,
    platform: "node",
    entryPoints: ["targets/theia/src/node/codexhub-backend-module.ts"],
    outfile: path.join(libDir, "node", "codexhub-backend-module.js"),
  }),
]);

await assertDirectory("dist", "Run `pnpm build` before `pnpm build:theia`.");
await assertDirectory("dist-node/ssh", "Run `pnpm build` before `pnpm build:theia`.");
await cp("dist", path.join(outDir, "dist"), { recursive: true });
await cp("dist-node/ssh", path.join(outDir, "dist-node", "ssh"), { recursive: true });
await cp("targets/theia/README.md", path.join(outDir, "README.md"));
await cp("LICENSE", path.join(outDir, "LICENSE"));
await writeFile(path.join(outDir, "package.json"), `${JSON.stringify(await packageManifest(), null, 2)}\n`);

const backendInfo = await stat(path.join(libDir, "node", "codexhub-backend-module.js"));
console.error(`built Theia target staging: ${outDir} (${backendInfo.size} byte backend bundle)`);

async function packageManifest() {
  const [rootPackage, targetManifest] = await Promise.all([
    readJson<{ version?: string }>("package.json"),
    readJson<Record<string, unknown>>("targets/theia/package.json"),
  ]);
  const {
    devDependencies: _devDependencies,
    scripts: _scripts,
    ...publishable
  } = targetManifest;
  return {
    ...publishable,
    type: "commonjs",
    version: rootPackage.version ?? targetManifest.version,
  };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function assertDirectory(directory: string, message: string) {
  try {
    if ((await stat(directory)).isDirectory()) return;
  } catch {
    // Fall through to the explicit error below.
  }
  throw new Error(message);
}
