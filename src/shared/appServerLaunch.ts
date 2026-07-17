export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type CodexAppServerLaunchOptions = {
  approvalPolicy?: CodexApprovalPolicy;
  sandbox?: CodexSandboxMode;
};
