import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type JsonRecord = Record<string, unknown>;
type RequestId = string | number;
type ProbeMode = "read" | "shell-command" | "turn";

type ProbeOptions = {
  cwd: string;
  mode: ProbeMode;
  appServerUrl?: string;
  port?: number;
  threadId?: string;
  model?: string;
  prompt: string;
  command: string;
  timeoutMs: number;
  out?: string;
  autoApprove: boolean;
  allowNoTool: boolean;
  verbose: boolean;
  withDynamicTool: boolean;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type Frame = {
  at: string;
  direction: "in" | "out";
  message: unknown;
};

type Waiter = {
  label: string;
  predicate: (message: JsonRecord) => boolean;
  resolve: (message: JsonRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type ToolItemSummary = {
  turnId?: string;
  id?: string;
  type: string;
  status?: string;
  command?: string;
  tool?: string;
  server?: string;
  name?: string;
};

const toolItemTypes = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
  "collabAgentToolCall"
]);

const defaultCommand = "printf codexhub_app_server_probe";
const defaultPrompt = [
  "Run this exact shell command, then answer with the observed output:",
  "`printf codexhub_app_server_probe`.",
  "Do not answer from memory; use the shell command."
].join(" ");

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const startedAppServer = options.appServerUrl
    ? null
    : await startCodexAppServer(options.cwd, options.port);
  const appServerUrl = options.appServerUrl ?? startedAppServer!.url;
  const client = await JsonRpcClient.connect(appServerUrl, options);

  try {
    await client.initialize();
    const threadId = await ensureThread(client, options);

    if (options.mode === "shell-command") {
      await runShellCommandProbe(client, threadId, options);
    } else if (options.mode === "turn") {
      await runTurnProbe(client, threadId, options);
    }

    const snapshot = await client.request<JsonRecord>("thread/read", { threadId, includeTurns: true });
    const turnsList = await readAllTurns(client, threadId);
    const turnIds = uniqueStrings([
      ...threadTurns(snapshot).map((turn) => typeof turn.id === "string" ? turn.id : ""),
      ...turnsList.map((turn) => typeof turn.id === "string" ? turn.id : "")
    ]);
    const turnItemsProbe = await readItemsForTurns(client, threadId, turnIds);
    const summary = buildSummary({
      appServerUrl,
      threadId,
      mode: options.mode,
      snapshot,
      turnsList,
      turnItems: turnItemsProbe.itemsByTurn,
      turnItemsErrors: turnItemsProbe.errors,
      frames: client.frames,
      serverRequests: client.serverRequests,
      notifications: client.notifications
    });

    if (options.out) {
      await writeFile(
        options.out,
        `${JSON.stringify({ summary, frames: client.frames, snapshot, turnsList, turnItems: turnItemsProbe }, null, 2)}\n`
      );
    }

    console.log(JSON.stringify(summary, null, 2));
    if (!summary.appServerSnapshotHasToolItems && !options.allowNoTool) {
      throw new Error("No app-server read/list API returned any known tool item");
    }
  } finally {
    client.close();
    await stopChild(startedAppServer?.child);
  }
};

class JsonRpcClient {
  readonly frames: Frame[] = [];
  readonly notifications: JsonRecord[] = [];
  readonly serverRequests: JsonRecord[] = [];
  private nextId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly waiters = new Set<Waiter>();

  private constructor(
    private readonly ws: WebSocket,
    private readonly options: ProbeOptions
  ) {}

