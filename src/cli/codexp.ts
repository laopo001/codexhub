import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type InstanceSummary = {
  instanceId: string;
  workingDirectory: string;
  threadId?: string;
  status: "running" | "idle" | "empty";
  running: boolean;
  attachCount: number;
  title: string;
  updatedAt: string;
  savedAt?: string;
};

const program = new Command()
  .name("codexp")
  .description("Manage codex-proxy instances")
  .option("--api <url>", "codex-proxy API URL", process.env.CODEX_PROXY_API_URL ?? "http://127.0.0.1:18788")
  .option("--cwd <path>", "directory used by folder-relative commands", process.env.CODEX_PROXY_CWD ?? process.env.INIT_CWD ?? process.cwd());

program
  .command("list")
  .description("List running/restored codex-proxy instances")
  .action(async () => {
    const data = await apiJson<{ instances?: InstanceSummary[] }>("/api/instances");
    printInstances(data.instances ?? []);
  });

program
  .command("create")
  .argument("[folder]", "working directory for the new instance")
  .description("Create a new codex-proxy instance for a folder")
  .action(async (folder: string) => {
    const workingDirectory = resolveCommandPath(folder ?? ".");
    const instance = await apiJson<InstanceSummary>("/api/instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workingDirectory })
    });
    console.log(`Created ${formatInstance(instance)}`);
  });

program
  .command("save")
  .description("Save all current instances")
  .action(async () => {
    const data = await apiJson<{ path: string; instances: InstanceSummary[] }>("/api/instances/save", { method: "POST" });
    console.log(`Saved ${data.instances.length} instances to ${data.path}`);
    printInstances(data.instances);
  });

program
  .command("restore")
  .description("Restore saved instances into the running API server")
  .action(async () => {
    const data = await apiJson<{ instances?: InstanceSummary[] }>("/api/instances/restore-saved", { method: "POST" });
    printInstances(data.instances ?? []);
  });

program
  .command("delete")
  .argument("<target>", "instance index, full id, or unique id prefix to delete")
  .description("Delete an instance and remove it from the saved registry")
  .action(async (target: string) => {
    const data = await apiJson<{ instances?: InstanceSummary[] }>("/api/instances");
    const instance = resolveInstanceTarget(target, data.instances ?? []);
    await apiJson(`/api/instances/${encodeURIComponent(instance.instanceId)}`, { method: "DELETE" });
    console.log(`Deleted ${formatInstance(instance)}`);
  });

registerTaskTemplateCommand("task-template");
registerTaskTemplateCommand("task-templete");

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function apiJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), init);
  if (!response.ok) throw new Error(`API HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

function apiUrl(path: string) {
  const options = program.opts<{ api: string }>();
  return new URL(path, options.api).toString();
}

function resolveCommandPath(...segments: string[]) {
  const options = program.opts<{ cwd: string }>();
  return path.resolve(options.cwd, ...segments);
}

function printInstances(instances: InstanceSummary[]) {
  if (!instances.length) {
    console.log("No instances.");
    return;
  }
  console.table(instances.map((instance) => ({
    instance: instance.instanceId.slice(0, 8),
    thread: instance.threadId ? instance.threadId.slice(0, 8) : "",
    status: instance.status,
    attached: instance.attachCount,
    saved: instance.savedAt ? "yes" : "no",
    folder: instance.workingDirectory,
    title: instance.title
  })));
}

function resolveInstanceTarget(target: string, instances: InstanceSummary[]) {
  const trimmed = target.trim();
  if (!trimmed) throw new Error("Missing instance target.");

  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed);
    const instance = instances[index];
    if (!instance) {
      throw new Error(`No instance at index ${index}. Run "pnpm codexp list" to see valid targets.`);
    }
    return instance;
  }

  const matches = instances.filter((instance) => instance.instanceId.startsWith(trimmed));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error([
      `Instance target "${trimmed}" is ambiguous. Matching instances:`,
      ...matches.map((instance) => `  ${formatInstance(instance)}`)
    ].join("\n"));
  }

  throw new Error(`Instance not found: ${trimmed}. Run "pnpm codexp list" to see valid targets.`);
}

function formatInstance(instance: InstanceSummary) {
  return `${instance.instanceId.slice(0, 8)} (${instance.workingDirectory}, ${instance.title})`;
}

function registerTaskTemplateCommand(name: string) {
  program
    .command(name)
    .argument("[name]", "task name", "daily-summary")
    .description("Create a .codexp task YAML template")
    .action(async (taskName: string) => {
      const safeName = safeTaskName(taskName);
      const directory = resolveCommandPath(".codexp", "tasks");
      const filePath = path.join(directory, `${safeName}.yaml`);
      await mkdir(directory, { recursive: true });
      await writeFile(filePath, taskTemplate(safeName), { encoding: "utf8", flag: "wx" });
      console.log(`Created ${filePath}`);
    });
}

function taskTemplate(name: string) {
  return `version: 1
name: ${name}
enabled: true
schedule: "0 9 * * *"
instance:
input: |
  检查这个项目昨天到今天的变更，给我总结风险和下一步。
`;
}

function safeTaskName(name: string) {
  return name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "daily-summary";
}
