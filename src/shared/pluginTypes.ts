/** 插件贡献的静态资源，当前只允许由 server 以受限路径提供。 */
export type PluginAssetContribution = {
  path: string;
  url: string;
};

/** 插件来源；builtin 表示内建插件，local 表示本地插件目录。 */
export type PluginOrigin = "builtin" | "local";

/** integration 的执行边界；external 只表示元数据，不执行外部 JS。 */
export type PluginIntegrationRunner = "builtin" | "external";

/** 插件贡献的 integration 摘要，供 Web 显示配置和运行状态。 */
export type PluginIntegrationContribution = {
  type: string;
  runner: PluginIntegrationRunner;
  enabled: boolean;
  label?: string;
  requiredEnv: string[];
  configured?: boolean;
  started?: boolean;
};

/** Web/API 可见的插件摘要。 */
export type PluginSummary = {
  pluginId: string;
  name: string;
  version?: string;
  enabled: boolean;
  origin: PluginOrigin;
  root: string;
  contributions: {
    web: {
      styles: PluginAssetContribution[];
    };
    integrations: PluginIntegrationContribution[];
  };
};

/** plugin manifest 中 integration 字段的原始声明形状。 */
export type PluginIntegrationManifest = string | {
  type?: string;
  runner?: PluginIntegrationRunner;
  label?: string;
  enabled?: boolean;
  requiredEnv?: string[];
};

/** 插件清单文件的共享结构。 */
export type PluginManifest = {
  version?: number;
  id?: string;
  name?: string;
  enabled?: boolean;
  contributes?: {
    web?: {
      styles?: string[];
    };
    integrations?: PluginIntegrationManifest[];
  };
};

/** 内建插件注册到 PluginHub 时使用的定义。 */
export type BuiltinPluginDefinition = {
  root: string;
  manifest: PluginManifest;
};

/** 内建 integration 的运行态状态，由 server 注入到插件摘要。 */
export type PluginIntegrationState = {
  configured?: boolean;
  started?: boolean;
};
