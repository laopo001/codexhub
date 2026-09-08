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

当前产品心智是 project-first、machine-runtime-second。公开模型以 `machineId`、`projectId`、`threadId` 为主；一台 machine 同时最多只有一个在线 Codex runtime，它可以承载多个不同执行 cwd/workspace context 的 threads。`sessionId` 只标识内部 app-server/headless 进程代次，不进入公共 HTTP、Web state、task history 或 thread 投影。`/api/projects` 是 Web 主投影，project 只带 `machineOnline` 等 project/machine 元数据，不携带 runtime 或 thread 列表；`/api/runtimes` 按稳定 `machineId` 投影当前 runtime 状态。

身份和所有权的详细定义以 `docs/architecture/surface-machine-workspace-project-thread.md` 为准。`workingDirectory` 只是 thread/app-server 的执行 cwd 或 resume hint，不是 project identity、workspace identity 或 surface membership。workspace 可以包含多个 projects/paths；project identity 仍严格是 `machineId + path`。需要 thread 的 project 来源时，必须在 UI 动作边界显式保留 project target，不能用 cwd/path equality、路径包含关系或唯一匹配反推。

不要恢复旧 `workerId` 模型。`workerId` 只允许出现在 legacy 输入拒绝、回归断言或迁移说明里；公共 JSON 和 Web 主模型使用 `machineId`，内部 machine/session bridge 才允许使用 `sessionId`。不要恢复 `/api/workers`、`/api/instances`、`/api/sessions`、`.codexp/instances.yaml` 或旧 worker/instance 兼容层。

## 运行入口

1. 包名是 `@dadigua/codexhub`，公开 bin 是 `codexhub` 和 `cxh`，两者指向同一个 CLI 入口。
2. 生产/本地 server 入口是 `codexhub server`，默认监听 `127.0.0.1:28788`，WSL 默认 `127.0.0.1:28789`；与 VSCode/Electron 共用本机 authority，`CODEX_HUB_HOST`、`CODEX_HUB_PORT` 或 CLI 参数可以覆盖。
3. 开发时默认用 `pnpm dev` 同时启动 API 和 Web；单独启动时 API 用 `pnpm run dev:api`，Web 用 `pnpm run dev:web`，Vite 默认 `15173` 并代理 `/api` 到 `18788`。
4. `codexhub machine --type registered` 注册一台可为 project path 启动 thread 的 machine；内嵌 local machine 也走同一套 machine command 协议。
5. `codexhub register --to <parent>` 调用已有本机后端的 `/api/registered/parent` 后退出；全局 `--connect` 指定本机后端。`codexhub server --register-to <parent>` 是启动并注册的快捷入口，Web Registered 面板复用同一注册实现。后端注册仅接入子机 local machine 的执行能力，复用唯一 local runtime；不得为其另起 app server 或让父机建立 app-server 协议客户端。local machine 禁用时明确拒绝注册。
6. `codexhub ssh ...` 是 server-side SSH 管理入口；SSH remote client 由本机 server bootstrap 下发，不要求远端预装 codexhub。
7. CLI、VSCode 和 Electron 通过共享 `src/server/authorityService.ts` 和 `src/server/embedded.ts` 复用同一套 server/Web。每个执行 authority 只运行一个 detached authority service，Windows、macOS 和普通 Linux 默认固定监听 `127.0.0.1:28788`，WSL 默认使用 `127.0.0.1:28789`，避免 mirrored networking 下与 Windows 的 `28788` 冲突；Windows、每个 WSL distro、每个 Remote SSH host/user 和容器仍是彼此独立的 authority。CLI、VSCode 和 Electron 都先 probe 这个 authority，只有第一个客户端启动 service，后续客户端 attach；固定端口被非匹配服务占用时必须明确失败，不能静默顺延。端口统一使用 `CODEX_HUB_PORT`，`CODEX_HUB_AUTHORITY_PORT` 为兼容别名，两者不一致时报错，CLI `--port` 优先；若明确需要局域网访问，通过 `CODEX_HUB_HOST=0.0.0.0` 或 `::` 显式覆盖默认 loopback，旧 `CODEX_HUB_AUTHORITY_HOST` 为兼容别名。authority 默认只监听 loopback，默认不启用 access token；只有 extension host 环境或 authority `config.yaml` 的 `env.CODEX_HUB_AUTH_TOKEN` 显式非空时才启用认证。authority 使用共享数据目录、`config.yaml`、唯一 local runtime 和 parent machine transport；VSCode/Electron 各自通过 lease 注册 surface，窗口 surface 和自动 workspace projects 只作为 transient 内存投影，不写入持久配置。
8. machine/headless 启动官方 `codex app-server` 时必须走 `resolveCodexCommand()`：优先 `CODEX_HUB_CODEX_CLI`，再查 `PATH` 和常见 npm/pnpm 全局 bin；Windows `.cmd` / `.bat` 需要经 `cmd.exe /d /s /c call` 启动。`CODEX_HUB_APP_SERVER_READY_TIMEOUT_MS` 控制 `/readyz` 等待时间，错误应带最近 app-server stderr tail。不要读取 Codex 私有 `models_cache.json`，也不要注入 `model_catalog_json`；machine 只把在线 app-server 的标准 `model/list` 归一化结果缓存到 server data directory 下的 `runtime-catalog-cache/`，复用 TTL、并发去重、过期后台刷新和原子持久化。模型缓存按 machine、CLI 版本、app-server 报告的 `codexHome` 和 hidden 模式隔离，每个作用域使用独立文件，避免共享 data directory 的多个进程互相覆盖；缓存响应必须向 Web 标明来源。`permissionProfile/list` 和 Command Palette plugin/skill 候选不做持久缓存，由 Web 在 Composer 挂载后后台加载，并只在当前页面内按 machine/cwd 复用。

