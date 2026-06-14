# codexhub 架构约定

## 总体方向

codexhub 是 local-first 的 Codex 控制面：本机 Node.js server 提供 HTTP/WebSocket API 和 Web UI，machine 侧负责路径解析、官方 `codex app-server`/headless 进程启动、thread 操作和 app-server transcript 同步。server 可以镜像事件、维护控制面状态和调度任务，但不能变成 Codex app-server、远端文件系统或 thread transcript 的权威来源。

当前产品心智是 project-first。公开模型以 `machineId`、`projectId`、`threadId` 为主，`sessionId` 表示某台 machine 上的官方 Codex app-server/headless runtime，不是用户心智里的主对象；同一个 runtime session 可以承载多个不同 project cwd 的 threads。`/api/projects` 是 Web 主投影，project 带 `machineOnline` 和当前在线 `session | null`，这里的 `session` 是按 project path 过滤后的 runtime 投影；`/api/sessions` 只作为 session/debug 镜像。

不要恢复旧 `workerId` 模型。`workerId` 只允许出现在 legacy 输入拒绝、回归断言或迁移说明里；公共 JSON、Web 主模型、server state、CLI bridge 都应使用 `sessionId`。不要恢复 `/api/workers`、`/api/instances`、`.codexp/instances.yaml` 或旧 worker/instance 兼容层。

## 运行入口

1. 包名是 `@dadigua/codexhub`，公开 bin 是 `codexhub` 和 `cxh`，两者指向同一个 CLI 入口。
2. 生产/本地 server 入口是 `codexhub server`，默认监听 `0.0.0.0:8788`；本机访问 URL 仍显示为 `http://127.0.0.1:8788`，`CODEX_HUB_HOST`、`CODEX_HUB_PORT` 或 CLI 参数可以覆盖。
3. 开发时 API 用 `pnpm run dev:api`，Web 用 `pnpm run dev:web`，Vite 默认 `5173` 并代理 `/api` 到 `8788`。
4. `codexhub [prompt]` 是 legacy/transient headless 入口：它启动一条 transient Codex session 并通过 machine websocket 接入 server；它的 transient machine `projectLauncher: false`，不能用于项目浏览或远端目录选择。
5. `codexhub machine --type registered` 注册一台可启动 project runtime 的 machine；内嵌 local machine 也走同一套 machine command 协议。
6. `codexhub server --register-to <parent>` 会启动当前 server，并额外把它作为一台 `registered` machine 接入父 server；这不是 server-to-server state bridge。
7. `codexhub ssh ...` 是 server-side SSH 管理入口；SSH remote client 默认由本机 server bootstrap 下发，不要求远端预装 codexhub。
8. VSCode 和 Electron 都调用 `src/server/embedded.ts` 复用同一套 server/Web。VSCode 默认每个窗口启动自己的随机端口嵌入 server，窗口自动 workspace projects 只作为 transient project group 进入内存，不写入 server state；Electron 默认随机端口，只有显式 `CODEX_HUB_PORT` 时才固定端口。
9. machine/headless 启动官方 `codex app-server` 时必须走 `resolveCodexCommand()`：优先 `CODEX_HUB_CODEX_CLI`，兼容 `CODEX_CLI_PATH`，再查 `PATH` 和常见 npm/pnpm 全局 bin；Windows `.cmd` / `.bat` 需要经 `cmd.exe /d /s /c call` 启动。`CODEX_HUB_APP_SERVER_READY_TIMEOUT_MS` 控制 `/readyz` 等待时间，错误应带最近 app-server stderr tail。

## Machine / Session / Thread

