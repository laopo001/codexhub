import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  ModelCatalogItem,
  PermissionProfileSummary
} from "../shared/threadTypes.js";

const modelCatalogOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional()
});

const modelCatalogItemSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  hidden: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  defaultReasoningEffort: z.string().nullable().optional(),
  supportedReasoningEfforts: z.array(modelCatalogOptionSchema),
  defaultServiceTier: z.string().nullable().optional(),
  serviceTiers: z.array(modelCatalogOptionSchema)
});

const permissionProfileSchema = z.object({
  id: z.string().min(1),
  description: z.string().nullable(),
  allowed: z.boolean()
});

const runtimeCatalogCacheBaseSchema = {
  machineId: z.string().min(1),
  cliVersion: z.string().min(1),
  codexHome: z.string().min(1),
  updatedAt: z.string().datetime()
};

const modelCatalogCacheEntrySchema = z.object({
  ...runtimeCatalogCacheBaseSchema,
  kind: z.literal("models"),
  includeHidden: z.boolean(),
  items: z.array(modelCatalogItemSchema)
});

const permissionProfileCacheEntrySchema = z.object({
  ...runtimeCatalogCacheBaseSchema,
  kind: z.literal("permission_profiles"),
  cwd: z.string().min(1),
  items: z.array(permissionProfileSchema)
});

const runtimeCatalogCacheEntrySchema = z.discriminatedUnion("kind", [
  modelCatalogCacheEntrySchema,
  permissionProfileCacheEntrySchema
]);

const runtimeCatalogCacheFileSchema = z.object({
  version: z.literal(1),
  entry: runtimeCatalogCacheEntrySchema
});

type RuntimeCatalogCacheBaseKey = {
  machineId: string;
  cliVersion: string;
  codexHome: string;
};

export type ModelCatalogCacheKey = RuntimeCatalogCacheBaseKey & {
  kind: "models";
  includeHidden: boolean;
};

export type PermissionProfileCatalogCacheKey = RuntimeCatalogCacheBaseKey & {
  kind: "permission_profiles";
  cwd: string;
};

export type RuntimeCatalogCacheKey =
  | ModelCatalogCacheKey
  | PermissionProfileCatalogCacheKey;

export type ModelCatalogCacheEntry = ModelCatalogCacheKey & {
  updatedAt: string;
  items: ModelCatalogItem[];
};

export type PermissionProfileCatalogCacheEntry = PermissionProfileCatalogCacheKey & {
  updatedAt: string;
  items: PermissionProfileSummary[];
};

export type RuntimeCatalogCacheEntry =
  | ModelCatalogCacheEntry
  | PermissionProfileCatalogCacheEntry;

export type RuntimeCatalogResult<T> = {
  items: T[];
  source: "live" | "cache";
  updatedAt: string;
  stale: boolean;
};

type RuntimeCatalogResolveOptions<T> = {
  refresh?: boolean;
  ttlMs: number;
  fetch: () => Promise<T[]>;
  deriveEntries?: (
    items: T[],
    updatedAt: string
  ) => RuntimeCatalogCacheEntry[];
  onBackgroundRefreshError?: (error: unknown) => void;
};

type RuntimeCatalogItem =
  | ModelCatalogItem
  | PermissionProfileSummary;

export class RuntimeCatalogCache {
  private readonly refreshes = new Map<string, Promise<RuntimeCatalogResult<unknown>>>();

  constructor(readonly directoryPath = runtimeCatalogCachePath()) {}

  async resolve(
    key: ModelCatalogCacheKey,
    options: RuntimeCatalogResolveOptions<ModelCatalogItem>
  ): Promise<RuntimeCatalogResult<ModelCatalogItem>>;
  async resolve(
    key: PermissionProfileCatalogCacheKey,
    options: RuntimeCatalogResolveOptions<PermissionProfileSummary>
  ): Promise<RuntimeCatalogResult<PermissionProfileSummary>>;
  async resolve(
    key: RuntimeCatalogCacheKey,
    options:
      | RuntimeCatalogResolveOptions<ModelCatalogItem>
      | RuntimeCatalogResolveOptions<PermissionProfileSummary>
  ): Promise<RuntimeCatalogResult<RuntimeCatalogItem>> {
    const cached = await this.read(key);
    if (cached && !options.refresh) {
      const stale = Date.now() - Date.parse(cached.updatedAt) >= options.ttlMs;
      if (stale) {
        void this.refresh(
          key,
          options as RuntimeCatalogResolveOptions<RuntimeCatalogItem>
        ).catch((error) => options.onBackgroundRefreshError?.(error));
      }
      return {
        items: cached.items,
        source: "cache",
        updatedAt: cached.updatedAt,
        stale
      };
    }
    return await this.refresh(
      key,
      options as RuntimeCatalogResolveOptions<RuntimeCatalogItem>
    );
  }

