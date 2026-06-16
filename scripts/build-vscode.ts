import { mkdir, readFile, rm, writeFile, cp, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const outDir = "dist-vscode";
const extensionOutfile = path.join(outDir, "extension.cjs");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: ["targets/vscode/src/extension.ts"],
  outfile: extensionOutfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  define: {
    navigator: "undefined"
  },
  external: ["vscode"],
  sourcemap: false,
  minify: false,
  treeShaking: true,
  logLevel: "silent"
});

await assertNoNodeHostBrowserGlobals(extensionOutfile);

await assertDirectory("dist", "Run `pnpm build` before `pnpm build:vscode`.");
await assertDirectory("dist-node/ssh", "Run `pnpm build` before `pnpm build:vscode`.");
await cp("dist", path.join(outDir, "dist"), { recursive: true });
await cp("dist-node/ssh", path.join(outDir, "dist-node", "ssh"), { recursive: true });
await cp("targets/vscode/media", path.join(outDir, "media"), { recursive: true });
await copyPackageNlsFiles();
await writeFile(path.join(outDir, "package.json"), `${JSON.stringify(await extensionManifest(), null, 2)}\n`);
await cp("README.md", path.join(outDir, "README.md"));
await cp("LICENSE", path.join(outDir, "LICENSE"));

const info = await stat(extensionOutfile);
console.error(`built VSCode extension staging: ${outDir} (${info.size} byte bundle)`);

async function extensionManifest() {
  const [rootPackage, targetManifest] = await Promise.all([
    readJson<{ version?: string }>("package.json"),
    readJson<Record<string, unknown>>("targets/vscode/package.json")
  ]);
  return {
    ...targetManifest,
    version: rootPackage.version ?? targetManifest.version
  };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function copyPackageNlsFiles() {
  const files = await readdir("targets/vscode");
  await Promise.all(
    files
      .filter((file) => /^package\.nls(?:\.[a-z0-9-]+)?\.json$/i.test(file))
      .map((file) => cp(path.join("targets/vscode", file), path.join(outDir, file)))
  );
}

async function assertDirectory(dir: string, message: string) {
  try {
    if ((await stat(dir)).isDirectory()) return;
  } catch {
    // fall through to the explicit error below
  }
  throw new Error(message);
}

async function assertNoNodeHostBrowserGlobals(filePath: string) {
  const bundle = await readFile(filePath, "utf8");
  if (/\bnavigator\b/.test(bundle)) {
    throw new Error("VSCode extension bundle unexpectedly references `navigator` in the Node extension host.");
  }
}