1. `MachineType = "local" | "ssh" | "registered"`。
2. machine 是路径解析、目录 listing、project session 启停的执行者。server 不扫描远端文件系统；`/api/machines/:machineId/directories` 和 `/api/projects/open` 都必须发给在线 machine，由 machine 在自身环境确认 path 是可进入目录。
3. machine capability 里 `projectLauncher` 很重要。Web 只应把可启动 project 的 machine 用于 Add Project；transient session host 必须保持 `projectLauncher: false`。
4. `local` 表示 server 内嵌的 project launcher，普通 server 默认启用，Docker/测试/嵌入 surface 可用 `CODEX_HUB_LOCAL_MACHINE=0` 或 feature override 关闭。
5. `registered` 表示外部机器主动连接 `/api/machines/connect`。它注册的是 machine，不是 session；session 由 server 下发 `start_session` 后由 machine 启动并再注册。外部机器可以是 `codexhub machine --type registered`，也可以是 `codexhub server --register-to` 或 Web Registered 面板发起的父 server 注册；后两者仍只暴露 machine/app-server 能力，不同步子 server state。
6. `ssh` 表示 server 通过系统 `ssh -R` 建 reverse tunnel 后在远端启动 remote client。SSH 断开后该 connection 下的 machine/session 进入 offline；保存的 SSH host 可以按 autoconnect 策略重连，但不要把 SSH 抽象成插件运行器。
7. 不再支持 `type=server` machine、CodexHub server-to-server bridge、Connections / Servers tab、`/api/server-connections` 或 normalized thread mirror。
8. 父 server 注册必须防止自注册：同本机地址且同端口直接拒绝，目标 `/api/health` 返回的 `serverInstanceId` 与当前实例相同也拒绝；同一台电脑不同端口的多个 server 可以互相注册用于测试。
9. session 是一次官方 Codex app-server/headless 进程。公开 ID 是 `sessionId`；它是 machine 级 runtime，能通过 app-server 的 per-thread/per-turn `cwd` 支持多个 project。Web 中点击 project 就是打开或复用该 machine 的 runtime，并为 project path 创建/复用 thread；不提供手动 restart/stop 或独立 session 管理入口。
10. threadId 来自官方 Codex app-server。server/Web/TG/task 读取和展示 thread transcript，但 transcript 来源只能是 app-server turns snapshot、实时 item/rawResponseItem/tokenUsage 事件。
11. server/session 不维护 `currentThreadId` 或 `currentThread`。Web 当前 tab、Telegram chat 绑定、task `threadId` 都是各自的客户端/任务选择状态；发送入口最终必须显式知道目标 `threadId`。
12. `session_register.registration` 是 strict schema。旧 `workerId` 必须被拒绝；`currentThreadId` 只作为历史字段容忍并立即丢弃，不能重新进入公共模型。

## App-server Thread Sync 和实时流

1. Web 只维护一条 `/api/events/ws`。连接后发送 `hello` 订阅 control-plane snapshots，再用 `subscribe_thread` / `unsubscribe_thread` 多路复用页面 thread tabs。
2. Control-plane 事件包括 `sessions`、`projects`、`tasks`、`connections`；thread 事件只包括 `thread`、`record`、`done`。
3. 浏览器不直接连接官方 app-server。server 通过内部 session command 发送 `subscribe_thread_records` / `unsubscribe_thread_records`，由 machine bridge 负责 app-server turns snapshot 和 live events。
4. 每个被 Web 订阅的 thread 在一个 bridge 里只能有一份 thread records subscription。server 对 thread subscription 做 ref-count，并用 `CODEX_HUB_THREAD_RECORD_SUBSCRIPTION_IDLE_MS` 做 idle grace。
5. Thread records subscription 只由 Web thread tab 订阅驱动。解绑后要保留 still-subscribed race guard，避免刚 unsubscribe 又被旧 async sync 重新写入。
6. runtime session 不走 idle auto-stop。machine 只维护一个 app-server/headless runtime，生命周期跟 machine/server 主进程走；project delete、subscription idle-close 和普通空闲都不能触发 `stop_session`。
7. `CODEX_HUB_THREAD_RECORD_SUBSCRIPTION_IDLE_MS=0` 只表示禁用 subscription idle-close。session heartbeat 只表示进程存活，不能当成用户活跃信号。
8. 不再保留 SSE 事件入口；实时控制面和 thread 增量统一走 `/api/events/ws`。
9. session 级账号 rate limits 来自官方 app-server `account/rateLimits/read` 和 `account/rateLimits/updated`，进入 `SessionSummary.accountRateLimits`；Web 可以在 thread tokenUsage 暂无 rate limit 时把它作为展示兜底，但 transcript usage 仍以 thread records 为准。

