import { runCodexhubMachine } from "./codexhubMachine.js";

type RemoteClientOptions = {
  server?: string;
  machineId?: string;
  type?: "ssh" | "registered";
  name?: string;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (!options.server) throw new Error("Missing required --server <url>.");
  await runCodexhubMachine({
    apiBase: options.server,
    machineId: options.machineId,
    type: options.type ?? "ssh",
    name: options.name
  });
};

const parseArgs = (args: string[]): RemoteClientOptions => {
  const options: RemoteClientOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--server") {
      options.server = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--machine-id") {
      options.machineId = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--type") {
      const value = readValue(args, index, arg);
      if (value !== "ssh" && value !== "registered") throw new Error(`Unsupported remote client type: ${value}`);
      options.type = value;
      index += 1;
      continue;
    }
    if (arg === "--name") {
      options.name = readValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown remote client option: ${arg}`);
  }
  return options;
};

const readValue = (args: string[], index: number, option: string) => {
  const value = args[index + 1];
  if (!value) throw new Error(`Missing value for ${option}.`);
  return value;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
