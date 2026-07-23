# codexhub 架构约定

## Agent 开发与 CDP 测试

Agent 开发改动时按这套固定流程起本地服务并用 CDP 测试，不要临时发明端口或浏览器实例。

1. 默认使用 `pnpm dev` 同时启动两个本地服务：后端 `pnpm run dev:api`（监听 `127.0.0.1:18788`），前端 `pnpm run dev:web`（Vite 监听 `127.0.0.1:15173`，`/api` 代理到 `18788`）。只改后端可只起 `dev:api`，只改前端可只起 `dev:web`。不要改默认端口，也不要让两端的端口对不上。
2. CDP 必须复用全局规则里的 Windows Chrome 实例（`http://127.0.0.1:19222`，user-data-dir `D:\Chrome\User Data`）。连不上就按全局 CDP 排查步骤处理，不要自启其他 Chrome/Chromium、不要换端口或 user-data-dir、不要用 Playwright 自带浏览器。
3. 浏览测试入口是前端 `http://127.0.0.1:15173`；Vite 会把 `/api` 请求代理到 `18788`，所以单开一个 tab 即可覆盖前后端链路，不要再单独打开 `18788`。
4. 自动化优先新建 tab 工作，不复用用户已有 tab；任务结束只关闭本次任务创建的 tab，不要关闭 CDP 浏览器、Chrome 进程或整个 browser context。直接用 Playwright API 连接 CDP 时结束用 `browser.disconnect()`，不要用 `browser.close()`。
5. 联网/页面测试要访问真实页面，验证完要说明访问了哪个 URL、观察到什么、结论是什么。遇到登录、验证码、端口未起或页面报错要明确说明卡点，不要编造结果。
6. 跑改动验证前先 `pnpm check`；端到端验证按「发布和验证」章节的 smoke 命令选对应项。

## 总体方向

codexhub 是 local-first 的 Codex 控制面：本机 Node.js server 提供 HTTP/WebSocket API 和 Web UI，machine 侧负责路径解析、官方 `codex app-server`/headless 进程启动、thread 操作和 app-server transcript 同步。server 可以镜像事件、维护控制面状态和调度任务，但不能变成 Codex app-server、远端文件系统或 thread transcript 的权威来源。

当前产品心智是 project-first、machine-runtime-second。公开模型以 `machineId`、`projectId`、`threadId` 为主；一台 machine 同时最多只有一个在线 Codex runtime，它可以承载多个不同 project cwd 的 threads。`sessionId` 只标识内部 app-server/headless 进程代次，不进入公共 HTTP、Web state、task history 或 thread 投影。`/api/projects` 是 Web 主投影，project 只带 `machineOnline` 等 project/machine 元数据，不携带 runtime 或 thread 列表；`/api/runtimes` 按稳定 `machineId` 投影当前 runtime 状态。

不要恢复旧 `workerId` 模型。`workerId` 只允许出现在 legacy 输入拒绝、回归断言或迁移说明里；公共 JSON 和 Web 主模型使用 `machineId`，内部 machine/session bridge 才允许使用 `sessionId`。不要恢复 `/api/workers`、`/api/instances`、`/api/sessions`、`.codexp/instances.yaml` 或旧 worker/instance 兼容层。

## 运行入口

