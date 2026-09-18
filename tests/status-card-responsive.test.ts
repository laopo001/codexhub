import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ActivityStatusBar,
  StatusCardOverview,
  ThreadStatusCard
} from "../src/web/helpers/components.js";
import type {
  ActivityStatusView,
  BackgroundTerminalView,
  ThreadExecutionMeta
} from "../src/web/types.js";

const sampleExecutionMeta: ThreadExecutionMeta = {
  status: "running",
  label: "Running",
  duration: "12s",
  text: "1. 确认当前窄屏重叠根因并制定修复方案以覆盖外层总览与内层状态行"
};

const sampleStatuses: ActivityStatusView[] = [
  {
    key: "plan",
    label: "PLAN",
    status: "in_progress",
    text: "1. 确认当前窄屏重叠根因并制定修复方案以覆盖外层总览与内层状态行 · 1/3",
    summaryText: "1. 确认当前窄屏重叠根因并制定修复方案以覆盖外层总览与内层状态行 · 1/3",
    fixedSuffix: "1/3",
    steps: [
      { step: "排查 CSS 与 statusRegistry DOM 链路", status: "completed" },
      { step: "修复 statusRegistryPreview 和 headerMetric 的 flex shrink 与截断", status: "in_progress" },
      { step: "验证 390px 视口下外层总览与展开内层各行不重叠", status: "pending" }
    ]
  },
  {
    key: "files",
    label: "FILES",
    status: "completed",
    text: "+35 -12 in 2 files",
    summaryText: "+35 -12",
    files: [
      { path: "src/web/styles/messages.css", added: 25, removed: 10 },
      { path: "src/web/styles/responsive.css", added: 10, removed: 2 }
    ]
  },
  {
    key: "usage",
    label: "USAGE",
    status: "completed",
    text: "12.5k / 200k tokens (6%)",
    summaryText: "12.5k / 200k"
  }
];

const sampleBackgroundTerminals: BackgroundTerminalView[] = [
  {
    itemId: "item-1",
    processId: "proc-12345",
    osPid: 12345,
    command: "pnpm run dev:web --host 127.0.0.1 --port 15173 --strictPort",
    cwd: "/home/laop/projects/codexhub/packages/web",
    cpuPercent: 3.2,
    rssKb: 145200,
    startedAt: "2026-08-30T00:00:00.000Z"
  }
];

test("StatusCardOverview renders overview with running summary, plan metric, usage metric, and toggle button", () => {
  const html = renderToStaticMarkup(
    React.createElement(StatusCardOverview, {
      executionMeta: sampleExecutionMeta,
      turnActive: true,
      statuses: sampleStatuses,
      backgroundTerminals: sampleBackgroundTerminals,
      expanded: true,
      onToggleExpanded: () => {}
    })
  );

  assert.ok(html.includes("activityStatusCardOverview"), "renders activityStatusCardOverview container");
  assert.ok(html.includes("activityStatusSummary running"), "renders running summary badge");
  assert.ok(html.includes("Running"), "contains Running label text");
  assert.ok(html.includes("activityStatusHeaderMetrics"), "renders metrics list container");
  assert.ok(html.includes("activityStatusHeaderMetric plan"), "renders plan metric");
  assert.ok(html.includes("activityStatusTextMain"), "renders shrinkable plan text");
  assert.ok(html.includes("activityStatusTextFixed"), "renders fixed plan progress");
  assert.ok(html.includes("1/3"), "keeps plan progress visible as a separate suffix");
  assert.ok(html.includes("activityStatusHeaderMetric usage"), "renders usage metric");
  assert.ok(html.includes("activityStatusHeaderMetric background"), "renders background process metric");
  assert.ok(html.includes("activityStatusToggle"), "renders collapsible toggle button");
  assert.ok(html.includes('aria-label="Collapse activity details"'), "includes accessible collapse aria-label");
});

test("ActivityStatusBar renders structured status rows for PLAN, FILES, USAGE with details and steps", () => {
  const html = renderToStaticMarkup(
    React.createElement(ActivityStatusBar, {
      statuses: sampleStatuses,
      expanded: true,
      expandedKeys: new Set(["plan", "files"]),
      expandedKeysInitialized: true,
      onToggle: () => {}
    })
  );

  assert.ok(html.includes("activityStatusSection turnStatusCard expanded"), "renders turn status card");
  assert.ok(html.includes("statusRegistryRows"), "renders shared status registry rows");
  assert.ok(html.includes("statusRegistryItem"), "renders status registry items");
  assert.ok(html.includes("statusRegistryLabel"), "renders status label element");
  assert.ok(html.includes("statusRegistryText"), "renders status text element");
  assert.ok(html.includes("activityStatusTextFixed"), "renders fixed plan progress in the shared row");
  assert.ok(html.includes("statusRegistryToggle"), "renders row toggle button");
  assert.ok(html.includes("activityStatusPlanSteps"), "renders plan steps list");
  assert.ok(html.includes("activityStatusFiles"), "renders changed files list");
  assert.ok(html.includes("fileChangeRow"), "renders file change rows");
});