## 公共 API 约定

1. 基础和认证：`GET /api/health`、`GET /api/auth/status`。设置 `CODEX_HUB_AUTH_TOKEN` 后，除 health/auth/status、registered/SSH remote-client bundle、plugin assets 和静态页面外，API 都需要 token。token 支持 `Authorization: Bearer`、`x-codexhub-token`、`?codexhub_token=` 和 `?token=`。
2. Machines：`GET /api/machines`、`GET /api/machines/:machineId/directories`、`GET /api/machines/connect` WebSocket。
3. Registered parent：`GET /api/registered/parent`、`POST /api/registered/parent`、`DELETE /api/registered/parent`、`GET /api/registered/bootstrap`、`GET /api/remote-client/:hash`。动态 parent 注册只保存在当前进程内，body `url` 可以携带 `?token=` / `?codexhub_token=`；bootstrap 脚本通过 `/api/remote-client/:hash` 拉当前 build 的 remote client。
4. Realtime：`GET /api/events/ws` WebSocket。
5. Projects：`GET /api/projects`、`POST /api/projects/open`、`PATCH /api/projects/:projectId`、`DELETE /api/projects/:projectId`。`PATCH` 目前只更新 `pinned`。
6. Sessions：`GET /api/sessions`、`GET /api/sessions/:sessionId/thread-candidates`、`POST /api/sessions/:sessionId/threads`、`POST /api/sessions/:sessionId/turn`。
7. Threads：`GET /api/threads`、`GET /api/threads/:threadId`、`POST /api/threads/:threadId/turn`、`POST /api/threads/:threadId/stop`、`POST /api/threads/:threadId/goal`、`DELETE /api/threads/:threadId/goal`、`POST /api/threads/:threadId/fork`、`POST /api/threads/:threadId/rollback`、`DELETE /api/threads/:threadId`。
8. Tasks：`GET /api/tasks`、`POST /api/tasks`、`PATCH /api/tasks/:taskId`、`DELETE /api/tasks/:taskId`、`POST /api/tasks/:taskId/run`。
9. SSH：`GET /api/ssh/config-hosts`、`GET /api/ssh/hosts`、`POST /api/ssh/hosts`、`DELETE /api/ssh/hosts/:alias`、`GET /api/ssh/connections`、`POST /api/ssh/connect`、`DELETE /api/ssh/connections/:connectionId`、`GET /api/ssh/remote-client/:hash`。
10. Plugins：`GET /api/plugins`、`GET /api/plugins/:pluginId/assets/*`。
11. Web/TG/task 发送对话时优先使用 `/api/threads/:threadId/turn`。`/api/sessions/:sessionId/turn` 只作为兼容/调试入口，body 必须包含 `threadId`，不能表示“当前 thread”。
12. 对 project runtime 的公开生命周期入口只保留 `POST /api/projects/open`。不要新增公开的 project session stop/restart API；runtime session 不由 project delete 或 idle watcher 结束，只随 machine/server 生命周期断开或由内部 shutdown 清理。

## Server State

1. server state 默认在 `CODEX_HUB_DATA_DIR` 下的 `server-state.yaml`，数据结构版本为 `version: 1`。
2. state 可以保存 machines、projects、deletedProjects、tasks、task 最近 run 摘要、SSH hosts。task run 摘要只保留最近 20 条，用于 UI 状态，不是 workspace 运行日志。
3. state 不保存 thread summary 数量、history 数量或完整 transcript 内容。project 的 `lastSessionId`、`lastThreadId` 只是最近打开元数据，不是 transcript 权威来源。
4. project ID 由 `machineId + path` 推导；project 名称来自 path basename，不持久化自定义 name，也不提供 rename UI/API。
5. 删除 project 会写入 deletedProjects tombstone，不能停止该 machine 的 runtime session。后续 session capture 不应自动复活已删除 project，除非用户重新 open。
6. state loader 会迁移旧 `threads` 和旧 project `name` 字段；不要重新引入这些旧字段。

## Project / Task 模型