1. 包名是 `@dadigua/codexhub`，公开 bin 是 `codexhub` 和 `cxh`，两者指向同一个 CLI 入口。
2. 生产/本地 server 入口是 `codexhub server`，默认监听 `0.0.0.0:8788`；本机访问 URL 仍显示为 `http://127.0.0.1:8788`，`CODEX_HUB_HOST`、`CODEX_HUB_PORT` 或 CLI 参数可以覆盖。
3. 开发时默认用 `pnpm dev` 同时启动 API 和 Web；单独启动时 API 用 `pnpm run dev:api`，Web 用 `pnpm run dev:web`，Vite 默认 `15173` 并代理 `/api` 到 `18788`。
4. `codexhub machine --type registered` 注册一台可为 project path 启动 thread 的 machine；内嵌 local machine 也走同一套 machine command 协议。
5. `codexhub server --register-to <parent>` 会启动当前 server，并额外把它作为一台 `registered` machine 接入父 server；这不是 server-to-server state bridge。
6. `codexhub ssh ...` 是 server-side SSH 管理入口；SSH remote client 由本机 server bootstrap 下发，不要求远端预装 codexhub。
7. VSCode 和 Electron 都调用 `src/server/embedded.ts` 复用同一套 server/Web。VSCode 默认每个窗口启动自己的随机端口嵌入 server，并共享 VSCode extension `globalStorageUri` 下的 `config.yaml`；parent URL 和可选 token 可以跨窗口共享，但每个 workspace 必须使用 `workspaceState` 下独立、稳定的 parent registration machineId，不能让多个窗口争用同一个 machine transport。窗口内嵌 local machine 和自动 workspace projects 只作为 transient 内存投影，不写入持久配置。Electron 默认随机端口，只有显式 `CODEX_HUB_PORT` 时才固定端口。
8. machine/headless 启动官方 `codex app-server` 时必须走 `resolveCodexCommand()`：优先 `CODEX_HUB_CODEX_CLI`，再查 `PATH` 和常见 npm/pnpm 全局 bin；Windows `.cmd` / `.bat` 需要经 `cmd.exe /d /s /c call` 启动。`CODEX_HUB_APP_SERVER_READY_TIMEOUT_MS` 控制 `/readyz` 等待时间，错误应带最近 app-server stderr tail。

## Machine / Session / Thread

1. `MachineType = "local" | "ssh" | "registered"`。
2. machine 是路径解析、目录 listing、machine runtime 和 project path thread 启动的执行者。server 不扫描远端文件系统；`/api/machines/:machineId/directories` 和 project path thread bootstrap 都必须发给在线 machine，由 machine 在自身环境确认 path 是可进入目录。
3. machine capability 里 `projectLauncher` 很重要。Web 只应把可启动 project 的 machine 用于 Add Project。
4. `local` 表示 server 内嵌的 project launcher，普通 server 默认启用，Docker/测试/嵌入 surface 可用 `CODEX_HUB_LOCAL_MACHINE=0` 或 feature override 关闭。
5. `registered` 表示外部机器主动连接 `/api/machines/connect`。它注册的是 machine，不是公共 runtime；server 通过内部 `ensure_runtime` / `start_session` machine command 让它启动或复用唯一 app-server 进程并完成内部 session registration。外部机器可以是 `codexhub machine --type registered`，也可以是 `codexhub server --register-to` 或 Web Registered 面板发起的父 server 注册；后两者仍只暴露 machine/app-server 能力，不同步子 server state。父 server 上的 registered machine 是纯运行时投影，不写入 `config.yaml`，连接断开后从 machine 列表移除；子 server 自己的 `parentRegistration` 仍按配置持久化以支持重连。Web 从 `projects` realtime snapshot 检测在线 registered machine 的连接变化：新连接用 Ant Design success message 提示，断开用 warning message 提示；首次加载已有连接不补弹，断开后重连可再次提示。
6. `ssh` 表示 server 通过系统 `ssh -R` 建 reverse tunnel 后在远端启动 remote client。SSH 断开后该 connection 下的 machine/session 进入 offline；保存的 SSH host 可以按 autoconnect 策略重连，但不要把 SSH 抽象成插件运行器。
7. 不再支持 `type=server` machine、CodexHub server-to-server bridge、Connections / Servers tab、`/api/server-connections` 或 normalized thread mirror。
8. 父 server 注册必须防止自注册：同本机地址且同端口直接拒绝，目标 `/api/health` 返回的 `serverInstanceId` 与当前实例相同也拒绝；同一台电脑不同端口的多个 server 可以互相注册用于测试。
9. session 是一次官方 Codex app-server/headless 进程代次，只在内部 transport 使用。公共 runtime 以 `machineId` 标识，能通过 app-server 的 per-thread/per-turn `cwd` 支持多个 project。Web 中点击 project 只切换 active project path；Add Tab/thread picker 才基于 active path 创建或恢复 thread。不提供手动 restart/stop 或独立 session 管理入口。
10. threadId 来自官方 Codex app-server。server/Web/TG/task 读取和展示 thread transcript，但 transcript 来源只能是 app-server turns snapshot、实时 item/rawResponseItem/tokenUsage 事件。
11. server/session 不维护 `currentThreadId` 或 `currentThread`。Web 当前 tab、Telegram chat 绑定、task `threadId` 都是各自的客户端/任务选择状态；发送入口最终必须显式知道目标 `threadId`。
12. machine/session registration 都是 strict schema。未知字段以及旧 `workerId`、`currentThreadId` 必须直接拒绝，不能静默丢弃或重新进入公共模型。

