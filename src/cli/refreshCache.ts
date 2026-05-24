import { Command } from "commander";
import { listLoadableCodexThreads } from "../core/codexpLog.js";

const program = new Command()
  .option("--cwd <path>", "workspace whose Codex sessions should be indexed", process.cwd())
  .parse(process.argv);

const options = program.opts<{ cwd: string }>();
const threads = await listLoadableCodexThreads(options.cwd);

console.log(`Indexed ${threads.length} sessions for ${options.cwd}`);
