import { mkdir, readFile, rm, writeFile, cp, stat } from "node:fs/promises";
import path from "node:path";
import { build, type Plugin } from "esbuild";

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
  external: ["vscode"],
  sourcemap: false,
  minify: false,
  treeShaking: true,
  plugins: [nodePtyStubPlugin()],
  logLevel: "silent"
});

await assertDirectory("dist", "Run `pnpm build` before `pnpm build:vscode`.");
await cp("dist", path.join(outDir, "dist"), { recursive: true });
await cp("targets/vscode/media", path.join(outDir, "media"), { recursive: true });
await writeFile(path.join(outDir, "package.json"), `${JSON.stringify(await extensionManifest(), null, 2)}\n`);
await cp("README.md", path.join(outDir, "README.md"));

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

async function assertDirectory(dir: string, message: string) {
  try {
    if ((await stat(dir)).isDirectory()) return;
  } catch {
    // fall through to the explicit error below
  }
  throw new Error(message);
}

function nodePtyStubPlugin(): Plugin {
  return {
    name: "codexhub-vscode-node-pty-stub",
    setup(builder) {
      builder.onResolve({ filter: /^node-pty$/ }, () => ({
        path: "node-pty",
        namespace: "codexhub-vscode-stub"
      }));
      builder.onLoad({ filter: /.*/, namespace: "codexhub-vscode-stub" }, () => ({
        loader: "js",
        contents: [
          "export const spawn = () => {",
          "  throw new Error('node-pty is not available in the CodexHub VSCode extension target');",
          "};"
        ].join("\n")
      }));
    }
  };
}
