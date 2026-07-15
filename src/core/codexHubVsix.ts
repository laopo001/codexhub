import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const codexHubExtensionId = "dadigua.codexhub";

export async function resolveCodexHubVsixPath(input?: string) {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = input?.trim()
    ? [path.resolve(expandHome(input.trim()))]
    : [
        process.env.CODEX_HUB_VSIX?.trim(),
        process.env.CODEX_HUB_THEIA_VSIX?.trim(),
        path.resolve(moduleDir, "../../dist-vsix/codexhub.vsix"),
        path.resolve(moduleDir, "../../../dist-vsix/codexhub.vsix"),
        path.resolve(process.cwd(), "dist-vsix/codexhub.vsix"),
      ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of [...new Set(candidates)]) {
    const resolved = path.resolve(expandHome(candidate));
    if (await isFile(resolved)) return resolved;
  }
  throw new Error([
    "The shared CodexHub VSIX was not found.",
    "Reinstall a published @dadigua/codexhub package that includes it, or pass --vsix <path>.",
    "From a source checkout, run `pnpm run package:vscode` first.",
  ].join(" "));
}

function expandHome(value: string) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function isFile(filePath: string) {
  try {
    await access(filePath);
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}