1. project 是 `machineId + path` 推导出的 UI/路由元数据。project 不持久拥有 Codex 进程，但公开投影里拥有当前 `session` 状态。
2. `POST /api/projects/open` 由在线 machine 启动或复用 machine 级 runtime session，再按该目录 cwd 创建或复用 project thread，默认 `reuse: true`。成功后 state 更新 project 的 last opened/session/thread 元数据。
3. project 列表不展示 open 数、thread/history 数或任何 transcript 历史数量。在线 thread 列表属于 session/thread picker 和 workspace tabs，不属于 project 卡片持久属性。
4. project 级 UI 操作可以有 pin、delete、refresh/open；不要把 session restart/stop、rename、thread count 重新放回 project row。
5. task 是 server-local 调度记录，选择 machine、project path、可选 thread 和五字段 cron，然后按计划向该 thread 投递一轮对话。默认 cron timezone 是 `Asia/Shanghai`。
6. task 运行时复用 project 所属 machine 的 runtime session；若配置了 `threadId` 则按 task project path resume 该 thread，否则使用 project open 返回的新/复用 thread 并写回 task 状态。
7. task 并发边界是 task 记录本身。同一 task 已 running/queued 时，新触发应记录为 skipped，不要叠加执行。
8. 不再扫描 `.codexp/tasks`，也不写 `.codexp/task-runs`。任务状态和最近 run 摘要都在 server state。

## CLI 模型

1. 顶层 CLI 保留 `server`、`machine`、`ssh`、`task`；默认 headless session 入口是 legacy/transient 行为，不作为 project runtime 主路径。`list`、`threads`、`resume`、`delete` 作为隐藏 removed commands 只返回迁移错误，不做兼容实现。
2. thread history browsing、thread resume 和 new thread 选择放在 Web/API：`/api/sessions/:sessionId/thread-candidates` 和 `/api/sessions/:sessionId/threads`。
3. `codexhub [prompt]` 是废弃的 legacy/transient headless 入口；它不是项目浏览 launcher，也不是 project runtime 主路径。不要为了它扩展新的 project/session 语义。
4. `--sandbox`、`--approval-policy`、`--model` 只有用户显式传参时才作为 app-server override 转发；不要偷偷发明默认权限策略。
5. CLI 默认通过 `loadDotEnv()` 读取当前 cwd 的 `.env`，并且只填补未设置的环境变量。跨目录运行 `cxh` 时要先核对 cwd 和环境来源。
6. 发布后的 bin 必须是 `#!/usr/bin/env node` + `dist-node` 编译产物，不依赖全局 `tsx`。

## Thread 行为

1. Slash command 不按普通 Codex turn 透传。server 本地只处理 `/status`、`/help`、`/model`；其他 slash command 生成不支持说明。
2. Web composer 有 Chat / Plan / Goal 三种模式。Plan/Goal 通过本轮 turn 的 `options` 传给 server，是一次性输入状态，不应泄漏到后续默认 turn。
3. Web 在 thread running 时继续发送普通输入，应走 app-server `turn/steer`，并带当前 active `turnId`。没有 active turnId 或非 Web source 时才进入 queue fallback。
4. Web 在 running thread 上用 Goal mode 发送，应更新 active goal，而不是启动新 turn 或追加 queue。
5. Goal 状态来自 thread record 流里的 `thread_goal_updated` / `thread_goal_cleared`，需要合并 app-server snapshot 和 live records 提取；不要只看 composer 当前选中模式。
6. `POST /api/threads/:threadId/stop` 只停止当前 running turn，不是关闭 project session。UI running 状态下主操作可以收敛成 stop turn。
7. fork/rollback 依赖 app-server turn id 和 record 映射；改动 record id 或 compact/detailed view 时要验证 fork/rollback。

## Web 前端结构