## App-server Thread Sync 和实时流

1. Web 只维护一条 `/api/events/ws`。连接后发送 `hello` 订阅 control-plane snapshots，再用 `subscribe_thread` / `unsubscribe_thread` 多路复用页面 thread tabs。
2. Control-plane 事件包括 `runtimes`、`projects`、`tasks`、`connections`；thread 事件只包括 `thread`、`record`、`done`。
3. 浏览器不直接连接官方 app-server。server 通过内部 session command 发送 `subscribe_thread_records` / `unsubscribe_thread_records`，由 machine bridge 负责 app-server turns snapshot 和 live events。
4. 每个被 Web 订阅的 thread 在一个 bridge 里只能有一份 thread records subscription。server 对 thread subscription 做 ref-count，并用 `CODEX_HUB_THREAD_RECORD_SUBSCRIPTION_IDLE_MS` 做 idle grace。
5. Thread records subscription 只由 Web thread tab 订阅驱动。解绑后要保留 still-subscribed race guard，避免刚 unsubscribe 又被旧 async sync 重新写入。
6. runtime session 不走 idle auto-stop。machine 只维护一个 app-server/headless runtime，生命周期跟 machine/server 主进程走；project delete、subscription idle-close 和普通空闲都不能触发 `stop_session`。
7. `CODEX_HUB_THREAD_RECORD_SUBSCRIPTION_IDLE_MS=0` 只表示禁用 subscription idle-close。session heartbeat 只表示进程存活，不能当成用户活跃信号。
8. 不再保留 SSE 事件入口；实时控制面和 thread 增量统一走 `/api/events/ws`。
9. thread context usage 来自 `thread/tokenUsage/updated`；账号 rate limits 独立来自 `account/rateLimits/read` 和 `account/rateLimits/updated`，进入按 machine 投影的 `RuntimeSummary.accountRateLimits`。Web 合并两者展示，不能再从 tokenUsage payload 读取 rate-limit 字段。

## 公共 API 约定