  static async connect(url: string, options: ProbeOptions) {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error(`WebSocket failed: ${url}`)), { once: true });
    });
    const client = new JsonRpcClient(ws, options);
    ws.addEventListener("message", (event) => client.handleIncoming(String(event.data)));
    ws.addEventListener("close", () => client.rejectAll(new Error("app-server websocket closed")));
    return client;
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: {
        name: "codexhub_app_server_transcript_probe",
        title: "CodexHub app-server transcript probe",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    });
    this.notify("initialized");
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.options.timeoutMs) {
    const id = this.nextId++;
    const message = params === undefined ? { id, method } : { id, method, params };
    this.send(message);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for response to ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });
    });
  }

  notify(method: string, params?: unknown) {
    this.send(params === undefined ? { method } : { method, params });
  }

  waitFor(predicate: (message: JsonRecord) => boolean, label: string, timeoutMs = this.options.timeoutMs) {
    for (const message of this.notifications) {
      if (predicate(message)) return Promise.resolve(message);
    }
    return new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${label}`));
      }, timeoutMs);
      timer.unref?.();
      const waiter: Waiter = { label, predicate, resolve, reject, timer };
      this.waiters.add(waiter);
    });
  }

  close() {
    this.ws.close();
    this.rejectAll(new Error("probe closed"));
  }

  private send(message: unknown) {
    this.frames.push({ at: new Date().toISOString(), direction: "out", message });
    if (this.options.verbose) console.error(`client -> ${JSON.stringify(message)}`);
    this.ws.send(JSON.stringify(message));
  }

  private handleIncoming(data: string) {
    const message = parseJsonRecord(data);
    if (!message) return;
    this.frames.push({ at: new Date().toISOString(), direction: "in", message });
    if (this.options.verbose) console.error(`server -> ${JSON.stringify(message)}`);

    const id = message.id;
    const method = typeof message.method === "string" ? message.method : "";
    if (isRequestId(id) && method) {
      this.serverRequests.push(message);
      this.respondToServerRequest(id, method, message);
      return;
    }

    if (isRequestId(id)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      const error = asRecord(message.error);
      if (error) pending.reject(new Error(JSON.stringify(error)));
      else pending.resolve(message.result);
      return;
    }

    if (method) {
      this.notifications.push(message);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(message)) continue;
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  }

  private respondToServerRequest(id: RequestId, method: string, message: JsonRecord) {
    if (method === "item/tool/call") {
      this.send({
        id,
        result: {
          contentItems: [{ type: "inputText", text: "codexhub_dynamic_tool_probe" }],
          success: true
        }
      });
      return;
    }

    if (method === "item/commandExecution/requestApproval") {
      const params = asRecord(message.params);
      const command = typeof params?.command === "string" ? params.command : "";
      const safeDefaultShellProbe = this.options.mode === "shell-command" && command === this.options.command;
      this.send({ id, result: { decision: this.options.autoApprove || safeDefaultShellProbe ? "accept" : "decline" } });
      return;
    }

    if (method === "item/fileChange/requestApproval") {
      this.send({ id, result: { decision: this.options.autoApprove ? "accept" : "decline" } });
      return;
    }

    if (method === "item/permissions/requestApproval") {
      const params = asRecord(message.params);
      this.send({ id, result: permissionsApprovalResponse(this.options.autoApprove, params) });
      return;
    }

    if (method === "item/tool/requestUserInput") {
      this.send({ id, result: { answers: {} } });
      return;
    }

    if (method === "currentTime/read") {
      this.send({ id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
      return;
    }

    if (method === "mcpServer/elicitation/request") {
      const params = asRecord(message.params);
      this.send({
        id,
        result: this.options.autoApprove
          ? { action: "accept", content: mcpElicitationDefaultContent(params), _meta: null }
          : { action: "cancel", content: null, _meta: null }
      });
      return;
    }

    this.send({
      id,
      error: {
        code: -32601,
        message: `probe does not handle app-server request: ${method}`
      }
    });
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}

const ensureThread = async (client: JsonRpcClient, options: ProbeOptions) => {
  if (options.threadId) {
    const result = await client.request<JsonRecord>("thread/resume", {
      threadId: options.threadId,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {})
    });
    const thread = asRecord(result.thread);
    const threadId = typeof thread?.id === "string" ? thread.id : options.threadId;
    console.error(`resumed thread: ${threadId}`);
    return threadId;
  }

  const result = await client.request<JsonRecord>("thread/start", {
    cwd: options.cwd,
    ...(options.model ? { model: options.model } : {}),
    approvalPolicy: "never",
    sandbox: "workspace-write",
    threadSource: "user",
    ...(options.withDynamicTool ? { dynamicTools: [dynamicToolSpec()] } : {})
  });
  const thread = asRecord(result.thread);
  const threadId = typeof thread?.id === "string" ? thread.id : undefined;
  if (!threadId) throw new Error(`thread/start did not return thread.id: ${JSON.stringify(result)}`);
  console.error(`started thread: ${threadId}`);
  return threadId;
};

const runShellCommandProbe = async (client: JsonRpcClient, threadId: string, options: ProbeOptions) => {
  await client.request("thread/shellCommand", { threadId, command: options.command });
  await client.waitFor((message) => {
    if (message.method !== "item/completed") return false;
    const params = asRecord(message.params);
    const item = asRecord(params?.item);
    return params?.threadId === threadId && item?.type === "commandExecution";
  }, "commandExecution item/completed", 30_000).catch(async () => {
    await delay(500);
  });
};

const runTurnProbe = async (client: JsonRpcClient, threadId: string, options: ProbeOptions) => {
  await client.request("turn/start", {
    threadId,
    cwd: options.cwd,
    input: [{ type: "text", text: options.prompt }]
  });
  await client.waitFor((message) => {
    const params = asRecord(message.params);
    return message.method === "turn/completed" && params?.threadId === threadId;
  }, "turn/completed");
};

const readAllTurns = async (client: JsonRpcClient, threadId: string) => {
  const turns: JsonRecord[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await client.request<JsonRecord>("thread/turns/list", {
      threadId,
      cursor,
      limit: 50,
      sortDirection: "asc",
      itemsView: "full"
    });
    turns.push(...arrayRecords(result.data));
    cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
    if (!cursor) break;
  }
  return turns;
};

const readItemsForTurns = async (client: JsonRpcClient, threadId: string, turnIds: string[]) => {
  const itemsByTurn: Record<string, JsonRecord[]> = {};
  const errors: string[] = [];
  for (const turnId of turnIds) {
    const items: JsonRecord[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await client.request<JsonRecord>("thread/items/list", {
        threadId,
        turnId,
        cursor,
        limit: 100,
        sortDirection: "asc"
      }).catch((error: unknown) => {
        errors.push(error instanceof Error ? error.message : String(error));
        return null;
      });
      if (!result) break;
      items.push(...arrayRecords(result.data));
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
      if (!cursor) break;
    }
    itemsByTurn[turnId] = items;
  }
  return { itemsByTurn, errors };
};

const dynamicToolSpec = () => ({
  name: "codexhub_probe_tool",
  description: "Returns a fixed marker string for CodexHub app-server transcript probing.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string" }
    },
    additionalProperties: false
  },
  deferLoading: false
});

const buildSummary = (input: {
  appServerUrl: string;
  threadId: string;
  mode: ProbeMode;
  snapshot: JsonRecord;
  turnsList: JsonRecord[];
  turnItems: Record<string, JsonRecord[]>;
  turnItemsErrors: string[];
  frames: Frame[];
  serverRequests: JsonRecord[];
  notifications: JsonRecord[];
}) => {
  const turns = threadTurns(input.snapshot);
  const threadReadItems = turns.flatMap((turn) => {
    const turnId = typeof turn.id === "string" ? turn.id : undefined;
    return arrayRecords(turn.items).map((item) => summarizeItem(item, turnId));
  });
  const threadReadToolItems = threadReadItems.filter((item) => toolItemTypes.has(item.type));
  const threadTurnsListItems = input.turnsList.flatMap((turn) => {
    const turnId = typeof turn.id === "string" ? turn.id : undefined;
    return arrayRecords(turn.items).map((item) => summarizeItem(item, turnId));
  });
  const threadTurnsListToolItems = threadTurnsListItems.filter((item) => toolItemTypes.has(item.type));
  const threadItemsListItems = Object.entries(input.turnItems).flatMap(([turnId, items]) =>
    items.map((item) => summarizeItem(item, turnId))
  );
  const threadItemsListToolItems = threadItemsListItems.filter((item) => toolItemTypes.has(item.type));
  const liveItems = input.notifications
    .filter((message) => message.method === "item/started" || message.method === "item/completed")
    .map((message) => {
      const params = asRecord(message.params);
      const item = asRecord(params?.item);
      return item ? summarizeItem(item, typeof params?.turnId === "string" ? params.turnId : undefined) : null;
    })
    .filter((item): item is ToolItemSummary => Boolean(item));

  const appServerSnapshotHasToolItems = threadReadToolItems.length > 0
    || threadTurnsListToolItems.length > 0
    || threadItemsListToolItems.length > 0;
  return {
    appServerUrl: input.appServerUrl,
    threadId: input.threadId,
    mode: input.mode,
    frameCount: input.frames.length,
    appServerSnapshotHasToolItems,
    incomingMethodCounts: countMethods(input.notifications),
    serverRequestMethods: countMethods(input.serverRequests),
    liveItemEvents: {
      count: liveItems.length,
      itemTypes: countValues(liveItems.map((item) => item.type)),
      toolItems: liveItems.filter((item) => toolItemTypes.has(item.type))
    },
    threadRead: {
      turnCount: turns.length,
      itemCount: threadReadItems.length,
      itemTypes: countValues(threadReadItems.map((item) => item.type)),
      hasToolItems: threadReadToolItems.length > 0,
      toolItems: threadReadToolItems
    },
    threadTurnsList: {
      turnCount: input.turnsList.length,
      itemCount: threadTurnsListItems.length,
      itemTypes: countValues(threadTurnsListItems.map((item) => item.type)),
      hasToolItems: threadTurnsListToolItems.length > 0,
      toolItems: threadTurnsListToolItems
    },
    threadItemsList: {
      turnCount: Object.keys(input.turnItems).length,
      itemCount: threadItemsListItems.length,
      itemTypes: countValues(threadItemsListItems.map((item) => item.type)),
      hasToolItems: threadItemsListToolItems.length > 0,
      toolItems: threadItemsListToolItems,
      errors: input.turnItemsErrors
    },
    turnCompletedItems: turnCompletedItems(input.notifications)
  };
};

const turnCompletedItems = (notifications: JsonRecord[]) => {
  const items = notifications.flatMap((message) => {
    if (message.method !== "turn/completed") return [];
    const params = asRecord(message.params);
    const turn = asRecord(params?.turn);
    const turnId = typeof turn?.id === "string" ? turn.id : undefined;
    return arrayRecords(turn?.items).map((item) => summarizeItem(item, turnId));
  });
  return {
    count: items.length,
    itemTypes: countValues(items.map((item) => item.type)),
    toolItems: items.filter((item) => toolItemTypes.has(item.type))
  };
};

const summarizeItem = (item: JsonRecord, turnId?: string): ToolItemSummary => ({
  turnId,
  id: typeof item.id === "string" ? item.id : undefined,
  type: typeof item.type === "string" ? item.type : "unknown",
  status: typeof item.status === "string" ? item.status : undefined,
  command: typeof item.command === "string" ? item.command : undefined,
  tool: typeof item.tool === "string" ? item.tool : undefined,
  server: typeof item.server === "string" ? item.server : undefined,
  name: typeof item.name === "string" ? item.name : undefined
});

const threadTurns = (snapshot: JsonRecord) => {
  const thread = asRecord(snapshot.thread) ?? snapshot;
  return arrayRecords(thread.turns);
};

const countMethods = (messages: JsonRecord[]) => countValues(messages.map((message) =>
  typeof message.method === "string" ? message.method : "unknown"
));

const countValues = (values: string[]) => {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
};

const uniqueStrings = (values: string[]) => [...new Set(values.filter(Boolean))];

const startCodexAppServer = async (cwd: string, requestedPort?: number) => {
  const port = requestedPort ?? await findFreePort();
  const url = `ws://127.0.0.1:${port}`;
  const launch = await codexAppServerLaunch(url);
  const child = spawn(launch.command, launch.args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32"
  });
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  await waitForReady(port, child);
  return { child, url };
};