1. `src/web/App.tsx` 负责全局状态、derived state 和 action factory 组装；不要继续把大段业务逻辑塞回渲染 JSX。
2. 操作逻辑按领域放在 `src/web/appActions/*`：`realtimeActions`、`projectActions`、`threadActions`、`composerActions`、`sshActions`、`taskActions`。
3. 渲染入口是 `AppView.tsx`、`AppSidebar.tsx`、`AppDialogs.tsx`，共享格式化和 view helpers 在 `appHelpers.tsx` 及 `helpers/*`。
4. record 渲染链路分三层：core `recordsToViews`、Web `detailedRecordViews`、shared `compactRecordViews`。Simple/compact/detailed 模式调整要先核对实际 record source。
5. Web 优先显示 app-server snapshot/live events 归一化后的 records；goal/status/notification 这类提取逻辑可以合并 snapshot 和 live records，但不要把主消息渲染链随意改成双源重复。
6. Workspace thread tabs 使用 Ant Design Tabs 的官方 editable-card 行为和 pane 高度契约；不要为 add/remove 重新写一套自定义 tabs 外观。
7. VSCode surface 使用同一套 Web UI 和完整左侧控制面。`surface=vscode` 只用于 VSCode 通知桥、daemon 兼容判断、workspace project group 等嵌入环境差异，不应隐藏 sidebar 或关闭 SSH/tasks/plugins/Registered 能力。
8. 任务完成通知：完成音效总是由 Web 播放；Settings 里的 `taskCompleteSystemNotifications` 只控制系统弹窗，普通 Web 走 browser Notification，VSCode 走 iframe `postMessage` 到 extension，再由 VSCode notification 展示。
9. UI 文案和交互不要重新暴露已删除概念：worker、instance、project rename、project thread/history count、project session restart/stop。

## 插件和集成

1. 插件系统是轻量 contribution hub。`PluginHub` 扫描本地 plugin root，读取 `plugin.yaml/yml/json` 或 `codexhub.plugin.yaml/yml`。
2. 默认插件目录是 `~/.local/share/codexhub/plugins` 和当前 cwd 的 `plugins`；可用 `CODEX_HUB_PLUGIN_DIR` 或 `CODEX_HUB_PLUGIN_DIRS` 覆盖。
3. 外部插件只贡献 Web styles 和 integration metadata。外部插件 CSS 通过 `/api/plugins/:pluginId/assets/*` 服务，路径必须限制在 plugin root 内。
4. 不执行外部 JS。需要新增 channel/input/output 时，先用 integration metadata + 明确 server 适配层，不要把任意插件变成运行时执行器。
5. Telegram 是内建 integration plugin；没有 token 时可以列出但状态为未配置/未启动。`CODEX_HUB_PLUGIN_TELEGRAM=0` 可关闭内建 Telegram plugin。

## SSH 模型

1. SSH config 读取在 `src/core/sshConfig.ts`，支持 `Include` 和简单 `*`/`?` glob；可用 `CODEX_HUB_SSH_CONFIG` 指向测试或自定义配置。
2. CodexHub state 只保存用户添加的 SSH config alias，不复制 `HostName`、`User`、`Port`、`ProxyJump`、identityFiles 等连接配置。
3. `/api/ssh/config-hosts` 是本机 SSH config 候选来源，`/api/ssh/hosts` 是 CodexHub 收纳列表；添加 alias 后由 server 侧启动连接，不依赖 Web 切换 tab。
4. `/api/ssh/connect` 通过系统 `ssh` 建立 `-R 127.0.0.1:<remotePort>:<localHost>:<localPort>`。如果 server 监听 `0.0.0.0` 或 `::`，reverse tunnel 本机目标必须映射到 `127.0.0.1`。
5. 默认 remote mode 是 bootstrap：远端 `node` 经 reverse tunnel 下载本机 server 暴露的 `dist-node/ssh/remote-client.cjs`，按 sha256 缓存到 `~/.cache/codexhub/remote-client/<hash>/client.cjs` 后执行。
6. `CODEX_HUB_SSH_REMOTE_MODE=installed` 只作为临时退回旧模式，让远端执行全局 `codexhub machine --server ... --type ssh`。
7. `CODEX_HUB_SSH_REMOTE_CLIENT_PATH` 可覆盖 remote-client bundle 路径；缺 bundle 时 bootstrap 模式应明确失败并提示 build 或 installed mode。

## Electron / VSCode / Docker

