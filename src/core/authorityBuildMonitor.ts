import { stat } from "node:fs/promises";
import { authorityBuildId } from "./embeddedAuthority.js";

export type AuthorityBuildMonitorOptions = {
  currentBuildId: string;
  files: string[];
  pollMs?: number;
  onUpdateAvailable: (buildId: string) => void;
};

export class AuthorityBuildMonitor {
  private readonly timer: NodeJS.Timeout;
  private checking = false;
  private pendingBuildId = "";
  private reportedBuildId = "";

  constructor(private readonly options: AuthorityBuildMonitorOptions) {
    this.timer = setInterval(() => void this.check(), positivePollMs(options.pollMs));
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  async check() {
    if (this.checking) return;
    this.checking = true;
    try {
      const stats = await Promise.all(this.options.files.map((file) => stat(file)));
      if (stats.some((entry) => !entry.isFile())) {
        this.pendingBuildId = "";
        return;
      }
      const prefix = this.options.currentBuildId.split(":", 1)[0] || "authority";
      const buildId = await authorityBuildId(this.options.files, prefix);
      if (buildId === this.options.currentBuildId) {
        this.pendingBuildId = "";
        return;
      }
      if (buildId === this.reportedBuildId) return;
      if (buildId !== this.pendingBuildId) {
        this.pendingBuildId = buildId;
        return;
      }
      this.reportedBuildId = buildId;
      this.pendingBuildId = "";
      this.options.onUpdateAvailable(buildId);
    } catch {
      // A build can temporarily remove or replace its outputs. Wait for two stable reads.
      this.pendingBuildId = "";
    } finally {
      this.checking = false;
    }
  }
}

const positivePollMs = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 5_000;
