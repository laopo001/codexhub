import React from "react";
import { writeTextToClipboard } from "./helpers/composer.js";
import {
  captureRendererDiagnosticReport,
  type RendererDiagnosticReport
} from "./helpers/rendererDiagnostics.js";

type AppErrorBoundaryState = {
  error: Error | null;
  report: RendererDiagnosticReport | null;
};

export const AppFatalError = ({
  message,
  diagnostics,
  onReload
}: {
  message: string;
  diagnostics?: string;
  onReload: () => void;
}) => {
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "failed">("idle");
  const copyDiagnostics = async () => {
    if (!diagnostics) return;
    try {
      await writeTextToClipboard(diagnostics);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  return (
    <main className="appFatalError" role="alert">
      <section className="appFatalErrorCard">
        <h1>Codex Hub could not render</h1>
        <p>The authority is still running. Reload this frontend to reconnect without restarting your Codex sessions.</p>
        <pre>{message}</pre>
        <div className="appFatalErrorActions">
          <button type="button" onClick={onReload}>Reload frontend</button>
          {diagnostics ? (
            <button type="button" className="secondary" onClick={() => void copyDiagnostics()}>
              {copyState === "copied" ? "Diagnostics copied" : copyState === "failed" ? "Copy failed" : "Copy diagnostics"}
            </button>
          ) : null}
        </div>
      </section>
    </main>
  );
};

export class AppErrorBoundary extends React.Component<React.PropsWithChildren, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null, report: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    const normalized = error instanceof Error ? error : new Error(String(error));
    return { error: normalized, report: captureRendererDiagnosticReport(normalized) };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ report: captureRendererDiagnosticReport(error, info.componentStack ?? undefined) });
    console.error("Codex Hub renderer failed", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <AppFatalError
          message={this.state.error.message || "Unknown renderer error"}
          diagnostics={this.state.report ? JSON.stringify(this.state.report, null, 2) : undefined}
          onReload={() => window.location.reload()}
        />
      );
    }
    return this.props.children;
  }
}