1. 基础和认证：`GET /api/health`、`GET /api/auth/status`。设置 `CODEX_HUB_AUTH_TOKEN` 后，除 health/auth/status、registered/SSH remote-client bundle、plugin assets 和静态页面外，API 都需要 token。普通 API 使用 `Authorization: Bearer`；WebSocket、文件预览和 Register URL 使用 `?codexhub_token=`。
2. Machines / runtimes：`GET /api/machines`、`GET /api/machines/:machineId/directories`、`GET /api/machines/connect` WebSocket、`GET /api/runtimes`、`POST /api/machines/:machineId/runtime/ensure`。
3. Registered parent：`GET /api/registered/parent`、`POST /api/registered/parent`、`DELETE /api/registered/parent`、`GET /api/registered/bootstrap`、`GET /api/remote-client/:hash`。GUI `POST` 会把规范化 URL、普通 server 的 machine identity 和可选 auth token 保存到当前 server 的 `config.yaml`，共享 `startServer()` 在普通 Web、VSCode、Electron 重启时自动恢复；VSCode 只持久化共享 parent profile，runtime identity 由 workspace `workspaceState` 覆盖。token 可以为空，显式空字符串表示不使用 parent auth。`DELETE` 必须中止连接中的 WebSocket、等待 runner 完全停止并删除自动注册配置。body `url` 可以携带 `?codexhub_token=`；bootstrap 脚本通过 `/api/remote-client/:hash` 拉当前 build 的 remote client。
4. Realtime：`GET /api/events/ws` WebSocket。
5. Projects：`GET /api/projects`、`POST /api/projects/open`、`PATCH /api/projects/:projectId`、`DELETE /api/projects/:projectId`。`PATCH` 目前只更新 `pinned`。
6. Machine runtime：`GET /api/machines/:machineId/thread-candidates`、`GET /api/machines/:machineId/models`、`GET /api/machines/:machineId/permission-profiles`、`GET /api/machines/:machineId/command-palette`、`POST /api/machines/:machineId/threads`。
7. Threads：`GET /api/threads`、`GET /api/threads/:threadId`、`PATCH /api/threads/:threadId/name`、`POST /api/threads/:threadId/turn`、`POST /api/threads/:threadId/stop`、`POST /api/threads/:threadId/compact`、`POST /api/threads/:threadId/review`、`POST /api/threads/:threadId/goal`、`DELETE /api/threads/:threadId/goal`、`POST /api/threads/:threadId/fork`、`DELETE /api/threads/:threadId`。
8. Tasks：`GET /api/tasks`、`POST /api/tasks`、`PATCH /api/tasks/:taskId`、`DELETE /api/tasks/:taskId`、`POST /api/tasks/:taskId/run`。
9. SSH：`GET /api/ssh/config-hosts`、`GET /api/ssh/hosts`、`POST /api/ssh/hosts`、`DELETE /api/ssh/hosts/:alias`、`GET /api/ssh/connections`、`POST /api/ssh/connect`、`DELETE /api/ssh/connections/:connectionId`、`GET /api/ssh/remote-client/:hash`。
10. Plugins：`GET /api/plugins`、`GET /api/plugins/:pluginId/assets/*`。
11. Web/TG/task 和外部 API 发送对话统一使用 `/api/threads/:threadId/turn`，不提供 session 级 turn 兼容入口。
12. project 不拥有 runtime lifecycle。`POST /api/projects/open` 是显式 project path bootstrap/persistence 入口，返回 `machineId` 和创建/恢复的 `threadId`；Add Thread 冷启动必须调用 `POST /api/machines/:machineId/runtime/ensure`，不能借用 project open 造成 project 状态写入。不要新增 per-project runtime stop/restart API。runtime 不由 project delete 或 idle watcher 结束，只随 machine/server 生命周期断开或由内部 shutdown 清理。

## Server Config

1. server config 默认在 `CODEX_HUB_DATA_DIR` 下的 `config.yaml`，未设置 `CODEX_HUB_DATA_DIR` 时使用 `~/.config/codexhub/config.yaml`，数据结构版本为 `version: 1`。loader 兼容旧 `server-state.yaml` 并会迁移保存到 `config.yaml`。
2. config 可以保存 parent registration、local/SSH machine 元数据、projects、tasks、task 最近 run 摘要、SSH hosts，以及启动时填补 `process.env` 的 `env` 映射。父 server 收到的 registered machine 不持久化，旧配置中的 registered machine 元数据由 loader 清理且不影响关联 project/task。parent registration/projects/tasks/SSH hosts 属于本机配置；`updatedAt` 和最近 run 摘要属于轻量状态。parent auth token 可省略且只允许后端读取，不能通过 API、状态 message 或日志投影给 Web，保存配置时文件权限必须是 `0600`。VSCode 共享 parent profile 不保存 runtime machineId/name；这些字段由 workspace identity 提供。config `env` 不能覆盖 shell / `.env` / CLI 参数，也不能用来改变当前 config 文件自己的位置。
3. config 不保存 thread summary 数量、history 数量、完整 transcript 内容、runtime 进程代次或 project `lastSessionId`。project 的 `lastThreadId` 只是最近使用过的 Codex thread 指针，不是 transcript 权威来源；当前 runtime 只能来自 `/api/runtimes`。
4. project ID 由 `machineId + path` 推导；project 名称来自 path basename，不持久化自定义 name，也不提供 rename UI/API。
5. 删除 project 只删除 project 配置，不能停止该 machine 的 runtime session。session capture 不应创建、恢复或更新 projects；只有显式添加、保存或 project path thread bootstrap 才能写入 projects。
6. state loader 会迁移旧 `threads` 和旧 project `name` 字段；不要重新引入这些旧字段。

## Project / Task 模型

