import React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { CodexRecordView } from "../../shared/recordTypes.js";

export type StatusRegistryScope = "turn" | "thread";

export type StatusRegistration = {
  id: string;
  scope: StatusRegistryScope;
  status?: CodexRecordView["status"];
  preview: React.ReactNode;
  actions?: React.ReactNode;
  detail?: React.ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  ariaLabel?: string;
};

export type StatusRegistry = {
  register: (entry: StatusRegistration) => void;
  entries: (scope?: StatusRegistryScope) => StatusRegistration[];
};

export const StatusRegistryToggleIcon = ({
  expanded,
  size = 13,
  strokeWidth = 2.2
}: {
  expanded: boolean;
  size?: number;
  strokeWidth?: number;
}) => {
  const ToggleIcon = expanded ? ChevronUp : ChevronDown;
  return <ToggleIcon size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
};

export const createStatusRegistry = (): StatusRegistry => {
  const entriesById = new Map<string, StatusRegistration>();
  return {
    register: (entry) => {
      if (!entry.id.trim()) return;
      entriesById.set(entry.id, entry);
    },
    entries: (scope) => [...entriesById.values()]
      .filter((entry) => !scope || entry.scope === scope)
  };
};

export const StatusRegistryRows = ({ entries }: { entries: StatusRegistration[] }) => {
  if (!entries.length) return null;
  return (
    <div className="statusRegistryRows">
      {entries.map((entry) => {
        const expandable = Boolean(entry.detail);
        const hasActions = Boolean(entry.actions);
        const expanded = Boolean(expandable && entry.expanded);
        return (
          <React.Fragment key={entry.id}>
            <div
              className={[
                "statusRegistryItem",
                entry.status ?? "",
                hasActions ? "hasActions" : "",
                expandable ? "hasDetails" : "",
                expanded ? "expanded" : ""
              ].filter(Boolean).join(" ")}
              aria-label={entry.ariaLabel}
            >
              <span className="statusRegistryIndicator" aria-hidden="true" />
              <span className="statusRegistryPreview">{entry.preview}</span>
              {hasActions ? <span className="statusRegistryActions">{entry.actions}</span> : null}
              {expandable ? (
                <button
                  type="button"
                  className="statusRegistryToggle"
                  onClick={entry.onToggle}
                  aria-expanded={expanded}
                  aria-label={expanded ? "Collapse status details" : "Expand status details"}
                  title={expanded ? "Collapse status details" : "Expand status details"}
                >
                  <StatusRegistryToggleIcon expanded={expanded} />
                </button>
              ) : null}
            </div>
            {expanded ? <div className="statusRegistryDetail">{entry.detail}</div> : null}
          </React.Fragment>
        );
      })}
    </div>
  );
};
