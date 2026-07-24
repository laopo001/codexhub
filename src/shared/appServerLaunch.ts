import type { ThreadApprovalsReviewer } from "./usageTypes.js";

export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexApprovalsReviewer = ThreadApprovalsReviewer;
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type CodexAppServerLaunchOptions = {
  approvalPolicy?: CodexApprovalPolicy;
  approvalsReviewer?: CodexApprovalsReviewer;
  sandbox?: CodexSandboxMode;
  modelCatalogJson?: string;
};