## Machine / Session / Thread

1. `MachineType = "local" | "ssh" | "registered"`。
2. machine 是路径解析、目录 listing、本地文件预览与 Range 分块读取、machine runtime 和 project path thread 启动的执行者。server 不扫描远端文件系统；`/api/machines/:machineId/directories`、`/api/machines/:machineId/files/preview`、文件流 chunk 和 project path thread bootstrap 都必须发给在线 machine，由 machine 在自身环境解析和读取路径。
3. machine capability 里 `projectLauncher` 很重要。Web 只应把可启动 project 的 machine 用于 Add Project。
4. `local` 表示 server 内嵌的 project launcher，普通 server 默认启用，Docker/测试/嵌入 surface 可用 `CODEX_HUB_LOCAL_MACHINE=0` 或 feature override 关闭。
5. `registered` 表示外部机器主动连接 `/api/machines/connect`。它注册的是 machine，不是公共 runtime；server 通过内部 `ensure_runtime` / `start_session` machine command 让它启动或复用唯一 app-server 进程并完成内部 session registration。外部机器可以是 `codexhub machine --type registered`，也可以是 `codexhub server --register-to` 或 Web Registered 面板发起的父 server 注册；后两者通过子机后端执行 CodexHub 命令并订阅事件，复用子机 local runtime；独立 `machine --type registered` 保留 app-server tunnel。后端注册不导入子机其它 machines、tasks/config 或持久 transcript。父端注册 identity 在边界映射到子端 local identity，不能合并两个 authority 的身份。取消注册、父连接失联只释放远程连接和订阅，不停止子机 runtime。父 server 上的 registered machine 是纯运行时投影，不写入 `config.yaml`，连接断开后从 machine 列表移除；子 server 自己的 `parentRegistration` 仍按配置持久化以支持重连。Web 从 `projects` realtime snapshot 检测在线 registered machine 的连接变化：新连接用 Ant Design success message 提示，断开用 warning message 提示；首次加载已有连接不补弹，断开后重连可再次提示。
6. `ssh` 表示 server 通过系统 `ssh -R` 建 reverse tunnel 后在远端启动 remote client。SSH 断开后该 connection 下的 machine/session 进入 offline；保存的 SSH host 可以按 autoconnect 策略重连，但不要把 SSH 抽象成插件运行器。
7. 后端注册仍是 `type=registered` machine，不恢复 `type=server`、Connections / Servers tab 或 `/api/server-connections`。父端远程 thread 投影仅用于展示和路由；子端负责命令执行、审批和订阅，transcript 最终来源仍是官方 app server。禁止双向同步可写控制面状态，禁止注册导出其它远端 machines 形成递归代理。
8. 父 server 注册必须防止自注册：同本机地址且同端口直接拒绝，目标 `/api/health` 返回的 `serverInstanceId` 与当前实例相同也拒绝；同一台电脑不同端口的多个 server 可以互相注册用于测试。
9. session 是一次官方 Codex app-server/headless 进程代次，只在内部 transport 使用。公共 runtime 以 `machineId` 标识，能通过 app-server 的 per-thread/per-turn `cwd` 支持多个 project。Web 中点击 project 只切换 active project path；Add Tab/thread picker 才基于 active path 创建或恢复 thread。不提供手动 restart/stop 或独立 session 管理入口。
10. thread 的 `workingDirectory` 是执行 cwd，不代表 thread 归属于一个同路径 project。它可以等于 project path、位于其子目录，或表示一个包含多个 project paths 的 workspace 上下文。surface tab 归属来自该 surface 的显式 open set/版本化 snapshot；workspace project membership 来自完整 `workspacePaths` 注册。两者都不能由 cwd/path equality 推导。
11. threadId 来自官方 Codex app-server。server/Web/TG/task 读取和展示 thread transcript，但 transcript 来源只能是 app-server turns snapshot、实时 item/rawResponseItem/tokenUsage 事件。
12. server/session 不维护 `currentThreadId` 或 `currentThread`。Web 当前 tab、Telegram chat 绑定、task `threadId` 都是各自的客户端/任务选择状态；发送入口最终必须显式知道目标 `threadId`。
13. machine/session registration 都是 strict schema。未知字段以及旧 `workerId`、`currentThreadId` 必须直接拒绝，不能静默丢弃或重新进入公共模型。

