import {
  defaultCommitMessageModel,
  defaultCommitMessagePrompt
} from "../../../src/shared/commitMessageGeneration.js";

/** Settings owned by the VS Code extension host itself. */
export type VscodeExtensionSettings = {
  toolsModel: string;
  gitCommitModel: string;
  gitCommitPrompt: string;
};

export const defaultVscodeExtensionSettings: VscodeExtensionSettings = {
  toolsModel: defaultCommitMessageModel,
  gitCommitModel: "",
  gitCommitPrompt: defaultCommitMessagePrompt
};

type VscodeConfiguration = {
  get: <T>(section: string, defaultValue?: T) => T | undefined;
};

const stringSetting = (
  configuration: VscodeConfiguration,
  key: "tools.model" | "gitCommit.model" | "gitCommit.prompt",
  fallback: string
) => {
  const value = configuration.get<unknown>(key, fallback);
  return typeof value === "string" ? value.trim() : fallback;
};

export const readVscodeExtensionSettings = (
  configuration: VscodeConfiguration
): VscodeExtensionSettings => ({
  toolsModel: stringSetting(configuration, "tools.model", defaultVscodeExtensionSettings.toolsModel)
    || defaultVscodeExtensionSettings.toolsModel,
  gitCommitModel: stringSetting(configuration, "gitCommit.model", defaultVscodeExtensionSettings.gitCommitModel),
  gitCommitPrompt: stringSetting(configuration, "gitCommit.prompt", defaultVscodeExtensionSettings.gitCommitPrompt)
    || defaultVscodeExtensionSettings.gitCommitPrompt
});

export const vscodeToolModel = (settings: VscodeExtensionSettings, override?: string) =>
  override?.trim() || settings.toolsModel;
