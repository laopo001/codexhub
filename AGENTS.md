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
5. `codexhub machine --type registered` 注册一台可为 project path 启动 thread 的 machine；内嵌 local machine 也走同一套 machine command 协议。
6. `codexhub server --register-to <parent>` 会启动当前 server，并额外把它作为一台 `registered` machine 接入父 server；这不是 server-to-server state bridge。
7. `codexhub ssh ...` 是 server-side SSH 管理入口；SSH remote client 默认由本机 server bootstrap 下发，不要求远端预装 codexhub。
8. VSCode 和 Electron 都调用 `src/server/embedded.ts` 复用同一套 server/Web。VSCode 默认每个窗口启动自己的随机端口嵌入 server，并使用 VSCode extension `globalStorageUri` 下独立的 `config.yaml`；窗口内嵌 local machine 和自动 workspace projects 只作为 transient 内存投影，不写入持久配置。Electron 默认随机端口，只有显式 `CODEX_HUB_PORT` 时才固定端口。
9. machine/headless 启动官方 `codex app-server` 时必须走 `resolveCodexCommand()`：优先 `CODEX_HUB_CODEX_CLI`，兼容 `CODEX_CLI_PATH`，再查 `PATH` 和常见 npm/pnpm 全局 bin；Windows `.cmd` / `.bat` 需要经 `cmd.exe /d /s /c call` 启动。`CODEX_HUB_APP_SERVER_READY_TIMEOUT_MS` 控制 `/readyz` 等待时间，错误应带最近 app-server stderr tail。

## Machine / Session / Thread

1. `MachineType = "local" | "ssh" | "registered"`。
2. machine 是路径解析、目录 listing、machine runtime 和 project path thread 启动的执行者。server 不扫描远端文件系统；`/api/machines/:machineId/directories` 和 project path thread bootstrap 都必须发给在线 machine，由 machine 在自身环境确认 path 是可进入目录。
3. machine capability 里 `projectLauncher` 很重要。Web 只应把可启动 project 的 machine 用于 Add Project；transient session host 必须保持 `projectLauncher: false`。
4. `local` 表示 server 内嵌的 project launcher，普通 server 默认启用，Docker/测试/嵌入 surface 可用 `CODEX_HUB_LOCAL_MACHINE=0` 或 feature override 关闭。
5. `registered` 表示外部机器主动连接 `/api/machines/connect`。它注册的是 machine，不是 session；session 由 server 下发 `start_session` 后由 machine 启动并再注册。外部机器可以是 `codexhub machine --type registered`，也可以是 `codexhub server --register-to` 或 Web Registered 面板发起的父 server 注册；后两者仍只暴露 machine/app-server 能力，不同步子 server state。
6. `ssh` 表示 server 通过系统 `ssh -R` 建 reverse tunnel 后在远端启动 remote client。SSH 断开后该 connection 下的 machine/session 进入 offline；保存的 SSH host 可以按 autoconnect 策略重连，但不要把 SSH 抽象成插件运行器。
7. 不再支持 `type=server` machine、CodexHub server-to-server bridge、Connections / Servers tab、`/api/server-connections` 或 normalized thread mirror。
8. 父 server 注册必须防止自注册：同本机地址且同端口直接拒绝，目标 `/api/health` 返回的 `serverInstanceId` 与当前实例相同也拒绝；同一台电脑不同端口的多个 server 可以互相注册用于测试。
9. session 是一次官方 Codex app-server/headless 进程。公开 ID 是 `sessionId`；它是 machine 级 runtime，能通过 app-server 的 per-thread/per-turn `cwd` 支持多个 project。Web 中点击 project 只切换 active project path；Add Tab/thread picker 才基于 active path 创建或恢复 thread。不提供手动 restart/stop 或独立 session 管理入口。
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
6. Sessions：`GET /api/sessions`、`GET /api/sessions/:sessionId/thread-candidates`、`GET /api/sessions/:sessionId/models`、`POST /api/sessions/:sessionId/threads`、`POST /api/sessions/:sessionId/turn`。
7. Threads：`GET /api/threads`、`GET /api/threads/:threadId`、`PATCH /api/threads/:threadId/name`、`POST /api/threads/:threadId/turn`、`POST /api/threads/:threadId/stop`、`POST /api/threads/:threadId/compact`、`POST /api/threads/:threadId/review`、`POST /api/threads/:threadId/goal`、`DELETE /api/threads/:threadId/goal`、`POST /api/threads/:threadId/fork`、`POST /api/threads/:threadId/rollback`、`DELETE /api/threads/:threadId`。
8. Tasks：`GET /api/tasks`、`POST /api/tasks`、`PATCH /api/tasks/:taskId`、`DELETE /api/tasks/:taskId`、`POST /api/tasks/:taskId/run`。
9. SSH：`GET /api/ssh/config-hosts`、`GET /api/ssh/hosts`、`POST /api/ssh/hosts`、`DELETE /api/ssh/hosts/:alias`、`GET /api/ssh/connections`、`POST /api/ssh/connect`、`DELETE /api/ssh/connections/:connectionId`、`GET /api/ssh/remote-client/:hash`。
10. Plugins：`GET /api/plugins`、`GET /api/plugins/:pluginId/assets/*`。
11. Web/TG/task 发送对话时优先使用 `/api/threads/:threadId/turn`。`/api/sessions/:sessionId/turn` 只作为兼容/调试入口，body 必须包含 `threadId`，不能表示“当前 thread”。
12. project 不拥有 runtime lifecycle。`POST /api/projects/open` 只是兼容保留的 project path thread bootstrap 入口，返回 machine runtime 的 `sessionId` 和创建/恢复的 `threadId`；不要新增 per-project runtime stop/restart API。runtime session 不由 project delete 或 idle watcher 结束，只随 machine/server 生命周期断开或由内部 shutdown 清理。

