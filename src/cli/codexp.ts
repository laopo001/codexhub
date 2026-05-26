import { Command } from "commander";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

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

type TaskFile = {
  workspace: string;
  filePath: string;
  valid: boolean;
  name: string;
  enabled: boolean;
  schedule: string;
  instance?: string;
  error?: string;
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
    await printInstances(data.instances ?? []);
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
    await printInstances(data.instances);
  });

program
  .command("restore")
  .description("Restore saved instances into the running API server")
  .action(async () => {
    const data = await apiJson<{ instances?: InstanceSummary[] }>("/api/instances/restore-saved", { method: "POST" });
    await printInstances(data.instances ?? []);
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

program
  .command("task")
  .argument("[first]", "ls, template, or instance target")
  .argument("[second]", "ls or template name")
  .description("Manage codexp task YAML files")
  .action(async (first?: string, second?: string) => {
    const action = taskAction(first, second);
    if (action.kind === "template") {
      await createTaskTemplate(action.name ?? "daily-summary");
      return;
    }
    if (action.kind === "ls") {
      const data = await apiJson<{ instances?: InstanceSummary[] }>("/api/instances");
      const instances = data.instances ?? [];
      const target = action.target ? resolveInstanceTarget(action.target, instances) : undefined;
      await printTasks(instances, target);
      return;
    }
    throw new Error('Usage: codexp task ls | codexp task <instance> ls | codexp task template [name]');
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

async function printInstances(instances: InstanceSummary[]) {
  if (!instances.length) {
    console.log("No instances.");
    return;
  }
  const taskCounts = await taskCountsByInstance(instances);
  console.table(instances.map((instance) => ({
    instance: instance.instanceId.slice(0, 8),
    thread: instance.threadId ? instance.threadId.slice(0, 8) : "",
    status: instance.status,
    attached: instance.attachCount,
    saved: instance.savedAt ? "yes" : "no",
    tasks: taskCounts.get(instance.instanceId) ?? 0,
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
      await createTaskTemplate(taskName);
    });
}

async function createTaskTemplate(taskName: string) {
  const safeName = safeTaskName(taskName);
  const directory = resolveCommandPath(".codexp", "tasks");
  const filePath = path.join(directory, `${safeName}.yaml`);
  await mkdir(directory, { recursive: true });
  await writeFile(filePath, taskTemplate(safeName), { encoding: "utf8", flag: "wx" });
  console.log(`Created ${filePath}`);
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

function taskAction(first?: string, second?: string):
  | { kind: "template"; name?: string }
  | { kind: "ls"; target?: string }
  | { kind: "unknown" } {
  if (!first || first === "ls" || first === "list") return { kind: "ls", target: second };
  if (first === "template" || first === "templete") return { kind: "template", name: second };
  if (second === "ls" || second === "list") return { kind: "ls", target: first };
  return { kind: "unknown" };
}

async function printTasks(instances: InstanceSummary[], target?: InstanceSummary) {
  const workspaces = target
    ? [target.workingDirectory]
    : uniqueStrings([commandCwd(), ...instances.map((instance) => instance.workingDirectory)]);
  const tasks = await loadTaskFiles(workspaces);
  const rows = tasks.map((task) => ({
    task: task.name,
    enabled: task.valid ? (task.enabled ? "yes" : "no") : "invalid",
    schedule: task.schedule,
    instance: task.instance ?? "",
    target: taskTargetLabel(task, instances, target),
    file: path.relative(task.workspace, task.filePath) || task.filePath,
    folder: task.workspace
  }));
  if (!rows.length) {
    console.log("No tasks.");
    return;
  }
  console.table(rows);
}

async function taskCountsByInstance(instances: InstanceSummary[]) {
  const counts = new Map<string, number>();
  const tasks = await loadTaskFiles(uniqueStrings(instances.map((instance) => instance.workingDirectory)));
  for (const task of tasks) {
    if (!task.valid || !task.enabled) continue;
    const target = resolveTaskInstance(task, instances);
    if (target) counts.set(target.instanceId, (counts.get(target.instanceId) ?? 0) + 1);
  }
  return counts;
}

async function loadTaskFiles(workspaces: string[]) {
  const tasks: TaskFile[] = [];
  for (const workspace of workspaces) {
    const directory = path.join(workspace, ".codexp", "tasks");
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries.filter((name) => name.endsWith(".yaml") || name.endsWith(".yml")).sort()) {
      const filePath = path.join(directory, entry);
      tasks.push(await readTaskFile(workspace, filePath));
    }
  }
  return tasks;
}

async function readTaskFile(workspace: string, filePath: string): Promise<TaskFile> {
  try {
    const parsed = YAML.parse(await readFile(filePath, "utf8"));
    if (isTaskFile(parsed)) {
      return {
        workspace,
        filePath,
        valid: true,
        name: parsed.name,
        enabled: parsed.enabled,
        schedule: parsed.schedule,
        instance: parsed.instance?.trim() || undefined
      };
    }
    return invalidTask(workspace, filePath, "invalid_schema");
  } catch (error) {
    return invalidTask(workspace, filePath, error instanceof Error ? error.message : String(error));
  }
}

function invalidTask(workspace: string, filePath: string, error: string): TaskFile {
  return {
    workspace,
    filePath,
    valid: false,
    name: path.basename(filePath, path.extname(filePath)),
    enabled: false,
    schedule: "",
    error
  };
}

function isTaskFile(value: unknown): value is { name: string; enabled: boolean; schedule: string; instance?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && typeof record.name === "string"
    && typeof record.enabled === "boolean"
    && typeof record.schedule === "string"
    && typeof record.input === "string"
    && (record.instance == null || typeof record.instance === "string");
}

function resolveTaskInstance(task: TaskFile, instances: InstanceSummary[]) {
  if (!task.valid) return null;
  const workspaceInstances = instances.filter((instance) => instance.workingDirectory === task.workspace);
  if (task.instance) {
    const matches = workspaceInstances.filter((instance) => instance.instanceId.startsWith(task.instance!));
    return matches.length === 1 ? matches[0] : null;
  }
  return workspaceInstances.length === 1 ? workspaceInstances[0] : null;
}

function taskTargetLabel(task: TaskFile, instances: InstanceSummary[], selected?: InstanceSummary) {
  if (!task.valid) return task.error ?? "invalid";
  const workspaceInstances = instances.filter((instance) => instance.workingDirectory === task.workspace);
  if (task.instance) {
    const matches = workspaceInstances.filter((instance) => instance.instanceId.startsWith(task.instance!));
    if (matches.length === 0) return "missing";
    if (matches.length > 1) return "ambiguous";
    if (selected) return matches[0].instanceId === selected.instanceId ? "this" : `other:${matches[0].instanceId.slice(0, 8)}`;
    return matches[0].instanceId.slice(0, 8);
  }
  if (workspaceInstances.length === 0) return "create";
  if (workspaceInstances.length > 1) return "ambiguous";
  if (selected) return workspaceInstances[0].instanceId === selected.instanceId ? "this" : `other:${workspaceInstances[0].instanceId.slice(0, 8)}`;
  return workspaceInstances[0].instanceId.slice(0, 8);
}

function commandCwd() {
  const options = program.opts<{ cwd: string }>();
  return path.resolve(options.cwd);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}
