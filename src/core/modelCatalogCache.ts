import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ModelCatalogItem } from "../shared/threadTypes.js";

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

const modelCatalogCacheEntrySchema = z.object({
  machineId: z.string().min(1),
  cliVersion: z.string().min(1),
  codexHome: z.string().min(1),
  includeHidden: z.boolean(),
  updatedAt: z.string().datetime(),
  models: z.array(modelCatalogItemSchema)
});

const modelCatalogCacheFileSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), modelCatalogCacheEntrySchema)
});

type ModelCatalogCacheFile = z.infer<typeof modelCatalogCacheFileSchema>;

export type ModelCatalogCacheKey = {
  machineId: string;
  cliVersion: string;
  codexHome: string;
  includeHidden: boolean;
};

export type ModelCatalogCacheEntry = ModelCatalogCacheKey & {
  updatedAt: string;
  models: ModelCatalogItem[];
};

export class ModelCatalogCache {
  private loaded: Promise<ModelCatalogCacheFile> | null = null;
  private saveQueue = Promise.resolve();

  constructor(readonly filePath = modelCatalogCachePath()) {}

  async get(key: ModelCatalogCacheKey): Promise<ModelCatalogCacheEntry | undefined> {
    const data = await this.load();
    const entry = data.entries[modelCatalogCacheKey(key)];
    return entry ? structuredClone(entry) as ModelCatalogCacheEntry : undefined;
  }

  async set(entry: ModelCatalogCacheEntry) {
    this.saveQueue = this.saveQueue.catch(() => undefined).then(async () => {
      const data = await this.read();
      data.entries[modelCatalogCacheKey(entry)] = structuredClone(entry);
      await this.save(data);
      this.loaded = Promise.resolve(data);
    });
    await this.saveQueue;
  }

  private async load() {
    this.loaded ??= this.read();
    return await this.loaded;
  }

  private async read(): Promise<ModelCatalogCacheFile> {
    try {
      const parsed = modelCatalogCacheFileSchema.safeParse(JSON.parse(await readFile(this.filePath, "utf8")));
      if (parsed.success) return parsed.data;
      console.warn(`Ignoring invalid CodexHub model catalog cache: ${this.filePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Unable to read CodexHub model catalog cache ${this.filePath}: ${errorText(error)}`);
      }
    }
    return { version: 1, entries: {} };
  }

  private async save(data: ModelCatalogCacheFile) {
    const directory = path.dirname(this.filePath);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`
    );
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export const modelCatalogCachePath = (
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir()
) => path.join(
  path.resolve(env.CODEX_HUB_DATA_DIR?.trim() || path.join(homeDirectory, ".config", "codexhub")),
  "model-catalog-cache.json"
);

export const activeCodexHome = (
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir()
) => path.resolve(env.CODEX_HOME?.trim() || path.join(homeDirectory, ".codex"));

const modelCatalogCacheKey = (key: ModelCatalogCacheKey) => JSON.stringify([
  key.machineId,
  key.cliVersion,
  key.codexHome,
  key.includeHidden
]);

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