## App-server Thread Sync 和实时流

1. Web 只维护一条 `/api/events/ws`。连接后发送 `hello` 订阅 control-plane snapshots，再用 `subscribe_thread` / `unsubscribe_thread` 多路复用页面 thread tabs。
2. Control-plane 事件包括 `runtimes`、`projects`、`tasks`、`connections`、`open_threads`；thread 事件只包括 `thread`、`record`、`done`。
3. 浏览器不直接连接官方 app-server。server 通过内部 session command 发送 `subscribe_thread_records` / `unsubscribe_thread_records`，由 machine bridge 负责 app-server turns snapshot 和 live events。
4. 每个被 Web 订阅的 thread 在一个 bridge 里只能有一份 thread records subscription。server 对 thread subscription 做 ref-count，并用 `CODEX_HUB_THREAD_RECORD_SUBSCRIPTION_IDLE_MS` 做 idle grace。
5. Thread records subscription 只由 Web thread tab 订阅驱动。解绑后要保留 still-subscribed race guard，避免刚 unsubscribe 又被旧 async sync 重新写入。 首次历史同步只读取最近的官方 turns 页，Web `/history` 向上翻页才驱动后续读取；官方 cursor 留在 machine bridge 内，旧响应必须校验订阅与 snapshot 代次，不能改写新代次的分页状态。
6. runtime session 不走 idle auto-stop。machine 只维护一个 app-server/headless runtime，生命周期跟 machine/server 主进程走；project delete、subscription idle-close 和普通空闲都不能触发 `stop_session`。
7. `CODEX_HUB_THREAD_RECORD_SUBSCRIPTION_IDLE_MS=0` 只表示禁用 subscription idle-close。session heartbeat 只表示进程存活，不能当成用户活跃信号。
8. 不再保留 SSE 事件入口；实时控制面和 thread 增量统一走 `/api/events/ws`。
9. thread context usage 来自 `thread/tokenUsage/updated`；账号 rate limits 独立来自 `account/rateLimits/read` 和 `account/rateLimits/updated`，进入按 machine 投影的 `RuntimeSummary.accountRateLimits`。Web 合并两者展示，不能再从 tokenUsage payload 读取 rate-limit 字段。

## 公共 API 约定

