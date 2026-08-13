import os from "node:os";
import path from "node:path";
import { chmod, copyFile, mkdir, stat } from "node:fs/promises";

/** Resolve the shared CodexHub data directory used by ordinary and embedded authorities. */
export const codexHubDataDirectory = (
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir()
) => path.resolve(
  env.CODEX_HUB_DATA_DIR?.trim() || path.join(homeDirectory, ".config", "codexhub")
);

/** VSCode and Electron deliberately use the same authority data directory. */
export const embeddedAuthorityDataDirectory = codexHubDataDirectory;

/**
 * 0.7.0 的 VSCode authority 曾把状态放在 extension globalStorageUri。
 * 新的 VSCode/Electron shared authority 使用 CODEX_HUB_DATA_DIR；只在目标
 * 文件不存在时迁移旧文件，避免覆盖用户后来已经创建的共享 authority。
 */
export const migrateLegacyEmbeddedAuthorityData = async (
  legacyDataDir: string,
  dataDir: string
) => {
  const legacy = path.resolve(legacyDataDir);
  const target = path.resolve(dataDir);
  if (legacy === target) return false;
  await mkdir(target, { recursive: true });
  let migrated = false;
  for (const fileName of ["config.yaml", "server-state.yaml", "vscode-authority-id"]) {
    const sourcePath = path.join(legacy, fileName);
    const targetPath = path.join(target, fileName);
    if (!await isFile(sourcePath) || await isFile(targetPath)) continue;
    await copyFile(sourcePath, targetPath);
    await chmod(targetPath, 0o600).catch(() => undefined);
    migrated = true;
  }
  return migrated;
};

const isFile = async (filePath: string) => {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
};
