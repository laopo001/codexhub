import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = process.cwd();
const artifactsDir = path.join(rootDir, "release-artifacts");
const rootPackage = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8")) as {
  name: string;
  version: string;
};
const { version } = rootPackage;

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Cannot package release with invalid version: ${version}`);
}

await rm(artifactsDir, { recursive: true, force: true });
await mkdir(artifactsDir, { recursive: true });

await import("./build-vscode.js");
await run("pnpm", ["exec", "vsce", "package", "--no-dependencies", "--out", "codexhub.vsix"], {
  cwd: path.join(rootDir, "dist-vsix"),
});
await assertPackageMetadata(path.join(rootDir, "dist-vsix", "package.json"), "codexhub", version);

await import("./build-theia.js");
await run("pnpm", ["pack", "--pack-destination", "."], {
  cwd: path.join(rootDir, "dist-theia"),
});
await assertPackageMetadata(
  path.join(rootDir, "dist-theia", "package.json"),
  "@dadigua/codexhub-theia",
  version,
);

const vsixArtifact = path.join(artifactsDir, `codexhub-${version}.vsix`);
const rootTarball = path.join(artifactsDir, `dadigua-codexhub-${version}.tgz`);
const theiaTarballName = `dadigua-codexhub-theia-${version}.tgz`;
const theiaTarball = path.join(artifactsDir, theiaTarballName);

await cp(path.join(rootDir, "dist-vsix", "codexhub.vsix"), vsixArtifact);
await cp(path.join(rootDir, "dist-theia", theiaTarballName), theiaTarball);
const packOutput = await runCapture(
  "npm",
  ["pack", "--ignore-scripts", "--json", "--pack-destination", artifactsDir],
  { cwd: rootDir },
);
const [packResult] = JSON.parse(packOutput) as Array<{
  filename: string;
  files: Array<{ path: string }>;
}>;
if (packResult?.filename !== path.basename(rootTarball)) {
  throw new Error(`Unexpected npm tarball name: ${packResult?.filename ?? "missing"}`);
}
const packedFiles = new Set(packResult.files.map((file) => file.path));
if (!packedFiles.has("dist-vsix/codexhub.vsix")) {
  throw new Error("CodexHub CLI tarball does not contain dist-vsix/codexhub.vsix.");
}
const nestedDependency = [...packedFiles].find((file) => file.includes("/node_modules/"));
if (nestedDependency) {
  throw new Error(`CodexHub CLI tarball unexpectedly contains a nested dependency: ${nestedDependency}`);
}

await Promise.all([
  assertFile(vsixArtifact),
  assertFile(rootTarball),
  assertFile(theiaTarball),
]);

console.error(`release artifacts ready for v${version}:`);
console.error(`- ${path.relative(rootDir, rootTarball)}`);
console.error(`- ${path.relative(rootDir, vsixArtifact)}`);
console.error(`- ${path.relative(rootDir, theiaTarball)}`);

async function assertFile(filePath: string) {
  const info = await stat(filePath);
  if (!info.isFile() || info.size === 0) {
    throw new Error(`Release artifact is missing or empty: ${filePath}`);
  }
}

async function assertPackageMetadata(filePath: string, expectedName: string, expectedVersion: string) {
  const manifest = JSON.parse(await readFile(filePath, "utf8")) as { name?: string; version?: string };
  if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
    throw new Error(
      `Unexpected package metadata in ${filePath}: ${manifest.name ?? "missing"}@${manifest.version ?? "missing"}`,
    );
  }
}

async function run(command: string, args: string[], options: { cwd: string }) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? `${command}.cmd` : command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function runCapture(command: string, args: string[], options: { cwd: string }) {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? `${command}.cmd` : command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["inherit", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`})`));
    });
  });
}