1. 基础和认证：`GET /api/health`、`GET /api/auth/status`。设置 `CODEX_HUB_AUTH_TOKEN` 后，除 health/auth/status、registered/SSH remote-client bundle、plugin assets 和静态页面外，API 都需要 token。普通 API 使用 `Authorization: Bearer`；WebSocket、`/api/file` 图片预览、短期 `/api/file-stream/:ticketId` 媒体流和 Register URL 使用 `?codexhub_token=`。
2. Machines / runtimes：`GET /api/machines`、`GET /api/machines/:machineId/directories`、`POST /api/machines/:machineId/files/preview`、短期 `GET|HEAD|DELETE /api/file-stream/:ticketId`、`GET /api/machines/connect` WebSocket、`GET /api/runtimes`、`POST /api/machines/:machineId/runtime/ensure`。媒体 stream ticket 必须隐藏绝对路径、短期过期、支持单段 HTTP Range，并由实际 machine 校验 size/mtime 后分块读取；不能把 project/home 目录直接挂成公开 static root。
3. Registered parent：`GET /api/registered/parent`、`POST /api/registered/parent`、`DELETE /api/registered/parent`、`GET /api/registered/bootstrap`、`GET /api/remote-client/:hash`。GUI `POST` 会把规范化 URL、普通 server 的 machine identity 和可选 auth token 保存到当前 server 的 `config.yaml`，共享 `startServer()` 在普通 Web、VSCode、Electron 重启时自动恢复；VSCode authority 只使用一份共享 parent profile 和一条由 authority ID 派生的稳定 machine transport，不能按窗口覆盖 identity。token 可以为空，显式空字符串表示不使用 parent auth。`DELETE` 必须中止连接中的 WebSocket、等待 runner 完全停止并删除自动注册配置。body `url` 可以携带 `?codexhub_token=`；bootstrap 脚本通过 `/api/remote-client/:hash` 拉当前 build 的 remote client。
4. Web/Embedded surfaces：所有 Web 文档统一使用 `POST /api/web-clients/heartbeat` 维持 authority Web-client lease；embedded Web 可在同一 heartbeat 附带 `surfaceId + leaseId + protocolVersion` 刷新 workspace surface lease。`POST /api/embedded/surfaces` 和 `DELETE /api/embedded/surfaces/:surfaceId/:leaseId` 只负责 embedded workspace 投影，只在 authority service 启用，body 的 `surface` 必须是 `vscode` 或 `electron`；注册要验证当前 authority 的 local launcher 和每个 workspace path，合并所有有效 lease 的 transient projects，但不能启动 runtime/thread。旧 lease 的 heartbeat/unregister 不能删除同一 surface 的新 lease。
5. Realtime：`GET /api/events/ws` WebSocket。
6. Projects：`GET /api/projects`、`POST /api/projects/open`、`PATCH /api/projects/:projectId`、`DELETE /api/projects/:projectId`。`PATCH` 目前只更新 `pinned`。
7. Machine runtime：`GET /api/machines/:machineId/thread-candidates`、`GET /api/machines/:machineId/models`、`GET /api/machines/:machineId/permission-profiles`、`GET /api/machines/:machineId/command-palette`、`POST /api/machines/:machineId/threads`、`GET /api/machines/:machineId/apps`、`POST /api/machines/:machineId/plugins/reconcile`。Apps 与插件同步由 machine 的官方 app-server 执行，不属于 CodexHub PluginHub；同步结果不代表工具已就绪。
8. Threads：`GET /api/threads`、`GET /api/threads/:threadId`、`PATCH /api/threads/:threadId/name`、`POST /api/threads/:threadId/turn`、`POST /api/threads/:threadId/stop`、`POST /api/threads/:threadId/end`、`POST /api/threads/:threadId/compact`、`POST /api/threads/:threadId/review`、`POST /api/threads/:threadId/goal`、`DELETE /api/threads/:threadId/goal`、`POST /api/threads/:threadId/fork`、`DELETE /api/threads/:threadId`。
9. Tasks：`GET /api/tasks`、`POST /api/tasks`、`PATCH /api/tasks/:taskId`、`DELETE /api/tasks/:taskId`、`POST /api/tasks/:taskId/run`。
10. SSH：`GET /api/ssh/config-hosts`、`GET /api/ssh/hosts`、`POST /api/ssh/hosts`、`DELETE /api/ssh/hosts/:alias`、`GET /api/ssh/connections`、`POST /api/ssh/connect`、`DELETE /api/ssh/connections/:connectionId`、`GET /api/ssh/remote-client/:hash`。
11. Plugins：`GET /api/plugins`、`GET /api/plugins/:pluginId/assets/*`。
12. Web/TG/task 和外部 API 发送对话统一使用 `/api/threads/:threadId/turn`，不提供 session 级 turn 兼容入口。 可选 `?wait=true` 由后端等待本次提交执行结束，并返回 `lastSeq` 作为客户端收齐实时事件的边界；未指定时保留投递确认语义。CLI 不根据历史 `done` 或最新 turn 猜测完成。
13. project 不拥有 runtime lifecycle。`POST /api/projects/open` 是显式 project path bootstrap/persistence 入口，通常返回 `machineId` 和创建/恢复的 `threadId`；匹配当前 embedded surface 且 `persist:false` 的 workspace provider seed 只验证目录并登记 transient project，不能启动 runtime/thread。machine transport 建立后会立即启动并通过 app-server `initialize` 注册唯一 runtime，Add Thread 只负责按 explicit cwd 创建或恢复 thread；`POST /api/machines/:machineId/runtime/ensure` 保留为幂等 readiness fallback。不要新增 per-project runtime stop/restart API。runtime 不由 project delete 或 idle watcher 结束，只随 machine/server 生命周期断开或由内部 shutdown 清理。

## Server Config

