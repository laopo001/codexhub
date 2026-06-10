# codexhub 架构约定

## 总体方向

codexhub 是本机 Node.js server + Web 控制面。server 负责 machines、projects、threads、session 状态、tasks、plugins 和 SSH connections 的控制面与事件镜像；真正的 Codex app-server/headless 进程由 machine 侧启动并上报。

当前公开模型以 `machineId`、`projectId`、`threadId` 为主，`sessionId` 只表示 project 当前在线能力。默认一个 project 对应一个 session；不要为了少见的多 session per project 场景把公共模型复杂化。公开/Web 投影必须是 project-first：`/api/projects` 里的 project 带 `machineOnline` 和 `session`，其中 `session` 是当前在线 session 或 `null`；`/api/sessions` 只作为 session/debug 镜像。旧 `workerId` 只允许作为 legacy 输入拒绝和回归断言出现，不能重新暴露成产品概念、内部主模型或公共 API。

## Machine / Session / Thread 模型

1. `MachineType = "local" | "ssh" | "registered"`。
2. `local` 表示本机 server 内嵌的 project launcher；普通本机启动默认启用，Docker 默认关闭。
3. `ssh` 表示本机 server 通过系统 `ssh -R` reverse tunnel 拉起远端 remote client。默认 remote client 由本机 server 下发，远端不要求预装 CodexHub。SSH 断开后，该 machine 和其下 session 应进入 offline；先不做自动恢复或后台保活。
4. `registered` 表示外部机器主动运行 `codexhub machine --server ... --type registered` 连接进来。它注册的是 machine，不是 session。
5. machine 是 project launcher 和命令执行入口。server 不扫描远端文件系统；目录解析、权限检查和启动 session 都在 machine 所在机器执行。
6. session 是一次官方 Codex app-server/headless 进程。公开 ID 是 `sessionId`；它是 project 的在线运行能力，不是用户心智里的主对象。
7. `threadId` 来自官方 Codex session。server/Web/TG/task 读取和展示 thread transcript，但 transcript 的权威来源是 session 从官方 app-server 同步的 thread/read、item、rawResponseItem 和 tokenUsage 事件镜像。
8. server/session 不维护 `currentThreadId` 或 `currentThread`。Web 当前 tab、Telegram chat 绑定、task `threadId` 都是客户端/任务自己的选择状态；所有发送入口最终必须显式知道目标 `threadId`。
9. slash command 不按普通 Codex turn 透传。server 本地只处理明确支持的 `/status`、`/help`、`/model` 语义；其他 slash command 返回不支持说明。

## 公共 API 约定

1. 公开 API 以这些入口为准：`/api/machines`、`/api/machines/connect`、`/api/events/ws`、`/api/projects`、`/api/projects/open`、`/api/sessions`、`/api/sessions/:sessionId/turn`、`/api/sessions/:sessionId/threads`、`/api/threads/*`、`/api/tasks`、`/api/plugins`、`/api/ssh/*`。
2. 不再恢复 `/api/workers` 作为公共入口，也不要添加 `/api/instances`、`.codexp/instances.yaml` 或 instance 兼容层。
3. machine websocket 先发送 `register` 注册机器，再用 `session_register` 注册该机器下的 session。`session_register.registration` 必须是 strict schema，不能接受旧 `workerId`。
4. 公共 JSON 返回不应包含 `workerId`。内部 session registry、server state、Web 和 CLI bridge 都应使用 `sessionId`。
5. Web/TG/task 发送对话时优先使用 `/api/threads/:threadId/turn`。`/api/sessions/:sessionId/turn` 只作为兼容/调试入口，body 必须包含 `threadId`，不能表示“当前 thread”。
6. server 可以持久化轻量 machine/project/thread/task 摘要到 `CODEX_HUB_DATA_DIR` 下的 server state，但不能把这个状态当成 Codex app-server 进程或远端文件系统权限。

## SSH 模型