const codexAppServerLaunch = async (appServerUrl: string) => {
  if (process.platform === "linux" && await fileExists("/usr/bin/setpriv")) {
    return {
      command: "/usr/bin/setpriv",
      args: ["--pdeathsig", "TERM", "codex", "app-server", "--listen", appServerUrl]
    };
  }
  return {
    command: "codex",
    args: ["app-server", "--listen", appServerUrl]
  };
};

const waitForReady = async (port: number, child: ChildProcess) => {
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const url = `http://127.0.0.1:${port}/readyz`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    if (exited) throw new Error("codex app-server exited before becoming ready");
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await delay(150);
  }
  throw new Error(`codex app-server did not become ready: ${url}`);
};

const stopChild = async (child: ChildProcess | undefined) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(3_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    })
  ]);
};

const findFreePort = async () => await new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      reject(new Error("Could not allocate a TCP port"));
      return;
    }
    const port = address.port;
    server.close(() => resolve(port));
  });
});

const fileExists = async (filePath: string) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const parseArgs = (args: string[]): ProbeOptions => {
  const options: ProbeOptions = {
    cwd: process.cwd(),
    mode: "shell-command",
    prompt: defaultPrompt,
    command: defaultCommand,
    timeoutMs: 120_000,
    autoApprove: false,
    allowNoTool: false,
    verbose: false,
    withDynamicTool: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--cwd") {
      options.cwd = path.resolve(requireValue(args, ++index, arg));
      continue;
    }
    if (arg === "--mode") {
      options.mode = parseMode(requireValue(args, ++index, arg));
      continue;
    }
    if (arg === "--app-server-url") {
      options.appServerUrl = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--port") {
      options.port = parsePositiveInt(requireValue(args, ++index, arg), arg);
      continue;
    }
    if (arg === "--thread-id") {
      options.threadId = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--model") {
      options.model = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--prompt") {
      options.prompt = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--command") {
      options.command = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInt(requireValue(args, ++index, arg), arg);
      continue;
    }
    if (arg === "--out") {
      options.out = path.resolve(requireValue(args, ++index, arg));
      continue;
    }
    if (arg === "--auto-approve") {
      options.autoApprove = true;
      continue;
    }
    if (arg === "--allow-no-tool") {
      options.allowNoTool = true;
      continue;
    }
    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }
    if (arg === "--with-dynamic-tool") {
      options.withDynamicTool = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.mode === "read" && !options.threadId) {
    throw new Error("--mode read requires --thread-id");
  }
  return options;
};