  private async refresh<T extends RuntimeCatalogItem>(
    key: RuntimeCatalogCacheKey,
    options: RuntimeCatalogResolveOptions<T>
  ): Promise<RuntimeCatalogResult<T>> {
    const cacheKey = runtimeCatalogCacheKey(key);
    const pending = this.refreshes.get(cacheKey);
    if (pending) return await pending as RuntimeCatalogResult<T>;

    const refresh = this.fetchAndPersist(key, options);
    this.refreshes.set(cacheKey, refresh as Promise<RuntimeCatalogResult<unknown>>);
    try {
      return await refresh;
    } finally {
      if (this.refreshes.get(cacheKey) === refresh) this.refreshes.delete(cacheKey);
    }
  }

  private async fetchAndPersist<T extends RuntimeCatalogItem>(
    key: RuntimeCatalogCacheKey,
    options: RuntimeCatalogResolveOptions<T>
  ): Promise<RuntimeCatalogResult<T>> {
    const items = await options.fetch();
    const updatedAt = new Date().toISOString();
    await this.write([
      { ...key, updatedAt, items } as RuntimeCatalogCacheEntry,
      ...(options.deriveEntries?.(items, updatedAt) ?? [])
    ]).catch((error) => {
      console.warn(`Unable to persist CodexHub runtime catalog cache ${this.directoryPath}: ${errorText(error)}`);
    });
    return { items, source: "live", updatedAt, stale: false };
  }

  private async read(key: RuntimeCatalogCacheKey): Promise<RuntimeCatalogCacheEntry | undefined> {
    const filePath = this.entryPath(key);
    try {
      const parsed = runtimeCatalogCacheFileSchema.safeParse(JSON.parse(await readFile(filePath, "utf8")));
      if (
        parsed.success
        && runtimeCatalogCacheKey(parsed.data.entry) === runtimeCatalogCacheKey(key)
      ) {
        return parsed.data.entry;
      }
      console.warn(`Ignoring invalid CodexHub runtime catalog cache entry: ${filePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Unable to read CodexHub runtime catalog cache entry ${filePath}: ${errorText(error)}`);
      }
    }
    return undefined;
  }

  private async write(entries: RuntimeCatalogCacheEntry[]) {
    await mkdir(this.directoryPath, { recursive: true, mode: 0o700 });
    await chmod(this.directoryPath, 0o700);
    await Promise.all(entries.map(async (entry) => {
      const filePath = this.entryPath(entry);
      const temporaryPath = path.join(
        this.directoryPath,
        `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
      );
      try {
        await writeFile(
          temporaryPath,
          `${JSON.stringify({ version: 1, entry }, null, 2)}\n`,
          { mode: 0o600 }
        );
        await chmod(temporaryPath, 0o600);
        await rename(temporaryPath, filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    }));
  }

  private entryPath(key: RuntimeCatalogCacheKey) {
    const digest = createHash("sha256").update(runtimeCatalogCacheKey(key)).digest("hex");
    return path.join(this.directoryPath, `${digest}.json`);
  }
}

export const runtimeCatalogCachePath = (
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir()
) => path.join(
  path.resolve(env.CODEX_HUB_DATA_DIR?.trim() || path.join(homeDirectory, ".config", "codexhub")),
  "runtime-catalog-cache"
);

export const activeCodexHome = (
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir()
) => path.resolve(env.CODEX_HOME?.trim() || path.join(homeDirectory, ".codex"));

const runtimeCatalogCacheKey = (key: RuntimeCatalogCacheKey) => JSON.stringify(
  key.kind === "models"
    ? [key.kind, key.machineId, key.cliVersion, key.codexHome, key.includeHidden]
    : [key.kind, key.machineId, key.cliVersion, key.codexHome, key.cwd]
);

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