test("ThreadStatusCard renders background processes row with terminate actions and metrics", () => {
  const html = renderToStaticMarkup(
    React.createElement(ThreadStatusCard, {
      backgroundTerminals: sampleBackgroundTerminals,
      visible: true,
      onTerminate: () => {}
    })
  );

  assert.ok(html.includes("threadStatusCard"), "renders thread status card");
  assert.ok(html.includes("BACKGROUNDS"), "renders BACKGROUNDS label");
  assert.ok(html.includes("backgroundTerminalCommand"), "renders background command element");
  assert.ok(html.includes("backgroundTerminalMeta"), "renders background cwd and resource metadata");
  assert.ok(html.includes("backgroundTerminalStatus"), "renders background running status");
  assert.ok(html.includes("statusRegistryAction"), "renders terminate action button");
  assert.ok(html.includes('aria-label="Terminate background process'), "includes terminate aria-label");
});

test("CSS contracts ensure narrow-screen flex shrink, text truncation, and layout resilience", async () => {
  const messagesCss = await readFile(new URL("../src/web/styles/messages.css", import.meta.url), "utf-8");
  const responsiveCss = await readFile(new URL("../src/web/styles/responsive.css", import.meta.url), "utf-8");

  // 1. Overview header metrics contract
  assert.ok(
    messagesCss.includes(".activityStatusHeaderMetric {") &&
    messagesCss.includes("flex: 0 1 auto;") &&
    messagesCss.includes("overflow: hidden;"),
    "activityStatusHeaderMetric allows flexible shrinking and overflow clipping"
  );
  assert.ok(
    messagesCss.includes(".activityStatusHeaderMetric strong {") &&
    messagesCss.includes("flex: 0 0 auto;"),
    "activityStatusHeaderMetric strong label prevents shrinking"
  );
  assert.ok(
    messagesCss.includes(".activityStatusHeaderMetric > span {") &&
    messagesCss.includes("text-overflow: ellipsis;"),
    "activityStatusHeaderMetric text truncates with ellipsis"
  );

  // 2. StatusRegistryRows shared row contract
  assert.ok(
    messagesCss.includes(".statusRegistryItem {") &&
    messagesCss.includes("display: flex;"),
    "statusRegistryItem uses flex layout for robust column distribution"
  );
  assert.ok(
    messagesCss.includes(".statusRegistryPreview {") &&
    messagesCss.includes("display: flex;") &&
    messagesCss.includes("flex: 1 1 auto;"),
    "statusRegistryPreview expands and shrinks dynamically in remaining space"
  );
  assert.ok(
    messagesCss.includes(".statusRegistryLabel {") &&
    messagesCss.includes("flex: 0 0 auto;"),
    "statusRegistryLabel remains fixed and does not compress"
  );
  assert.ok(
    messagesCss.includes(".statusRegistryText {") &&
    messagesCss.includes("flex: 1 1 auto;") &&
    messagesCss.includes("overflow: hidden;"),
    "statusRegistryText flexes and clips its shrinkable content"
  );
  assert.ok(
    messagesCss.includes(".activityStatusTextMain {") &&
    messagesCss.includes("text-overflow: ellipsis;") &&
    messagesCss.includes(".activityStatusTextSeparator,") &&
    messagesCss.includes(".activityStatusTextFixed {") &&
    messagesCss.includes("flex: 0 0 auto;"),
    "status text truncates the main copy while preserving its fixed suffix"
  );
  assert.ok(
    messagesCss.includes(".statusRegistryToggle {") &&
    messagesCss.includes("flex: 0 0 auto;"),
    "statusRegistryToggle stays fixed on the right without overlapping"
  );

  // 3. Responsive 600px mobile rules contract
  assert.ok(
    responsiveCss.includes("@media (max-width: 600px) {") &&
    responsiveCss.includes(".activityStatusCardOverview {") &&
    responsiveCss.includes(".statusRegistryItem {"),
    "responsive.css contains mobile 600px refinements for status card elements"
  );
});
