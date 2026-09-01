import React from "react";

type AppErrorBoundaryState = {
  error: Error | null;
};

export const AppFatalError = ({
  message,
  onReload
}: {
  message: string;
  onReload: () => void;
}) => (
  <main className="appFatalError" role="alert">
    <section className="appFatalErrorCard">
      <h1>Codex Hub could not render</h1>
      <p>The authority is still running. Reload this frontend to reconnect without restarting your Codex sessions.</p>
      <pre>{message}</pre>
      <button type="button" onClick={onReload}>Reload frontend</button>
    </section>
  </main>
);

export class AppErrorBoundary extends React.Component<React.PropsWithChildren, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Codex Hub renderer failed", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return <AppFatalError message={this.state.error.message || "Unknown renderer error"} onReload={() => window.location.reload()} />;
    }
    return this.props.children;
  }
}