1. server config 默认在 `CODEX_HUB_DATA_DIR` 下的 `config.yaml`，未设置 `CODEX_HUB_DATA_DIR` 时使用 `~/.config/codexhub/config.yaml`，数据结构版本为 `version: 1`。loader 兼容旧 `server-state.yaml` 并会迁移保存到 `config.yaml`。
2. config 可以保存 parent registration、local/SSH machine 元数据、projects、tasks、task 最近 run 摘要、SSH hosts，以及启动时填补 `process.env` 的 `env` 映射。父 server 收到的 registered machine 不持久化，旧配置中的 registered machine 元数据由 loader 清理且不影响关联 project/task。parent registration/projects/tasks/SSH hosts 属于本机配置；`updatedAt` 和最近 run 摘要属于轻量状态。parent auth token 可省略且只允许后端读取，不能通过 API、状态 message 或日志投影给 Web，保存配置时文件权限必须是 `0600`。VSCode authority 共享 parent profile，effective machineId/name 由 authority identity 覆盖，surface/window identity 不进入配置。config `env` 不能覆盖 shell / `.env` / CLI 参数，也不能用来改变当前 config 文件自己的位置。
3. config 不保存 thread summary 数量、history 数量、完整 transcript 内容、runtime 进程代次或 project `lastSessionId`。project 的 `lastThreadId` 只是最近使用过的 Codex thread 指针，不是 transcript 权威来源；当前 runtime 只能来自 `/api/runtimes`。
4. project ID 由 `machineId + path` 推导；project 名称来自 path basename，不持久化自定义 name，也不提供 rename UI/API。
5. 删除 project 只删除 project 配置，不能停止该 machine 的 runtime session。session capture 不应创建、恢复或更新 projects；只有显式添加、保存或 project path thread bootstrap 才能写入 projects。
6. state loader 会迁移旧 `threads` 和旧 project `name` 字段；不要重新引入这些旧字段。

## Project / Task 模型

1. project 是 `machineId + path` 推导出的 UI/路由元数据。project 不拥有 Codex 进程，也不在 `/api/projects` 投影里携带 `session`、`sessions` 或 thread 列表。
2. workspace 是 surface 提供的 project target 集合，一个 workspace 可以包含多个 paths/projects；它不拥有 runtime/thread。`activeWorkspacePath` 只表示当前 UI 选择，不能代表完整 workspace membership。
3. thread 创建/恢复通过 machine runtime + explicit cwd/path 表达，但 cwd 只用于执行或 resume，不建立 thread→project identity。`POST /api/machines/:machineId/threads` 使用 body `cwd`；`POST /api/projects/open` 只负责显式 project path bootstrap/persistence，machine runtime 在 transport 连接时已通过 app-server 协议建立，Add Thread 再用 machine thread API 创建或恢复 thread。
4. surface open tabs 是 surface-local 的显式 thread 引用。重启恢复只读取该 surface scope 的 exact open set；不得使用 cwd/path equality、pending IDs、thread order、candidates 或历史列表推导 tab membership。candidates 只允许为一个已经显式保存的 thread ID 补 cwd。
5. project 列表不展示 open 数、thread/history 数或任何 transcript 历史数量。在线 thread 列表属于 machine thread picker 和 workspace tabs，不属于 project 卡片持久属性。
6. project 级 UI 操作可以有 pin、delete、保存 transient project 和选择 active project；不要把 session restart/stop、rename、thread count 或 thread history 重新放回 project row。
7. task 是 server-local 调度记录，选择 machine、project path、可选 thread 和五字段 cron，然后按计划向该 thread 投递一轮对话。默认 cron timezone 是 `Asia/Shanghai`。
8. task 运行时复用 project 所属 machine 的 runtime session；若配置了 `threadId` 则按 task project path resume 该 thread，否则按 task project path 创建/复用 thread 并写回 task 状态。task 的显式 project path 是调度输入，不应由 thread workingDirectory 反推。
9. task 并发边界是 task 记录本身。同一 task 已 running/queued 时，新触发应记录为 skipped，不要叠加执行。
10. 不再扫描 `.codexp/tasks`，也不写 `.codexp/task-runs`。任务配置和最近 run 摘要都在 `config.yaml`。

## CLI 模型