1. project 是 `machineId + path` 推导出的 UI/路由元数据。project 不拥有 Codex 进程，也不在 `/api/projects` 投影里携带 `session`、`sessions` 或 thread 列表。
2. thread 创建/恢复必须通过 machine runtime + explicit cwd/path 表达。`POST /api/machines/:machineId/threads` 使用 body `cwd`；`POST /api/projects/open` 只负责显式 project path bootstrap/persistence，Add Thread 冷启动先调用 machine runtime ensure，再用 machine thread API 创建或恢复 thread。
3. project 列表不展示 open 数、thread/history 数或任何 transcript 历史数量。在线 thread 列表属于 machine thread picker 和 workspace tabs，不属于 project 卡片持久属性。
4. project 级 UI 操作可以有 pin、delete、保存 transient project 和选择 active project；不要把 session restart/stop、rename、thread count 或 thread history 重新放回 project row。
5. task 是 server-local 调度记录，选择 machine、project path、可选 thread 和五字段 cron，然后按计划向该 thread 投递一轮对话。默认 cron timezone 是 `Asia/Shanghai`。
6. task 运行时复用 project 所属 machine 的 runtime session；若配置了 `threadId` 则按 task project path resume 该 thread，否则按 task project path 创建/复用 thread 并写回 task 状态。
7. task 并发边界是 task 记录本身。同一 task 已 running/queued 时，新触发应记录为 skipped，不要叠加执行。
8. 不再扫描 `.codexp/tasks`，也不写 `.codexp/task-runs`。任务配置和最近 run 摘要都在 `config.yaml`。

## CLI 模型

1. 顶层 CLI 只保留 `server`、`machine`、`ssh`、`task`、`install-vscode`、`install-theia`；两个 install 命令只负责把 npm 包内共享的 `dist-vsix/codexhub.vsix` 安装到对应 IDE，不扩展 project/runtime 语义。未知命令直接报错，不保留旧命令或根级 prompt 兼容入口。
2. thread history browsing、thread resume 和 new thread 选择放在 Web/API：`/api/machines/:machineId/thread-candidates` 和 `/api/machines/:machineId/threads`。模型目录来自该 machine 当前在线 runtime 的 app-server `model/list`，通过 `/api/machines/:machineId/models` 暴露给 Web，不在 `config.yaml` 持久化。
3. `--sandbox`、`--approval-policy` 只有用户显式传参时才作为 app-server override 转发；不要偷偷发明默认权限策略。
4. CLI 默认通过 `loadDotEnv()` 读取当前 cwd 的 `.env`，并且只填补未设置的环境变量。跨目录运行 `cxh` 时要先核对 cwd 和环境来源。
5. 发布后的 bin 必须是 `#!/usr/bin/env node` + `dist-node` 编译产物，不依赖全局 `tsx`。

## Thread 行为

1. Slash command 不按普通 Codex turn 透传。server 本地只处理 `/status`、`/help`、`/model`、`/fast on|off|status`；其他 slash command 生成不支持说明。`/fast` 映射到 app-server Fast service tier（当前 catalog value 通常是 `priority`），`off` 清除显式 tier 回到 Codex 配置默认值。
2. Web composer 有 Chat / Plan / Goal 三种模式。Plan/Goal 通过本轮 turn 的 `options` 传给 server，是一次性输入状态，不应泄漏到后续默认 turn。Permissions 必须从当前在线 app-server 的 `permissionProfile/list` 动态读取；`permissions` 与旧 `sandboxPolicy` 互斥，不能在 Web 写死 profile 目录。
3. Web 在 thread running 时继续发送普通输入，应走 app-server `turn/steer`，并带当前 active `turnId`。没有 active turnId 或非 Web source 时才进入 queue fallback。
4. Web 在 running thread 上用 Goal mode 发送，应更新 active goal，而不是启动新 turn 或追加 queue。
5. Goal 状态来自 thread record 流里的 `thread_goal_updated` / `thread_goal_cleared`，需要合并 app-server snapshot 和 live records 提取；不要只看 composer 当前选中模式。
6. `POST /api/threads/:threadId/stop` 只停止当前 running turn，不是关闭 machine runtime。UI running 状态下主操作可以收敛成 stop turn。
7. `POST /api/threads/:threadId/compact` 和 Web Context 旁的 Compact 控制只触发官方 app-server `thread/compact/start`，不改写 server transcript；compact 进度和结果来自 app-server `contextCompaction` item 归一化出的 `context_compaction` record。
8. `POST /api/threads/:threadId/review` 和 Web composer menu 的 Review changes 触发官方 app-server `review/start`，默认 target 为 `uncommittedChanges` 且 inline 跑在当前 thread。
9. app-server `thread/archive` / `thread/unarchive` 尚未接 GUI；不要把普通 thread tab close 偷偷改成持久归档，归档需要显式产品入口。
10. Fork 依赖 app-server turn id 和 record 映射。`POST /api/threads/:threadId/fork` 必须用 `thread/fork` + `lastTurnId` 创建新 thread，不能新增 Rewind/rollback UI 或 API，也不能调用已废弃的 `thread/rollback` 或原地改写源 thread；改动 record id 或 compact/detailed view 时要验证 Fork。

