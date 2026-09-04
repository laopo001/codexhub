import React from "react";
import { RefreshCw } from "lucide-react";
import type { MachineAppsPayload, MachinePluginReconcilePayload } from "../shared/apiContract.js";
import { apiRoutes } from "../shared/apiRoutes.js";
import { apiRouteJson } from "./appHelpers.js";
import { apiErrorDetails } from "./helpers/apiErrors.js";
import type { MachineSummary, OpenThreadState } from "./types.js";

type AppsPayload = MachineAppsPayload;

export const machineAppsThreadBelongsToMachine = (
  targetMachineId: string,
  targetThreadId: string,
  threads: Pick<OpenThreadState, "threadId" | "runtime">[]
) => !targetThreadId || threads.some((thread) => thread.threadId === targetThreadId && thread.runtime.machineId === targetMachineId);

export const machineAppsCommandPaletteCwds = (
  defaultCwd: string | undefined,
  threads: Pick<OpenThreadState, "workingDirectory">[]
) => [...new Set([
  defaultCwd,
  ...threads.map((thread) => thread.workingDirectory)
].filter((cwd): cwd is string => Boolean(cwd)))];

export const MachineAppsPanel = ({
  machines,
  openThreads,
  loadCommandPalette
}: {
  machines: MachineSummary[];
  openThreads: OpenThreadState[];
  loadCommandPalette: (machineId: string, cwd: string, force?: boolean) => void | Promise<void>;
}) => {
  const onlineMachines = React.useMemo(() => machines.filter((machine) => machine.online), [machines]);
  const [machineId, setMachineId] = React.useState("");
  const [threadId, setThreadId] = React.useState("");
  const [appsStatus, setAppsStatus] = React.useState<"idle" | "loading" | "ready" | "error">("idle");
  const [apps, setApps] = React.useState<AppsPayload | null>(null);
  const [appsError, setAppsError] = React.useState("");
  const [reconciling, setReconciling] = React.useState(false);
  const [reconcileResult, setReconcileResult] = React.useState<MachinePluginReconcilePayload | null>(null);
  const [reconcileError, setReconcileError] = React.useState("");
  const appsRequestRef = React.useRef(0);
  const reconcileRequestRef = React.useRef(0);
  const selectionKeyRef = React.useRef("");
  const commandPaletteCwdsRef = React.useRef<string[]>([]);

  React.useEffect(() => {
    if (!onlineMachines.some((machine) => machine.machineId === machineId)) {
      setMachineId(onlineMachines[0]?.machineId ?? "");
      setThreadId("");
    }
  }, [machineId, onlineMachines]);

  const machineThreads = React.useMemo(
    () => openThreads.filter((thread) => thread.runtime.machineId === machineId),
    [machineId, openThreads]
  );
  const selectedThread = machineThreads.find((thread) => thread.threadId === threadId);
  const selectedMachine = onlineMachines.find((machine) => machine.machineId === machineId);
  const selectedThreadId = selectedThread?.threadId ?? "";
  const selectedMachineOnline = Boolean(selectedMachine);
  const selectedThreadValid = !threadId || Boolean(selectedThread);
  selectionKeyRef.current = `${machineId}\u0000${selectedThreadId}`;
  commandPaletteCwdsRef.current = machineAppsCommandPaletteCwds(selectedMachine?.cwd, machineThreads);

  React.useEffect(() => {
    if (threadId && !selectedThreadId) setThreadId("");
  }, [selectedThreadId, threadId]);

  const loadApps = React.useCallback(async (targetMachineId: string, targetThreadId: string) => {
    const requestId = ++appsRequestRef.current;
    setAppsStatus("loading");
    setAppsError("");
    try {
      const payload = await apiRouteJson(apiRoutes.machineApps, targetMachineId, targetThreadId || undefined) as AppsPayload;
      if (requestId !== appsRequestRef.current) return;
      setApps(payload);
      setAppsStatus("ready");
    } catch (error) {
      if (requestId !== appsRequestRef.current) return;
      setApps(null);
      setAppsStatus("error");
      setAppsError(apiErrorDetails(error, { plainHttpMessage: true }).message || "Apps API unavailable.");
    }
  }, []);

  React.useEffect(() => {
    setReconcileResult(null);
    setReconcileError("");
    if (!machineId) {
      appsRequestRef.current += 1;
      setApps(null);
      setAppsStatus("idle");
      setAppsError("");
      return;
    }
    if (!selectedMachineOnline || !selectedThreadValid) {
      appsRequestRef.current += 1;
      setApps(null);
      setAppsStatus("idle");
      setAppsError("");
      return;
    }
    void loadApps(machineId, threadId);
  }, [loadApps, machineId, selectedMachineOnline, selectedThreadValid, threadId]);

  const reconcilePlugins = async () => {
    if (!machineId || reconciling) return;
    const targetMachineId = machineId;
    const targetThreadId = threadId;
    const targetSelectionKey = `${targetMachineId}\u0000${targetThreadId}`;
    const requestId = ++reconcileRequestRef.current;
    setReconciling(true);
    setReconcileError("");
    try {
      const result = await apiRouteJson(apiRoutes.reconcileMachinePlugins, targetMachineId, {
        reason: "web-settings"
      });
      if (requestId !== reconcileRequestRef.current || selectionKeyRef.current !== targetSelectionKey) return;
      setReconcileResult(result);
      await loadApps(targetMachineId, targetThreadId);
      if (selectionKeyRef.current === targetSelectionKey) {
        await Promise.all(commandPaletteCwdsRef.current.map(async (cwd) => {
          if (selectionKeyRef.current !== targetSelectionKey) return;
          try {
            await loadCommandPalette(targetMachineId, cwd, true);
          } catch {
            // command palette 刷新是尽力而为，不能把同步误报为失败。
          }
        }));
      }
    } catch (error) {
      if (requestId !== reconcileRequestRef.current || selectionKeyRef.current !== targetSelectionKey) return;
      setReconcileError(apiErrorDetails(error, { plainHttpMessage: true }).message || "Plugin sync unavailable.");
    } finally {
      if (requestId === reconcileRequestRef.current) setReconciling(false);
    }
  };

  if (!onlineMachines.length) {
    return <div className="machineAppsPanel"><p className="machineAppsNotice">No online Codex runtime is available.</p></div>;
  }

  const metadataById = new Map((apps?.metadata ?? []).map((metadata) => [metadata.id, metadata]));
  const failedPluginIds = [
    ...(reconcileResult?.failedRemotePluginIds ?? []),
    ...(reconcileResult?.failedMaterializationRemotePluginIds ?? [])
  ];

  return (
    <div className="machineAppsPanel">
      <div className="machineAppsControls">
        <label>
          <span>Machine</span>
          <select value={machineId} onChange={(event) => {
            setThreadId("");
            setMachineId(event.target.value);
          }} disabled={reconciling}>
            {onlineMachines.map((machine) => (
              <option value={machine.machineId} key={machine.machineId}>
                {machine.name ?? machine.hostname}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Thread context (optional)</span>
          <select value={threadId} onChange={(event) => setThreadId(event.target.value)} disabled={reconciling}>
            <option value="">Machine runtime default</option>
            {machineThreads.map((thread) => (
              <option value={thread.threadId} key={thread.threadId}>
                {thread.title || thread.threadId}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="machineAppsHeader">
        <div>
          <h3>Codex Apps</h3>
          <p>Installed apps and account-provided tool metadata from the selected runtime.</p>
        </div>
        <button type="button" className="petSettingsButton" onClick={() => void loadApps(machineId, threadId)} disabled={appsStatus === "loading" || reconciling}>
          <RefreshCw size={13} aria-hidden="true" />
          {appsStatus === "loading" ? "Loading…" : "Refresh"}
        </button>
      </div>

      {appsError ? (
        <div className="machineAppsError" role="alert">
          <span>{appsError}</span>
          <button type="button" className="textButton" onClick={() => void loadApps(machineId, threadId)}>Retry</button>
        </div>
      ) : appsStatus === "loading" ? (
        <p className="machineAppsNotice" role="status">Loading Apps…</p>
      ) : apps ? (
        <>
          {apps.installed.length ? (
            <div className="machineAppsList">
              {apps.installed.map((installed) => {
                const metadata = metadataById.get(installed.id);
                return <MachineAppCard key={installed.id} installed={installed} metadata={metadata} />;
              })}
            </div>
          ) : <p className="machineAppsNotice">No installed Apps were reported by Codex.</p>}
          {apps.missingAppIds.length ? (
            <p className="machineAppsNotice">Missing metadata: {apps.missingAppIds.join(", ")}</p>
          ) : null}
          {apps.warnings?.length ? (
            <div className="machineAppsError" role="status">
              {apps.warnings.map((warning) => <span key={warning}>{warning}</span>)}
            </div>
          ) : null}
        </>
      ) : <p className="machineAppsNotice">Apps data is unavailable.</p>}

      <section className="machinePluginReconcile">
        <div className="machineAppsHeader">
          <div>
            <h3>Codex plugin sync</h3>
          <p>Synchronize Codex plugin packages and install/enabled state for this machine.</p>
          </div>
          <button type="button" className="petSettingsButton" onClick={() => void reconcilePlugins()} disabled={reconciling}>
            {reconciling ? "Syncing…" : "Sync Codex plugins"}
          </button>
        </div>
        {reconcileError ? <div className="machineAppsError" role="alert"><span>{reconcileError}</span><button type="button" className="textButton" onClick={() => void reconcilePlugins()}>Retry</button></div> : null}
        {reconcileResult ? (
          <div className="machineReconcileResult" role="status">
            <strong>Sync response received; runtime readiness is reported separately.</strong>
            <span>Changed: {reconcileResult.changedPlugins.length || "none"}</span>
            {reconcileResult.changedPlugins.length ? <code>{reconcileResult.changedPlugins.map((plugin) => plugin.id).join(", ")}</code> : null}
            {failedPluginIds.length ? <span className="machineAppsFailure">Failed: {failedPluginIds.join(", ")}</span> : <span>No plugin failures reported.</span>}
          </div>
        ) : null}
      </section>
    </div>
  );
};

export const MachineAppCard = ({
  installed,
  metadata
}: {
  installed: MachineAppsPayload["installed"][number];
  metadata?: MachineAppsPayload["metadata"][number];
}) => {
  const accessible = installed.accessible === true ? "Yes" : installed.accessible === false ? "No" : "Unknown";
  return (
    <article className="machineAppCard">
      <header>
        <div>
          <strong>{metadata?.name ?? installed.id}</strong>
          {metadata?.description ? <p>{metadata.description}</p> : null}
        </div>
        <code>{installed.runtimeName ?? "runtime unknown"}</code>
      </header>
      <div className="machineAppBadges">
        <span>Installed: Yes</span>
        <span>Account access: {accessible}</span>
        <span>Enabled: {installed.enabled ? "Yes" : "No"}</span>
        <span>Callable: {installed.callable ? "Yes" : "No"}</span>
      </div>
      <div className="machineAppTools">
        <strong>Tools</strong>
        {metadata?.tools?.length ? (
          <ul>
            {metadata.tools.map((tool) => (
              <li key={tool.name}>
                <span>{tool.title ?? tool.name}</span>
                <small>{tool.description || "No description"}{tool.enabled ? "" : ` · ${tool.disabledReason ?? "disabled"}`}</small>
              </li>
            ))}
          </ul>
        ) : <span className="machineAppsNotice">No tool metadata reported.</span>}
      </div>
    </article>
  );
};