1. 顶层 CLI 提供 `server`、`machine`、`register`、`start`、`send`、`ssh`、`task`、`install-vscode`。`start <input> --name <name>` 创建 thread 并发送首条消息，`send <threadId> <input>` 继续对话；全局 `--connect` 选择已有 CodexHub HTTP 后端；`--server` 是兼容别名，显式指定不同地址时拒绝执行。未指定后端地址的对话命令负责确保默认本地 server 已启动，复用同一 server 的 machine/runtime；显式地址不可达时不启动替代实例。自动 server 必须 detached、并发去重并验证端口上的服务身份，不能因 CLI 退出停止。`server` 是共享 detached authority 的前台管理客户端，通过 client heartbeat 保活；退出只结束自身管理连接。对话命令不直接启动 app-server，也不维护本地会话数据库。安装命令只负责安装 npm 包内共享的 VSIX；未知命令直接报错，不保留根级 prompt 兼容入口。
2. CLI 和 Web 复用 `/api/machines/:machineId/threads` 创建或恢复 thread，通过现有 thread name/turn API 命名和发送，并通过 `/api/events/ws` 读取权威回复。CLI 必须显式保留目标 threadId；运行中的 steer、排队和 Goal 投递由后端决定。start 默认持续监听并输出 canonical records，直到 `end` 的 transient lifecycle 信号；send 只投递提示词、运行中的引导或后续新任务并返回确认，执行回复仍由原 start 输出。start/send 不提供 `--stream`、`--wait` 或 `--no-wait`。退出客户端不停止后端执行。历史浏览仍使用 Web/API。模型目录来自该 machine 当前在线 runtime 的 app-server `model/list`，通过 `/api/machines/:machineId/models` 暴露，不在 `config.yaml` 持久化。
3. `--sandbox`、`--approval-policy` 只有用户显式传参时才作为 app-server override 转发；不要偷偷发明默认权限策略。
4. 对话 CLI 的 `--model` / `--effort` 通过共享 turn options 传递；start 从同一 `/api/events/ws` 持续输出可读文本，保留 canonical records 作为内部来源，不伪造 `codex exec` 事件。`delegate-to-codex` skill 的委派说明直接调用这一 `codexhub` 入口；不创建另一套任务/会话数据库，也不隐式改变 Web surface 的 open tabs。排查时按准确 `threadId` 查找 Codex 已有 rollout JSONL，不另开 raw 输出流。会话通过现有 thread picker 查看。
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
6. Workspace thread tabs 使用 Ant Design Tabs 的官方 editable-card 行为和 pane 高度契约；不要为 add/remove 重新写一套自定义 tabs 外观。Tab membership 由当前 surface 的显式 open set 和版本化 per-surface snapshot 决定，不由 `thread.workingDirectory === project.path` 决定。一个 VSCode surface 可以注册多个 workspace paths/projects；active path 只是选择状态。需要 project 来源时在 open/create 动作中显式携带 `ProjectTarget { machineId, path }`，缺失时保持 unresolved。
7. VSCode 和 Electron surface 使用同一套 Web UI 和完整左侧控制面。`surface=vscode` / `surface=electron` 只用于通知桥、daemon 兼容判断、workspace project group 等嵌入环境差异，不应隐藏 sidebar 或关闭 SSH/tasks/plugins/Registered 能力。
8. 任务完成通知：完成音效总是由 Web 播放；Settings 里的 `taskCompleteSystemNotifications` 只控制系统弹窗，普通 Web 走 browser Notification，VSCode 走 iframe `postMessage` 到 extension，再由 VSCode notification 展示。Electron 桌宠/完成通知的跨宿主点击必须先用显式 `WorkspaceTarget` 区分 VSCode workspace 与 Electron，再用可选 `ProjectTarget` 定位项目；不得用 `workingDirectory` 或 project path 猜 workspace。无法证明或启动目标 VSCode workspace 时安全回退 Electron thread。
9. Thread Model 弹窗的 model/reasoning/service tier 选项只使用当前在线 app-server `model/list` catalog 或 CodexHub 对该 runtime 响应的带时间戳缓存；缓存来源必须明确显示并允许强制刷新。catalog 不可用且没有缓存时显示加载/错误状态并禁用选择，不提供静态 fallback，也不能把 catalog 保存进 `config.yaml`。
10. Composer 权限菜单的 permission profile 只使用当前在线 app-server `permissionProfile/list` catalog；Web 在 Composer 挂载后后台加载，并在当前页面按 machine/cwd 复用，不做后端持久缓存。允许展示协议固定的 approval policy / reviewer 枚举，但不能为 profile 提供本地静态 fallback，也不能把 profile catalog 保存进 `config.yaml`。
11. UI 文案和交互不要重新暴露已删除概念：worker、instance、project rename、project thread/history count、per-project runtime restart/stop。
12. 产品能力默认按 browser-first 实现：普通顶层 Web、VSCode WebView 和 Electron renderer 必须复用同一套 Web 状态、effects、actions、HTTP/WebSocket 协议并直接与 authority 交互。不能因为 VSCode/Electron 有宿主容器，就把 Web 能直接完成的 heartbeat、轮询、重试、恢复状态机、业务 API 调用或缓存再实现一份到 Extension Host、Electron main 或 preload。
13. 普通 Web 没有宿主容器，因此任何新功能在设计时都必须先回答“没有 VSCode/Electron bridge 时如何通过 Web + authority 完成”。只要浏览器平台和 authority API 足以完成，canonical owner 就必须在共享 Web/authority；`surface=vscode` / `surface=electron` 只能选择不可避免的宿主适配，不能成为平行业务实现开关。
14. 只有浏览器确实无法提供的 OS/宿主能力才允许走 bridge，例如 authority 进程首次启动与失效恢复、workspace/SCM 元数据采集、原生窗口与托盘、系统通知、宿主文件打开、桌面宠物输入区域和 `asExternalUri`。bridge 必须保持薄：验证来源与 payload、调用一个宿主原语、把结果返回 Web；不得持有与 Web 重复的产品状态、timer、API workflow 或重试策略。新增 bridge 时必须在代码和测试中说明普通 Web 为何无法直接完成，并验证 bridge unavailable 时的 Web 行为。
15. 审阅 VSCode/Electron 改动时必须搜索共享 Web/authority 是否已有同义实现；优先顺序是复用 Web/authority → 扩展共享协议 → 最薄宿主 bridge。验收至少覆盖普通顶层 Web 无宿主运行，以及 VSCode/Electron 只做适配后仍使用相同核心路径；不能只用宿主 smoke 证明功能成立。

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

