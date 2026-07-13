import type { Event } from "@theia/core/lib/common/event";

export type CodexHubTaskCompleteNotification = {
  title: string;
  body: string;
  threadId: string;
  duration?: string;
};

export const codexHubBackendServicePath = "/services/codexhub/embedded";
export const CodexHubBackendService = Symbol("CodexHubBackendService");

export type CodexHubBackendStartInput = {
  workspacePaths: string[];
  activeWorkspacePath?: string;
  workspaceLabel?: string;
};

export type CodexHubBackendStartResult = {
  url: string;
};

export interface CodexHubBackendService {
  start(input: CodexHubBackendStartInput): Promise<CodexHubBackendStartResult>;
  stop(): Promise<void>;
}

export const codexHubNativeNotificationServicePath = "/services/codexhub/native-notifications";
export const CodexHubNativeNotificationService = Symbol("CodexHubNativeNotificationService");

export type CodexHubNativeNotificationInput = {
  windowId: string;
  notification: CodexHubTaskCompleteNotification;
};

export interface CodexHubNativeNotificationClient {
  openThread(threadId: string): void;
}

export interface CodexHubNativeNotificationService {
  isSupported(): Promise<boolean>;
  show(input: CodexHubNativeNotificationInput): Promise<boolean>;
}

export const CodexHubHostNotificationService = Symbol("CodexHubHostNotificationService");

export interface CodexHubHostNotificationService {
  readonly onDidOpenThread: Event<string>;
  requestPermission(): Promise<boolean>;
  show(notification: CodexHubTaskCompleteNotification): Promise<boolean>;
}