const parseMode = (value: string): ProbeMode => {
  if (value === "read" || value === "shell-command" || value === "turn") return value;
  throw new Error(`Unsupported --mode: ${value}`);
};

const parsePositiveInt = (value: string, label: string) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
};

const requireValue = (args: string[], index: number, flag: string) => {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
};

const printHelp = () => {
  console.log(`Usage: pnpm run probe:app-server-transcript -- [options]

Starts or connects to codex app-server, then compares app-server transcript
sources: live item events, thread/read includeTurns:true, thread/turns/list
itemsView:"full", and thread/items/list.

Options:
  --mode <read|shell-command|turn>   Probe mode. Default: shell-command
  --cwd <path>                       Thread cwd. Default: current directory
  --thread-id <id>                   Resume/read an existing thread
  --app-server-url <ws://...>        Reuse an existing app-server websocket
  --port <port>                      Port when starting app-server
  --command <command>                shell-command mode command
  --prompt <text>                    turn mode prompt
  --model <model>                    Optional model override
  --with-dynamic-tool                Register a probe dynamic tool on new thread
  --auto-approve                    Accept command/file approval requests
  --allow-no-tool                    Exit 0 even if read/list APIs have no tool item
  --timeout-ms <ms>                  Request/turn timeout. Default: 120000
  --out <path>                       Write summary, raw frames, and snapshot JSON
  --verbose                          Log raw JSON-RPC frames to stderr
`);
};