1. Electron main process 只包装共享 authority service 和 Web UI。窗口使用隔离/sandbox WebPreferences，外链用系统浏览器打开。
2. Electron 与 VSCode 使用同一套固定 authority 端口、authority ID、`config.yaml`、local runtime 和 parent machine transport。Electron 先 probe，若 VSCode authority 已在线就 attach；否则从 Electron bundle detached 启动 `authority-service.cjs`。端口与 CLI 统一读取 `CODEX_HUB_PORT`，`CODEX_HUB_AUTHORITY_PORT` 保留为兼容别名，二者不一致时报错，被非匹配服务占用时直接失败。
3. authority ID 保存在共享数据目录的 `authority-id`，`config.yaml` 和 `authority.log` 也属于同一 authority 数据目录。authority 默认仅监听 `127.0.0.1`；只有 `config.yaml` 的 `env.CODEX_HUB_HOST` 显式设置为 `0.0.0.0` 或 `::` 时才对外绑定。默认不启用认证，也不能自动生成 token；只有 extension host 环境或 authority `config.yaml` 的 `env.CODEX_HUB_AUTH_TOKEN` 显式非空时才启用。显式 token 只通过子进程环境注入，不能出现在命令行或日志；认证启用后 surface API、Web API/WebSocket 和 iframe/Open in Browser URL 都必须携带它。Webview iframe 和 Open in Browser 必须通过 `vscode.env.asExternalUri` 暴露 server URL，不能直接写 raw loopback URL。
4. 每个 VSCode 窗口和每个 Electron 窗口使用唯一 `surfaceId + leaseId` 调用 `/api/embedded/surfaces` 注册当前完整 workspace paths；共享 Web renderer 是唯一 heartbeat 发送者，每 10 秒 heartbeat，并在页面恢复可见时立即补发。VSCode Extension Host 和 Electron main 只负责首次注册、authority/surface 恢复和 deactivate/close 主动 unregister，不能保留平行 heartbeat timer；进程异常退出则由 30 秒 lease 清理。authority 合并所有活动 surface 的 transient projects，同一路径由多个 surface 引用时必须保留到最后一个 lease 消失；一个 workspace 可以投影多个 project targets，active path 不能替代完整集合。surface 注册只能验证目录，不能启动 app-server/thread；authority 的 machine transport 建立后会独立启动 app-server 并完成协议握手，Add Thread 才创建用户 thread。Electron 没有 workspace path 时仍可注册空 workspace surface。
5. Embedded authority 的 local machine、官方 app-server runtime、SSH/tasks/integrations/Registered 配置和 parent machine transport 在同一执行环境的 VSCode/Electron surface 间共享；UI 仍按 URL 中的 workspace paths 过滤 project catalog，localStorage 按稳定 surface scope 隔离，任务完成通知不能发到不包含该显式 project target 的窗口。Thread tab 是否属于 surface 由显式 surface open state 决定，不能由 workingDirectory 与任一 workspace path 的相等关系决定。Windows host、WSL、Remote SSH 等不同 authority 不能合并成同一个 machine。
6. authority 生命周期由共享 client heartbeat 驱动（Web 文档、活跃 CLI 和前台 server 管理连接），不看 embedded surface 数量、register/unregister 或 workspace lease：连续 5 分钟没有任何 client heartbeat 后，只有没有 running turn 才可关闭 authority；存在 running turn 时必须持续延后并在 turn 结束后重新评估，期间任一 client heartbeat 会取消待退出。embedded surface heartbeat 失败时由 Web 通知宿主恢复 workspace surface；只有 health probe 确认 authority 已不存在时才能 start replacement。VSIX build 更新只上报可用更新，不能自动关闭旧 service；authority 和前端更新必须由用户显式确认重启。
7. VSCode extension 启用和普通 Web 相同的 SSH/tasks/integrations/Registered 能力；用户显式保存 transient project 后才写入共享 `config.yaml`，窗口自动 workspace project 不应污染持久 project list。
8. VSCode 打包由 `scripts/build-vscode.ts` 负责：先完整 build，再分别将 extension 和 detached authority service 打成 Node CJS bundle、把 `navigator` 定义为 `undefined` 并断言 bundle 不引用浏览器全局；staging 必须包含 `authority-service.cjs`、`dist`、`dist-node/ssh`、media、README、LICENSE。
9. Docker 镜像运行 server/Web/API，默认应关闭内嵌 local machine，由宿主机、registered machine 或 SSH 接入真实 machine runtime。
10. `targets/vscode` 和 `targets/electron` 的长期目标是只保留 authority bootstrap/probe/recovery、surface/workspace 注册、Web 容器装载和不可替代的原生能力。发现宿主代码新增 Web 可完成的网络请求、heartbeat/polling timer、业务状态机、模型缓存、thread/project/task 操作或与 Web 相同的恢复分支时，应视为所有权回退并迁回共享 Web/authority，而不是继续在两个宿主中同步维护。