1. Electron main process 只包装同一个 server 和 Web UI。窗口使用隔离/sandbox WebPreferences，外链用系统浏览器打开。
2. Electron 默认随机端口；显式设置 `CODEX_HUB_PORT` 后端口被占用应直接失败，不再 fallback。
3. VSCode extension 注册 sidebar webview，每个 VSCode 窗口默认启动自己的随机端口嵌入 server；只有显式 `CODEX_HUB_PORT` 时才固定端口，端口占用应直接失败。Webview iframe 和 Open in Browser 必须通过 `vscode.env.asExternalUri` 暴露 server URL，不能直接写 raw loopback URL。
4. VSCode extension 自动 `POST /api/projects/open` 当前窗口的 file workspace folders，body 使用 `persist:false` 和 `source.kind="vscode"`；打开前先从 `/api/machines` 选在线 `local` + `projectLauncher !== false` 的 machineId，避免依赖默认 machine 推断。这些项目以 VSCode workspace group 显示在内存中，不写入 `server-state.yaml`，用户显式保存后才变成普通 project。
5. VSCode workspace project 打开要容忍 embedded server listen 后 local launcher 尚未完成注册的 race：对 `HTTP 409` + launcher offline 类错误按 `500ms * 30` 重试；没有 file workspace folder 时只显示状态页。
6. VSCode extension 启用和普通 Web 相同的 SSH/tasks/integrations/Registered 能力；这些配置仍属于对应窗口 server/state，窗口自动 workspace project 不应污染全局持久 project list。
7. VSCode 打包由 `scripts/build-vscode.ts` 负责：先完整 build，再将 extension 打成 Node CJS bundle、把 `navigator` 定义为 `undefined` 并断言 bundle 不引用浏览器全局；staging 必须包含 `dist`、`dist-node/ssh`、media、README、LICENSE。
8. Docker 镜像运行 server/Web/API，默认应关闭内嵌 local machine，由宿主机、registered machine 或 SSH 接入真实 project session。

## 发布和验证

1. 本地默认端口是 `8788`；生产由 `codexhub server` 启动，PM2 进程名为 `codexhub-prod`。
2. 发布脚本必须先 `pnpm check`、`pnpm build`，再重启 PM2 并验证 `/api/health` 和 `/`。
3. 关键验证命令：

```bash
pnpm check
pnpm run smoke:auth
pnpm run smoke:machine-session
pnpm run smoke:registered-machine
pnpm run smoke:ssh-loopback
pnpm run smoke:task-lock
pnpm run smoke:electron
pnpm build
```

4. `smoke:machine-session` 覆盖 local machine、project open、跨 project 共享 runtime session、session account rate limits、session/thread `/status`、pending shell command 展示、server-local task、plugin CSS、SSH 参数构造、project delete 和 watcher idle 不误停 runtime、旧 `workerId` registration 拒绝，以及不持久化 thread history/name。
5. `smoke:auth` 覆盖 token 保护、Bearer token、WebSocket token query、machine websocket 授权。
6. `smoke:registered-machine` 覆盖真实 `codexhub machine --type registered` CLI、`codexhub server --register-to`、动态 parent 注册、Register URL token 提取、自注册拒绝、同机不同端口注册、项目打开、session/thread 对话流，以及 SIGTERM 后 machine/session unregister lifecycle 和 app-server 进程清理。
7. `smoke:ssh-loopback` 覆盖真实本机 sshd、`ssh -R` reverse tunnel、SSH remote client、项目打开、session/thread 对话流和断开 lifecycle。
8. `smoke:task-lock` 覆盖 task 并发跳过、thread records subscription、Plan/Goal options、running turn steer、goal set/clear、stop turn、idle-close 和 token usage rate limits。
9. `smoke:electron` 覆盖 Electron main process、嵌入 server 随机端口和 `/api/health`。
10. VSCode 改动低成本验证链路是 `pnpm check`、`pnpm package:vscode`、`code --install-extension dist-vscode/codexhub.vsix --force`。
11. VSCode Marketplace 发布 workflow 在 `.github/workflows/publish-vscode.yml`，只允许 `workflow_dispatch`，要求仓库 secret `VSCE_PAT`，先 `pnpm run package:vscode`，再用 `vsce publish --packagePath dist-vscode/codexhub.vsix --skip-duplicate`。