1. server 读取 SSH config 用 `src/core/sshConfig.ts`，支持 `Include` 和简单 `*`/`?` glob；可用 `CODEX_HUB_SSH_CONFIG` 指向测试或自定义配置。
2. CodexHub state 只保存用户添加进 CodexHub 的 SSH config alias，不复制 `HostName`、`User`、`Port`、`ProxyJump` 等连接配置。`/api/ssh/config-hosts` 是本机 SSH config 候选来源，`/api/ssh/hosts` 是 CodexHub 收纳列表。
3. server 启动后默认读取 CodexHub SSH alias 列表并自动连接；可用 `CODEX_HUB_SSH_AUTOCONNECT=0` 关闭。添加 alias 后也应由 server 侧启动连接，不依赖 Web 切换到 SSH tab。
4. `/api/ssh/connect` 通过系统 `ssh` 建立 `-R 127.0.0.1:<remotePort>:<localHost>:<localPort>`。默认远端命令是 bootstrap：用远端 `node` 经 reverse tunnel 下载本机 server 下发的 `dist-node/ssh/remote-client.cjs`，按 sha256 缓存到 `~/.cache/codexhub/remote-client/<hash>/client.cjs` 后运行，不要求远端预装 CodexHub。
5. `CODEX_HUB_SSH_REMOTE_MODE=installed` 可临时退回旧模式，让远端执行全局 `codexhub machine --server http://127.0.0.1:<remotePort> --type ssh`。
6. 如果 server 监听 `0.0.0.0` 或 `::`，reverse tunnel 的本机目标应映射到 `127.0.0.1`。
7. SSH 是 connection/transport 方式，不需要把所有 transport 都抽象成插件系统。先保持直接、可验证、断开即结束。

## Project / Task 模型

1. project 是 `machineId + path` 推导出的 server UI/路由元数据。project 不持久拥有 Codex 进程，但在公开投影里拥有 `session` 状态；session 只能作为 project 的当前运行实例出现，不能反向创建 Web project。
2. `POST /api/projects/open` 必须发给在线 machine，由 machine 在本机确认 path 是可进入目录，再启动或复用 session。
3. task 记录在本机 server state，选择 machine、project path、可选 thread 和 cron schedule，然后按计划投递一轮对话。
4. 不再让 server 扫描 `.codexp/tasks`。旧本地 YAML task scheduler 不应恢复；如需离线 workspace task，以新的 CLI 设计另行加入。
5. task 并发边界是 task 记录本身；同一 task running/queued 时不要叠加执行。

## 插件模型

1. 插件系统先保持轻量 contribution hub：读取本地 plugin dir，汇总 Web styles 和 integration metadata。
2. Telegram 是内建 integration plugin；没有 token 时插件可列出但 integration 状态为未配置/未启动。
3. 主题/CSS 是 Web contribution plugin。外部插件 CSS 通过 `/api/plugins/:pluginId/assets/*` 服务。
4. 不执行外部 JS，不把 SSH 强行改造成插件运行器。需要新增 channel/input/output 时，先用 integration metadata + 明确 server 适配层。

## Web / Electron / Docker

1. Web 继续复用现有对话展示：右侧以 thread records 为准，左侧以 machines/projects/threads 为主，session 只通过 `project.session` 作为 project 在线状态展示，不能作为和 project 平行的 Web 主对象。
2. Web 本地选择状态只使用 `activeSessionId`。
3. Web 页面实时更新使用单条 `/api/events/ws` WebSocket：`hello` 订阅 machines/projects/sessions/tasks/connections 控制面事件，页面内 thread tabs 通过 `subscribe_thread` / `unsubscribe_thread` 在同一条连接里多路复用；不要为每个 thread tab 新增独立 SSE/WS。Thread `record/done` 只更新 thread 增量，不应连带推送整份 projects/sessions snapshot。
4. Docker 镜像运行 server/Web/API，默认 `CODEX_HUB_LOCAL_MACHINE=0`，由宿主机或远端通过 registered/ssh machine 接入 session。
5. Electron 只包装同一个本机 server 和 Web UI。默认尝试 `127.0.0.1:18788`，未显式指定端口且被占用时可 fallback 到空闲端口。

## 发布和验证

1. 本地默认端口是 `8788`；生产由 `codexhub server` 启动，PM2 进程名为 `codexhub-prod`。
2. 发布脚本必须先 `pnpm check`、`pnpm build`，再重启 PM2 并验证 `/api/health` 和 `/`。
3. 关键验证命令：

```bash
pnpm check
pnpm run smoke:machine-session
pnpm run smoke:registered-machine
pnpm run smoke:ssh-loopback
pnpm run smoke:task-lock
pnpm run smoke:electron
pnpm build
```

4. `smoke:machine-session` 覆盖 local machine、project open、session/thread `/status`、server-local task、plugin CSS、SSH 参数构造和旧 `workerId` registration 拒绝。
5. `smoke:registered-machine` 覆盖真实 `codexhub machine --type registered` CLI、项目打开、session/thread 对话流和正常 unregister lifecycle。
6. `smoke:ssh-loopback` 覆盖真实本机 sshd、`ssh -R` reverse tunnel、SSH remote client、项目打开、session/thread 对话流和断开 lifecycle。
7. `smoke:task-lock` 覆盖同一 task queued/running 时的并发跳过，以及 turn 完成后的重新运行。
8. `smoke:electron` 覆盖 Electron main process 启动内嵌 server、默认端口占用 fallback 和 `/api/health`。
