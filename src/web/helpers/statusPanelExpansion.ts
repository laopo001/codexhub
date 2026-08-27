import type { ActivityStatusView } from "../types.js";

export type StatusPanelExpansionDecision = {
  scopeKey: string;
  expanded: boolean;
};

export const statusPanelShouldAutoExpand = (
  statuses: readonly ActivityStatusView[],
  backgroundTerminalCount: number
) => backgroundTerminalCount > 0 || statuses.some((status) => status.key === "plan");

export const resolveStatusPanelExpanded = ({
  scopeKey,
  decision,
  statuses,
  backgroundTerminalCount
}: {
  scopeKey: string;
  decision?: StatusPanelExpansionDecision;
  statuses: readonly ActivityStatusView[];
  backgroundTerminalCount: number;
}) => Boolean(
  scopeKey
  && (decision?.scopeKey === scopeKey
    ? decision.expanded
    : statusPanelShouldAutoExpand(statuses, backgroundTerminalCount))
);