## Server Config

1. server config 默认在 `CODEX_HUB_DATA_DIR` 下的 `config.yaml`，未设置 `CODEX_HUB_DATA_DIR` 时使用 `~/.config/codexhub/config.yaml`，数据结构版本为 `version: 1`。loader 兼容旧 `server-state.yaml` 并会迁移保存到 `config.yaml`。
2. config 可以保存 machines、projects、tasks、task 最近 run 摘要、SSH hosts，以及启动时填补 `process.env` 的 `env` 映射。projects/tasks/SSH hosts 属于本机配置；`updatedAt` 和最近 run 摘要属于轻量状态。config `env` 不能覆盖 shell / `.env` / CLI 参数，也不能用来改变当前 config 文件自己的位置。
3. config 不保存 thread summary 数量、history 数量、完整 transcript 内容或 project `lastSessionId`。project 的 `lastThreadId` 只是最近使用过的 Codex thread 指针，不是 transcript 权威来源；当前 runtime session 只能来自 `/api/sessions`。
4. project ID 由 `machineId + path` 推导；project 名称来自 path basename，不持久化自定义 name，也不提供 rename UI/API。
5. 删除 project 只删除 project 配置，不能停止该 machine 的 runtime session。session capture 不应创建、恢复或更新 projects；只有显式添加、保存或 project path thread bootstrap 才能写入 projects。
6. state loader 会迁移旧 `threads` 和旧 project `name` 字段；不要重新引入这些旧字段。

## Project / Task 模型

1. project 是 `machineId + path` 推导出的 UI/路由元数据。project 不拥有 Codex 进程，也不在 `/api/projects` 投影里携带 `session`、`sessions` 或 thread 列表。
2. thread 创建/恢复必须通过 machine runtime + explicit cwd/path 表达。`POST /api/sessions/:sessionId/threads` 使用 body `cwd`；兼容入口 `POST /api/projects/open` 只负责把 project path 路由到在线 machine，启动或复用 machine 级 runtime session，并返回创建/恢复的 thread。
3. project 列表不展示 open 数、thread/history 数或任何 transcript 历史数量。在线 thread 列表属于 session/thread picker 和 workspace tabs，不属于 project 卡片持久属性。
4. project 级 UI 操作可以有 pin、delete、保存 transient project 和选择 active project；不要把 session restart/stop、rename、thread count 或 thread history 重新放回 project row。
5. task 是 server-local 调度记录，选择 machine、project path、可选 thread 和五字段 cron，然后按计划向该 thread 投递一轮对话。默认 cron timezone 是 `Asia/Shanghai`。
6. task 运行时复用 project 所属 machine 的 runtime session；若配置了 `threadId` 则按 task project path resume 该 thread，否则按 task project path 创建/复用 thread 并写回 task 状态。
7. task 并发边界是 task 记录本身。同一 task 已 running/queued 时，新触发应记录为 skipped，不要叠加执行。
8. 不再扫描 `.codexp/tasks`，也不写 `.codexp/task-runs`。任务配置和最近 run 摘要都在 `config.yaml`。

## CLI 模型

