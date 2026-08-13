import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build, createTargets, Platform } from "electron-builder";

const rootDirectory = process.cwd();
const stagingDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhub-electron-"));
const outputDirectory = path.join(rootDirectory, "release-artifacts", "electron");
const sourcePackage = JSON.parse(
  await readFile(path.join(rootDirectory, "package.json"), "utf8")
) as {
  version: string;
  description?: string;
  license?: string;
};
const electronPackage = JSON.parse(
  await readFile(path.join(rootDirectory, "node_modules", "electron", "package.json"), "utf8")
) as { version: string };
const directoryOnly = process.argv.includes("--dir");
const requestedTarget = process.argv.filter((value) => value.startsWith("--"));
const unsupportedArguments = requestedTarget.filter((value) => value !== "--win" && value !== "--dir");
if (unsupportedArguments.length) {
  throw new Error(`Unsupported Electron package argument: ${unsupportedArguments.join(", ")}`);
}

await rm(stagingDirectory, { recursive: true, force: true });
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(path.join(stagingDirectory, "dist-node", "electron"), { recursive: true });
await mkdir(path.join(stagingDirectory, "dist-node", "ssh"), { recursive: true });
await mkdir(path.join(stagingDirectory, "build"), { recursive: true });

try {
  await cp(path.join(rootDirectory, "dist", "."), path.join(stagingDirectory, "dist"), { recursive: true });
  await cp(
    path.join(rootDirectory, "dist-node", "electron", "main.cjs"),
    path.join(stagingDirectory, "dist-node", "electron", "main.cjs")
  );
  await cp(
    path.join(rootDirectory, "dist-node", "electron", "authority-service.cjs"),
    path.join(stagingDirectory, "dist-node", "electron", "authority-service.cjs")
  );
  await cp(
    path.join(rootDirectory, "dist-node", "ssh", "remote-client.cjs"),
    path.join(stagingDirectory, "dist-node", "ssh", "remote-client.cjs")
  );
  await cp(
    path.join(rootDirectory, "targets", "vscode", "media", "codexhub.svg"),
    path.join(stagingDirectory, "build", "codexhub.svg")
  );

  await writeFile(
    path.join(stagingDirectory, "package.json"),
    `${JSON.stringify({
      name: "codexhub",
      version: sourcePackage.version,
      description: sourcePackage.description,
      license: sourcePackage.license,
      author: "CodexHub",
      type: "module",
      main: "dist-node/electron/main.cjs"
    }, null, 2)}\n`
  );

  const artifacts = await build({
    projectDir: stagingDirectory,
    targets: createTargets([Platform.WINDOWS], directoryOnly ? "dir" : "nsis", "x64"),
    config: {
      appId: "com.dadigua.codexhub",
      productName: "CodexHub",
      electronVersion: electronPackage.version,
      artifactName: "CodexHub-Setup-${version}-${arch}.${ext}",
      asar: true,
      compression: "normal",
      npmRebuild: false,
      nodeGypRebuild: false,
      publish: null,
      directories: {
        output: outputDirectory,
        buildResources: "build"
      },
      files: [
        "package.json",
        "dist-node/electron/main.cjs"
      ],
      extraResources: [
        { from: "dist", to: "codexhub/dist" },
        { from: "dist-node/electron/authority-service.cjs", to: "codexhub/authority-service.cjs" },
        { from: "dist-node/ssh/remote-client.cjs", to: "codexhub/dist-node/ssh/remote-client.cjs" }
      ],
      win: {
        executableName: "codexhub",
        icon: "build/codexhub.svg",
        target: directoryOnly
          ? [{ target: "dir", arch: ["x64"] }]
          : [{ target: "nsis", arch: ["x64"] }]
      },
      nsis: directoryOnly
        ? undefined
        : {
          oneClick: false,
          perMachine: false,
          allowToChangeInstallationDirectory: true,
          createDesktopShortcut: true,
          createStartMenuShortcut: true,
          shortcutName: "CodexHub",
          runAfterFinish: false,
          deleteAppDataOnUninstall: false
        }
    }
  });

  const files = await Promise.all(artifacts.map(async (artifact) => {
    const info = await stat(artifact);
    return `${path.relative(rootDirectory, artifact)} (${info.size} bytes)`;
  }));
  console.error(`Electron Windows ${directoryOnly ? "directory" : "installer"} ready:`);
  for (const file of files) console.error(`- ${file}`);
} finally {
  await rm(stagingDirectory, { recursive: true, force: true });
}