## Web 前端结构

1. `src/web/App.tsx` 负责全局状态、derived state 和 action factory 组装；不要继续把大段业务逻辑塞回渲染 JSX。
2. 操作逻辑按领域放在 `src/web/appActions/*`：`realtimeActions`、`projectActions`、`threadActions`、`composerActions`、`sshActions`、`taskActions`。
3. 渲染入口是 `AppView.tsx`、`AppSidebar.tsx`、`AppDialogs.tsx`，共享格式化和 view helpers 在 `appHelpers.tsx` 及 `helpers/*`。
4. record 渲染链路分三层：core `recordsToViews`、Web `detailedRecordViews`、shared `compactRecordViews`。Simple/compact/detailed 模式调整要先核对实际 record source。
5. Web 优先显示 app-server snapshot/live events 归一化后的 records；goal/status/notification 这类提取逻辑可以合并 snapshot 和 live records，但不要把主消息渲染链随意改成双源重复。
6. Workspace thread tabs 使用 Ant Design Tabs 的官方 editable-card 行为和 pane 高度契约；不要为 add/remove 重新写一套自定义 tabs 外观。
7. VSCode surface 使用同一套 Web UI 和完整左侧控制面。`surface=vscode` 只用于 VSCode 通知桥、daemon 兼容判断、workspace project group 等嵌入环境差异，不应隐藏 sidebar 或关闭 SSH/tasks/plugins/Registered 能力。
8. 任务完成通知：完成音效总是由 Web 播放；Settings 里的 `taskCompleteSystemNotifications` 只控制系统弹窗，普通 Web 走 browser Notification，VSCode 走 iframe `postMessage` 到 extension，再由 VSCode notification 展示。
9. Thread Model 弹窗的 model/reasoning/service tier 选项只使用当前在线 app-server `model/list` catalog；catalog 不可用时显示加载/错误状态并禁用选择，不提供本地静态 fallback，也不能把 catalog 保存进 `config.yaml`。
10. Composer 权限菜单的 permission profile 只使用当前在线 app-server `permissionProfile/list` catalog；允许展示协议固定的 approval policy / reviewer 枚举，但不能为 profile 提供本地静态 fallback，也不能把 profile catalog 保存进 `config.yaml`。
11. UI 文案和交互不要重新暴露已删除概念：worker、instance、project rename、project thread/history count、per-project runtime restart/stop。

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
5. SSH remote client 只使用 bootstrap mode：远端 `node` 经 reverse tunnel 下载本机 server 暴露的 `dist-node/ssh/remote-client.cjs`，按 sha256 缓存到 `~/.cache/codexhub/remote-client/<hash>/client.cjs` 后执行。
6. `CODEX_HUB_SSH_REMOTE_CLIENT_PATH` 可覆盖 remote-client bundle 路径；缺 bundle 时应明确失败并提示先 build。

## Electron / VSCode / Docker