## 发布和验证

1. 本地默认端口是 `28788`（WSL 为 `28789`）；生产由 `codexhub server` 启动，PM2 进程名为 `codexhub-prod`。
2. 发布脚本必须先 `pnpm check`、`pnpm build`，再重连 PM2 管理客户端，显式通过共享 `/api/restart` 更新实际 authority 并验证身份、配置目录、build 指纹、`/api/health` 和 `/`；回滚同样验证恢复后的实际 authority。
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
6. `smoke:registered-machine` 覆盖真实 `codexhub machine --type registered` CLI、`codexhub server --register-to`、动态 parent 注册、Register URL token 提取、空 token、子 server parent registration 的配置持久化与重启恢复、父 server 不持久化 registered machine、Disconnect 清除自动连接、共享 parent profile 下 authority 级稳定 machine identity、自注册拒绝、同机不同端口注册、项目打开、session/thread 对话流，以及 SIGTERM 后 machine/session unregister lifecycle、machine 动态移除和 app-server 进程清理。runner 单元测试必须覆盖认证失败不泄露 token，以及 connecting 阶段 stop 会终止底层 socket。
7. `smoke:ssh-loopback` 覆盖真实本机 sshd、`ssh -R` reverse tunnel、SSH remote client、项目打开、session/thread 对话流和断开 lifecycle。
8. `smoke:task-lock` 覆盖 session model catalog、thread compact command、thread review command、task 并发跳过、thread records subscription、Plan/Goal options、running turn steer、goal set/clear、stop turn、idle-close、token usage 和 session account rate limits。
9. `smoke:electron` 覆盖 Electron main process、共享 authority service、Electron surface lease、authority 固定端口语义和 `/api/health`；固定端口被其他开发 authority 占用时，smoke 使用显式隔离测试端口。
10. VSCode 改动低成本验证链路是 `pnpm check`、`pnpm package:vscode`、`code --install-extension dist-vsix/codexhub.vsix --force`。
11. 公开版本由 `.github/workflows/release.yml` 统一发布，只允许与根 `package.json` 版本一致的 `v<version>` 标签触发；`main` push 不应直接发布。workflow 需要 `NPM_TOKEN` 和 `VSCE_PAT`，并按可重试方式发布根 npm 包、VS Code Marketplace 和 GitHub Release。
12. `pnpm run package:release` 只做一次完整 build，再产出 `release-artifacts/dadigua-codexhub-<version>.tgz` 和 `release-artifacts/codexhub-<version>.vsix`。根 CLI npm 包必须内含 `dist-vsix/codexhub.vsix`。
13. 当前最低支持 Codex CLI `0.144.4`。`@openai/codex` devDependency 固定为该版本，`pnpm run check:app-server-protocol` 必须用它生成包含 experimental API 的 TypeScript schema 并校验 CodexHub 依赖的当前 contract；CI 和 release 都要运行这条检查及 `smoke:core`。
14. 删除公开 API、CLI、环境变量、存储 key 或旧协议兼容层属于 breaking change；发版前必须 bump 新版本并更新 `MIGRATION.md`，不能移动或复用已经发布的 tag。
15. `publish:prod` 必须注入非空 `CODEX_HUB_BUILD_ID`，验证 health 返回相同 build，并让 PM2 直接执行仓库 `bin/codexhub`；不要把 VSCode Server 自带的版本化 Node 路径保存成 PM2 script。
