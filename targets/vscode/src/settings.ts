/** Settings owned by the VS Code extension host itself. */
export type VscodeExtensionSettings = {
  enabled: boolean;
};

export const defaultVscodeExtensionSettings: VscodeExtensionSettings = {
  enabled: true
};

type VscodeConfiguration = {
  get: <T>(section: string, defaultValue?: T) => T | undefined;
};

const booleanSetting = (
  configuration: VscodeConfiguration,
  key: "enabled",
  fallback: boolean
) => {
  const value = configuration.get<unknown>(key, fallback);
  return typeof value === "boolean" ? value : fallback;
};

export const readVscodeExtensionSettings = (
  configuration: VscodeConfiguration
): VscodeExtensionSettings => ({
  enabled: booleanSetting(configuration, "enabled", defaultVscodeExtensionSettings.enabled)
});
