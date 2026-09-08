import { runAuthorityService } from "../../../src/server/authorityService.js";

void runAuthorityService().catch((error: unknown) => {
  console.error(`codexhub embedded authority failed: ${errorText(error)}`);
  process.exitCode = 1;
});

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