1. Electron main process 只包装同一个 server 和 Web UI。窗口使用隔离/sandbox WebPreferences，外链用系统浏览器打开。
2. Electron 默认随机端口；显式设置 `CODEX_HUB_PORT` 后端口被占用应直接失败，不再 fallback。
3. VSCode extension 注册 sidebar webview，每个 VSCode 窗口默认启动自己的随机端口嵌入 server，并把 `CODEX_HUB_DATA_DIR` 语义收敛到 VSCode extension `globalStorageUri` 对应的共享数据目录；只有显式 `CODEX_HUB_PORT` 时才固定端口，端口占用应直接失败。每个 workspace 必须在 `workspaceState` 保存独立 parent registration machineId，并通过 embedded `parentRegistrationIdentity` 覆盖共享 profile，显示名应包含 workspace 名称。Webview iframe 和 Open in Browser 必须通过 `vscode.env.asExternalUri` 暴露 server URL，不能直接写 raw loopback URL。
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
pnpm run check:app-server-protocol
pnpm check
pnpm run smoke:core
pnpm run smoke:ssh-loopback
pnpm run smoke:electron
pnpm build
```

4. `smoke:machine-session` 覆盖 local machine、project path thread bootstrap、跨 project 共享 machine runtime、session account rate limits、session/thread `/status`、pending shell command 展示、server-local task、plugin CSS、SSH 参数构造、project delete 和 watcher idle 不误停 runtime、旧 `workerId` registration 拒绝，以及不持久化 thread history/name。
5. `smoke:auth` 覆盖 token 保护、Bearer token、WebSocket token query、machine websocket 授权。
6. `smoke:registered-machine` 覆盖真实 `codexhub machine --type registered` CLI、`codexhub server --register-to`、动态 parent 注册、Register URL token 提取、空 token、子 server parent registration 的配置持久化与重启恢复、父 server 不持久化 registered machine、Disconnect 清除自动连接、共享 parent profile 下独立 workspace identity、自注册拒绝、同机不同端口注册、项目打开、session/thread 对话流，以及 SIGTERM 后 machine/session unregister lifecycle、machine 动态移除和 app-server 进程清理。runner 单元测试必须覆盖认证失败不泄露 token，以及 connecting 阶段 stop 会终止底层 socket。
7. `smoke:ssh-loopback` 覆盖真实本机 sshd、`ssh -R` reverse tunnel、SSH remote client、项目打开、session/thread 对话流和断开 lifecycle。
8. `smoke:task-lock` 覆盖 session model catalog、thread compact command、thread review command、task 并发跳过、thread records subscription、Plan/Goal options、running turn steer、goal set/clear、stop turn、idle-close、token usage 和 session account rate limits。
9. `smoke:electron` 覆盖 Electron main process、嵌入 server 随机端口和 `/api/health`。
10. VSCode 改动低成本验证链路是 `pnpm check`、`pnpm package:vscode`、`code --install-extension dist-vsix/codexhub.vsix --force`。
11. 公开版本由 `.github/workflows/release.yml` 统一发布，只允许与根 `package.json` 版本一致的 `v<version>` 标签触发；`main` push 不应直接发布。workflow 需要 `NPM_TOKEN` 和 `VSCE_PAT`，并按可重试方式发布两个 npm 包、VS Code Marketplace 和 GitHub Release。
12. `pnpm run package:release` 只做一次完整 build，再产出 `release-artifacts/dadigua-codexhub-<version>.tgz`、`release-artifacts/codexhub-<version>.vsix`、`release-artifacts/dadigua-codexhub-theia-<version>.tgz`。根 CLI npm 包必须内含 `dist-vsix/codexhub.vsix`；原生 Theia npm 包是另一种编译期实现，不能与共享 VSIX 混为同一产物。
13. 当前最低支持 Codex CLI `0.144.4`。`@openai/codex` devDependency 固定为该版本，`pnpm run check:app-server-protocol` 必须用它生成包含 experimental API 的 TypeScript schema 并校验 CodexHub 依赖的当前 contract；CI 和 release 都要运行这条检查及 `smoke:core`。
14. 删除公开 API、CLI、环境变量、存储 key 或旧协议兼容层属于 breaking change；发版前必须 bump 新版本并更新 `MIGRATION.md`，不能移动或复用已经发布的 tag。
15. `publish:prod` 必须注入非空 `CODEX_HUB_BUILD_ID`，验证 health 返回相同 build，并让 PM2 直接执行仓库 `bin/codexhub`；不要把 VSCode Server 自带的版本化 Node 路径保存成 PM2 script。
