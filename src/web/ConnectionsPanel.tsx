import React from "react";
import { Unplug } from "lucide-react";
import type { ParentRegistrationDraft } from "./types.js";
import type { AppConnectionsViewModel } from "./viewModel.js";
import { formatVscodeChannelBadge } from "../shared/surfaceTypes.js";
import {
  connectionCodexRuntimeLine,
  connectionCodexRuntimeState
} from "./helpers/connectionRuntime.js";
import { machineVsCodeChannels } from "./helpers/registeredMachines.js";
import {
  activeSshConnectionForHost,
  latestSshConnectionForHost,
  sshConnectionDoctorLines,
  sshConnectionDetail,
  sshConnectionStatusClass,
  sshConnectionStatusLabel,
  sshConnectionTitle,
  sshHostMeta,
  sshHostSearchMatches
} from "./appHelpers.js";

type ConnectionsPanelProps = {
  viewModel: AppConnectionsViewModel;
};

const parentRegistrationStatusLabel = (status: AppConnectionsViewModel["parentRegistration"]["status"]) => {
  if (status === "online") return "connected";
  if (status === "connecting" || status === "starting") return "connecting";
  if (status === "offline") return "offline";
  if (status === "stopped") return "stopped";
  return "idle";
};

export const ConnectionsPanel = ({ viewModel }: ConnectionsPanelProps) => {
  const {
    addSshHost,
    connectionMode,
    connectParentRegistration,
    connectSshHost,
    copyCurrentServerShareUrl,
    copyRegisteredCommand,
    currentServerShareUrl,
    disconnectParentRegistration,
    localMachines,
    machines,
    parentRegistration,
    parentRegistrationBusy,
    parentRegistrationError,
    projectList = [],
    registeredCommand,
    registeredCommandIncludesToken,
    registeredCommandCopied,
    registeredMachines,
    removeSshHost,
    runtimeList,
    serverShareCopied,
    setConnectionMode,
    sidebarDraftStore,
    stopSshConnection,
    sshConfigHostOptions,
    sshConfigHosts,
    sshConnectingHost,
    sshConnections,
    sshError,
    sshHostBusy,
    sshHosts
  } = viewModel;
  const {
    parentRegistrationDraft,
    sshHostDraft,
    sshSearch
  } = React.useSyncExternalStore(
    sidebarDraftStore.subscribe,
    sidebarDraftStore.getSnapshot,
    sidebarDraftStore.getSnapshot
  );
  const setParentRegistrationDraft = React.useCallback(
    (update: React.SetStateAction<ParentRegistrationDraft>) => sidebarDraftStore.set("parentRegistrationDraft", update),
    [sidebarDraftStore]
  );
  const setSshHostDraft = React.useCallback(
    (value: string) => sidebarDraftStore.set("sshHostDraft", value),
    [sidebarDraftStore]
  );
  const setSshSearch = React.useCallback(
    (value: string) => sidebarDraftStore.set("sshSearch", value),
    [sidebarDraftStore]
  );
  const parentRegistrationStatus = parentRegistrationStatusLabel(parentRegistration.status);
  const parentRegistrationActive = parentRegistration.status !== "idle" && parentRegistration.status !== "stopped";

  React.useEffect(() => {
    if (!parentRegistration.url) return;
    setParentRegistrationDraft((current) => ({
      url: current.url || parentRegistration.url || "",
      machineId: current.machineId || parentRegistration.machineId || "",
      name: current.name || parentRegistration.name || ""
    }));
  }, [parentRegistration.machineId, parentRegistration.name, parentRegistration.url, setParentRegistrationDraft]);

  const sshQuery = sshSearch.trim();
  const visibleSshConfigHostOptions = sshConfigHostOptions.filter((host) => sshHostSearchMatches(host, sshQuery));
  const visibleSshHosts = sshHosts.filter((host) => sshHostSearchMatches(host, sshQuery));
  const onlineMachineIds = new Set(machines.filter((machine) => machine.online).map((machine) => machine.machineId));
  const connectedCodexCount = runtimeList.filter((runtime) => runtime.online && onlineMachineIds.has(runtime.machineId)).length;

  return (
    <section className="connectionPanel" aria-labelledby="settingsConnectionsTitle">
      <div className="connectionPanelHeader">
        <div>
          <h2 id="settingsConnectionsTitle">Connections</h2>
          <p>Manage local, SSH, and registered Codex machines.</p>
        </div>
        <span>{connectedCodexCount} Codex connected</span>
      </div>
      <div className="connectionTabs" aria-label="Connection type">
        <button
          type="button"
          className={connectionMode === "local" ? "active" : ""}
          onClick={() => setConnectionMode("local")}
          aria-pressed={connectionMode === "local"}
        >
          Local
        </button>
        <button
          type="button"
          className={connectionMode === "ssh" ? "active" : ""}
          onClick={() => setConnectionMode("ssh")}
          aria-pressed={connectionMode === "ssh"}
        >
          SSH
        </button>
        <button
          type="button"
          className={connectionMode === "registered" ? "active" : ""}
          onClick={() => setConnectionMode("registered")}
          aria-pressed={connectionMode === "registered"}
        >
          Registered
        </button>
      </div>
      {connectionMode === "local" ? (
        <div className="connectionList">
          {localMachines.length === 0 ? (
            <div className="connectionEmpty">No machines</div>
          ) : localMachines.map((machine) => {
            const codex = connectionCodexRuntimeState(machine, runtimeList);
            return (
              <div className={`connectionRow codex-${codex.kind}`} key={machine.machineId}>
                <span title={machine.name ?? machine.hostname}>{machine.name ?? machine.hostname}</span>
                <strong className={`codexRuntimeStatus ${codex.kind}`}>{codex.label}</strong>
                <code className="connectionCodexDetail">{codex.detail}</code>
              </div>
            );
          })}
        </div>
      ) : connectionMode === "ssh" ? (
        <div className="connectionList">
          <form className="sshManualForm" onSubmit={(event) => void addSshHost(event)}>
            <input
              value={sshHostDraft}
              onChange={(event) => setSshHostDraft(event.target.value)}
              list="sshConfigHostOptions"
              placeholder="SSH config alias"
              spellCheck={false}
            />
            <datalist id="sshConfigHostOptions">
              {visibleSshConfigHostOptions.map((host) => (
                <option key={host.alias} value={host.alias}>
                  {sshHostMeta(host)}
                </option>
              ))}
            </datalist>
            <button
              type="submit"
              disabled={
                !sshHostDraft.trim()
                || sshHostBusy === sshHostDraft.trim()
                || sshHosts.some((host) => host.alias === sshHostDraft.trim())
                || !sshConfigHosts.some((host) => host.alias === sshHostDraft.trim())
              }
            >
              {sshHostBusy === sshHostDraft.trim() ? "..." : "Add"}
            </button>
          </form>
          <input
            className="connectionSearchInput"
            value={sshSearch}
            onChange={(event) => setSshSearch(event.target.value)}
            placeholder="Search SSH hosts"
            spellCheck={false}
          />
          {visibleSshHosts.length === 0 ? (
            <div className="connectionEmpty">{sshQuery ? "No matching SSH hosts" : "No SSH hosts"}</div>
          ) : visibleSshHosts.map((host) => {
            const activeConnection = activeSshConnectionForHost(sshConnections, host.alias);
            const latestConnection = latestSshConnectionForHost(sshConnections, host.alias);
            const connecting = sshConnectingHost === host.alias;
            const statusLabel = sshConnectionStatusLabel(latestConnection, connecting, host.configured !== false);
            const statusClass = sshConnectionStatusClass(statusLabel);
            const connectionDetail = sshConnectionDetail(host, latestConnection);
            const machine = latestConnection?.machineId
              ? machines.find((item) => item.machineId === latestConnection.machineId)
              : undefined;
            const codex = connectionCodexRuntimeState(machine, runtimeList);
            return (
              <div className={`connectionRow ssh ${statusClass}`} key={host.alias} title={sshConnectionTitle(host, latestConnection)}>
                <button
                  type="button"
                  className="connectionHostButton"
                  title={host.configured === false ? "SSH config entry missing" : host.hostName ?? host.alias}
                  onClick={() => void connectSshHost(host.alias, host.alias)}
                  disabled={host.configured === false || Boolean(activeConnection) || connecting || sshHostBusy === host.alias}
                >
                  <span>{host.alias}</span>
                  <code title={connectionDetail}>{connectionDetail}</code>
                  <small className={`connectionCodexDetail ${codex.kind}`}>{connectionCodexRuntimeLine(codex)}</small>
                </button>
                <strong>{statusLabel}</strong>
                <button
                  type="button"
                  className={`connectionStopButton ${activeConnection ? "" : "hidden"}`}
                  onClick={() => activeConnection ? void stopSshConnection(activeConnection.connectionId) : undefined}
                  disabled={!activeConnection || sshHostBusy === host.alias}
                  aria-label={`Disconnect ${host.alias}`}
                  aria-hidden={!activeConnection}
                  title={activeConnection ? `Disconnect ${host.alias}` : "No active SSH connection"}
                >
                  <Unplug size={13} strokeWidth={2.1} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="connectionDeleteButton"
                  onClick={() => void removeSshHost(host, activeConnection)}
                  disabled={sshHostBusy === host.alias}
                  aria-label={`Remove ${host.alias}`}
                  title={`Remove ${host.alias} from CodexHub`}
                >
                  x
                </button>
                <details className="connectionDoctor">
                  <summary>Doctor</summary>
                  <pre>{sshConnectionDoctorLines(host, latestConnection)}</pre>
                </details>
              </div>
            );
          })}
          {sshError ? <div className="projectActionError">{sshError}</div> : null}
        </div>
      ) : (
        <div className="connectionList">
          <div className="registeredCommand">
            <div className="registeredCommandLine">
              <div className="registeredCommandText">
                <span className="registeredCommandLabel">Command</span>
                <code title={registeredCommand}>{registeredCommand}</code>
                {registeredCommandIncludesToken ? <span>auth token included</span> : null}
              </div>
              <button type="button" onClick={() => void copyRegisteredCommand()}>
                {registeredCommandCopied ? "Copied" : "Copy"}
              </button>
            </div>
            {currentServerShareUrl ? (
              <div className="registeredCommandLine">
                <div className="registeredCommandText">
                  <span className="registeredCommandLabel">Register URL</span>
                  <code title={currentServerShareUrl}>{currentServerShareUrl}</code>
                </div>
                <button type="button" onClick={() => void copyCurrentServerShareUrl()}>
                  {serverShareCopied ? "Copied" : "Copy"}
                </button>
              </div>
            ) : null}
          </div>
          <form className="registeredParentForm" onSubmit={(event) => void connectParentRegistration(event)}>
            <div className="registeredParentHeader">
              <span>Register to parent</span>
              <strong className={`registeredParentStatus ${parentRegistrationStatus}`}>{parentRegistrationStatus}</strong>
            </div>
            <input
              value={parentRegistrationDraft.url}
              onChange={(event) => setParentRegistrationDraft((current) => ({ ...current, url: event.target.value }))}
              placeholder="Parent register URL, with token if needed"
              spellCheck={false}
              disabled={parentRegistrationBusy}
            />
            <details className="registeredParentOptions">
              <summary>Options</summary>
              <input
                value={parentRegistrationDraft.name}
                onChange={(event) => setParentRegistrationDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="Machine name"
                spellCheck={false}
                disabled={parentRegistrationBusy}
              />
              <input
                value={parentRegistrationDraft.machineId}
                onChange={(event) => setParentRegistrationDraft((current) => ({ ...current, machineId: event.target.value }))}
                placeholder="Machine ID"
                spellCheck={false}
                disabled={parentRegistrationBusy}
              />
            </details>
            {parentRegistration.url || parentRegistration.machineId || parentRegistration.message ? (
              <div className="registeredParentMeta">
                {parentRegistration.url ? <code title={parentRegistration.url}>{parentRegistration.url}</code> : null}
                {parentRegistration.machineId ? <code title={parentRegistration.machineId}>{parentRegistration.machineId}</code> : null}
                {parentRegistration.message ? <span title={parentRegistration.message}>{parentRegistration.message}</span> : null}
              </div>
            ) : null}
            <div className="registeredParentActions">
              <button type="submit" disabled={!parentRegistrationDraft.url.trim() || parentRegistrationBusy}>
                {parentRegistrationBusy ? "..." : parentRegistrationActive ? "Reconnect" : "Connect"}
              </button>
              <button type="button" onClick={() => void disconnectParentRegistration()} disabled={!parentRegistrationActive || parentRegistrationBusy}>
                Disconnect
              </button>
            </div>
            {parentRegistrationError ? <div className="projectActionError">{parentRegistrationError}</div> : null}
          </form>
          {registeredMachines.length === 0 ? (
            <div className="connectionEmpty">No registered machines</div>
          ) : registeredMachines.map((machine) => {
            const codex = connectionCodexRuntimeState(machine, runtimeList);
            const channels = machineVsCodeChannels(machine.machineId, projectList);
            return (
              <div className={`connectionRow codex-${codex.kind}`} key={machine.machineId}>
                <div className="connectionMachineNameWrap">
                  <span title={machine.name ?? machine.hostname}>{machine.name ?? machine.hostname}</span>
                  {channels.length ? (
                    <span className="connectionChannels">
                      {channels.map((channel) => (
                        <strong key={channel} className={`projectMachineBadge vscode-${channel}`}>
                          {formatVscodeChannelBadge(channel)}
                        </strong>
                      ))}
                    </span>
                  ) : null}
                </div>
                <strong className={`codexRuntimeStatus ${codex.kind}`}>{codex.label}</strong>
                <code className="connectionCodexDetail" title={machine.machineId}>{codex.detail}</code>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