const parseJsonRecord = (value: unknown): JsonRecord | null => {
  try {
    return asRecord(JSON.parse(String(value)));
  } catch {
    return null;
  }
};

const permissionsApprovalResponse = (approved: boolean, params: JsonRecord | null) => {
  if (!approved) return { permissions: {}, scope: "turn" };
  const permissions = asRecord(params?.permissions);
  const granted: JsonRecord = {};
  if (permissions?.network !== null && permissions?.network !== undefined) granted.network = permissions.network;
  if (permissions?.fileSystem !== null && permissions?.fileSystem !== undefined) granted.fileSystem = permissions.fileSystem;
  return { permissions: granted, scope: "turn" };
};

const mcpElicitationDefaultContent = (params: JsonRecord | null) => {
  const requestedSchema = asRecord(params?.requestedSchema);
  const properties = asRecord(requestedSchema?.properties);
  if (!properties) return {};
  const content: JsonRecord = {};
  for (const [key, rawSchema] of Object.entries(properties)) {
    const fieldSchema = asRecord(rawSchema);
    if (!fieldSchema || !Object.prototype.hasOwnProperty.call(fieldSchema, "default")) continue;
    content[key] = fieldSchema.default;
  }
  return content;
};

const asRecord = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;

const arrayRecords = (value: unknown) =>
  Array.isArray(value) ? value.map(asRecord).filter((item): item is JsonRecord => Boolean(item)) : [];

const isRequestId = (value: unknown): value is RequestId =>
  typeof value === "string" || typeof value === "number";

void main().catch(async (error) => {
  const fallbackPath = path.join(await mkdtemp(path.join(os.tmpdir(), "codexhub-app-server-probe.")), "error.txt");
  await writeFile(fallbackPath, `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`).catch(() => undefined);
  console.error(error instanceof Error ? error.message : error);
  console.error(`probe error details: ${fallbackPath}`);
  process.exit(1);
});