1. 顶层 CLI 保留 `server`、`machine`、`ssh`、`task`；默认 headless session 入口是 legacy/transient 行为，不作为 project path thread 主路径。`list`、`threads`、`resume`、`delete` 作为隐藏 removed commands 只返回迁移错误，不做兼容实现。
2. thread history browsing、thread resume 和 new thread 选择放在 Web/API：`/api/sessions/:sessionId/thread-candidates` 和 `/api/sessions/:sessionId/threads`。模型目录来自在线 session 的 app-server `model/list`，通过 `/api/sessions/:sessionId/models` 暴露给 Web，不在 `config.yaml` 持久化。
3. `codexhub [prompt]` 是废弃的 legacy/transient headless 入口；它不是项目浏览 launcher，也不是 project path thread 主路径。不要为了它扩展新的 project/runtime 语义。
4. `--sandbox`、`--approval-policy`、`--model` 只有用户显式传参时才作为 app-server override 转发；不要偷偷发明默认权限策略。
5. CLI 默认通过 `loadDotEnv()` 读取当前 cwd 的 `.env`，并且只填补未设置的环境变量。跨目录运行 `cxh` 时要先核对 cwd 和环境来源。
6. 发布后的 bin 必须是 `#!/usr/bin/env node` + `dist-node` 编译产物，不依赖全局 `tsx`。

## Thread 行为

1. Slash command 不按普通 Codex turn 透传。server 本地只处理 `/status`、`/help`、`/model`、`/fast on|off|status`；其他 slash command 生成不支持说明。`/fast` 映射到 app-server Fast service tier（当前 catalog value 通常是 `priority`），`off` 清除显式 tier 回到 Codex 配置默认值。
2. Web composer 有 Chat / Plan / Goal 三种模式。Plan/Goal 通过本轮 turn 的 `options` 传给 server，是一次性输入状态，不应泄漏到后续默认 turn。
3. Web 在 thread running 时继续发送普通输入，应走 app-server `turn/steer`，并带当前 active `turnId`。没有 active turnId 或非 Web source 时才进入 queue fallback。
4. Web 在 running thread 上用 Goal mode 发送，应更新 active goal，而不是启动新 turn 或追加 queue。
5. Goal 状态来自 thread record 流里的 `thread_goal_updated` / `thread_goal_cleared`，需要合并 app-server snapshot 和 live records 提取；不要只看 composer 当前选中模式。
6. `POST /api/threads/:threadId/stop` 只停止当前 running turn，不是关闭 machine runtime。UI running 状态下主操作可以收敛成 stop turn。
7. `POST /api/threads/:threadId/compact` 和 Web Context 旁的 Compact 控制只触发官方 app-server `thread/compact/start`，不改写 server transcript；compact 进度和结果仍来自 app-server record 流里的 `context_compaction` / `compacted`。
8. `POST /api/threads/:threadId/review` 和 Web composer menu 的 Review changes 触发官方 app-server `review/start`，默认 target 为 `uncommittedChanges` 且 inline 跑在当前 thread。
9. app-server `thread/archive` / `thread/unarchive` 尚未接 GUI；不要把普通 thread tab close 偷偷改成持久归档，归档需要显式产品入口。
10. fork/rollback 依赖 app-server turn id 和 record 映射；改动 record id 或 compact/detailed view 时要验证 fork/rollback。

## Web 前端结构

