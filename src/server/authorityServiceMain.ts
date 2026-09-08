import path from "node:path";
import { runAuthorityService } from "./authorityService.js";

const servicePath = path.resolve(process.argv[1]);
// tsx needs its loader flags on both initial startup and authority-owned restart.
void runAuthorityService(process.argv.slice(2), servicePath, [...process.execArgv, servicePath])
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