1. `src/web/App.tsx` 负责全局状态、derived state 和 action factory 组装；不要继续把大段业务逻辑塞回渲染 JSX。
2. 操作逻辑按领域放在 `src/web/appActions/*`：`realtimeActions`、`projectActions`、`threadActions`、`composerActions`、`sshActions`、`taskActions`。
3. 渲染入口是 `AppView.tsx`、`AppSidebar.tsx`、`AppDialogs.tsx`，共享格式化和 view helpers 在 `appHelpers.tsx` 及 `helpers/*`。
4. record 渲染链路分三层：core `recordsToViews`、Web `detailedRecordViews`、shared `compactRecordViews`。Simple/compact/detailed 模式调整要先核对实际 record source。
5. Web 优先显示 app-server snapshot/live events 归一化后的 records；goal/status/notification 这类提取逻辑可以合并 snapshot 和 live records，但不要把主消息渲染链随意改成双源重复。
6. Workspace thread tabs 使用 Ant Design Tabs 的官方 editable-card 行为和 pane 高度契约；不要为 add/remove 重新写一套自定义 tabs 外观。
7. VSCode surface 使用同一套 Web UI 和完整左侧控制面。`surface=vscode` 只用于 VSCode 通知桥、daemon 兼容判断、workspace project group 等嵌入环境差异，不应隐藏 sidebar 或关闭 SSH/tasks/plugins/Registered 能力。
8. 任务完成通知：完成音效总是由 Web 播放；Settings 里的 `taskCompleteSystemNotifications` 只控制系统弹窗，普通 Web 走 browser Notification，VSCode 走 iframe `postMessage` 到 extension，再由 VSCode notification 展示。
9. Thread Model 弹窗的 model/reasoning/service tier 选项优先使用当前在线 app-server `model/list` catalog；catalog 不可用时才回退本地静态兜底，不能把 catalog 保存进 `config.yaml`。
10. UI 文案和交互不要重新暴露已删除概念：worker、instance、project rename、project thread/history count、per-project runtime restart/stop。

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
3. VSCode extension 注册 sidebar webview，每个 VSCode 窗口默认启动自己的随机端口嵌入 server，并把 `CODEX_HUB_DATA_DIR` 语义收敛到 VSCode extension `globalStorageUri` 对应的数据目录；只有显式 `CODEX_HUB_PORT` 时才固定端口，端口占用应直接失败。Webview iframe 和 Open in Browser 必须通过 `vscode.env.asExternalUri` 暴露 server URL，不能直接写 raw loopback URL。
4. VSCode extension 自动 `POST /api/projects/open` 当前窗口的 file workspace folders，body 使用 `persist:false` 和 `source.kind="vscode"`；打开前先从 `/api/machines` 选在线 `local` + `projectLauncher !== false` 的 machineId，避免依赖默认 machine 推断。VSCode 窗口内嵌 local machine 和这些 workspace projects 都只显示在内存中，不写入 `config.yaml`，用户显式保存 project 后才变成普通 project。
5. VSCode workspace project 打开要容忍 embedded server listen 后 local launcher 尚未完成注册的 race：对 `HTTP 409` + launcher offline 类错误按 `500ms * 30` 重试；没有 file workspace folder 时只显示状态页。
6. VSCode extension 启用和普通 Web 相同的 SSH/tasks/integrations/Registered 能力；这些配置仍属于对应窗口 server/state，窗口自动 workspace project 不应污染全局持久 project list。
7. VSCode 打包由 `scripts/build-vscode.ts` 负责：先完整 build，再将 extension 打成 Node CJS bundle、把 `navigator` 定义为 `undefined` 并断言 bundle 不引用浏览器全局；staging 必须包含 `dist`、`dist-node/ssh`、media、README、LICENSE。
8. Docker 镜像运行 server/Web/API，默认应关闭内嵌 local machine，由宿主机、registered machine 或 SSH 接入真实 machine runtime。

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

4. `smoke:machine-session` 覆盖 local machine、project path thread bootstrap、跨 project 共享 machine runtime、session account rate limits、session/thread `/status`、pending shell command 展示、server-local task、plugin CSS、SSH 参数构造、project delete 和 watcher idle 不误停 runtime、旧 `workerId` registration 拒绝，以及不持久化 thread history/name。
5. `smoke:auth` 覆盖 token 保护、Bearer token、WebSocket token query、machine websocket 授权。
6. `smoke:registered-machine` 覆盖真实 `codexhub machine --type registered` CLI、`codexhub server --register-to`、动态 parent 注册、Register URL token 提取、自注册拒绝、同机不同端口注册、项目打开、session/thread 对话流，以及 SIGTERM 后 machine/session unregister lifecycle 和 app-server 进程清理。
7. `smoke:ssh-loopback` 覆盖真实本机 sshd、`ssh -R` reverse tunnel、SSH remote client、项目打开、session/thread 对话流和断开 lifecycle。
8. `smoke:task-lock` 覆盖 session model catalog、thread compact command、thread review command、task 并发跳过、thread records subscription、Plan/Goal options、running turn steer、goal set/clear、stop turn、idle-close 和 token usage rate limits。
9. `smoke:electron` 覆盖 Electron main process、嵌入 server 随机端口和 `/api/health`。
10. VSCode 改动低成本验证链路是 `pnpm check`、`pnpm package:vscode`、`code --install-extension dist-vscode/codexhub.vsix --force`。
11. VSCode Marketplace 发布 workflow 在 `.github/workflows/publish-vscode.yml`，支持 `main` 分支 push 自动触发和 `workflow_dispatch` 手动触发，要求仓库 secret `VSCE_PAT`，先 `pnpm run package:vscode`，再用 `vsce publish --packagePath dist-vscode/codexhub.vsix --skip-duplicate`。
