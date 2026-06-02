# codex-proxy 架构约定

## Worker / Thread 模型

1. `workerId` 是 Web 主界面的在线运行入口；左侧列表展示当前在线的 `codexp` / `codexp resume` workers，worker 下的 `currentThreadId` 才是右侧正在镜像的 Codex thread。
2. 不再引入 `instanceId`。旧的 instance 概念已经被删除，新逻辑不得增加 `/api/instances`、`.codexp/instances.yaml` 或 instance 兼容层。
3. API server 是控制面和事件镜像层，不直接拥有 Codex runtime。Codex runtime 在 `codexp` / `codexp resume` 启动的官方 `codex app-server` worker 里。
4. 一次 `codexp` 或 `codexp resume` 等价于打开一个官方 Codex：一个 PTY TUI、一个 app-server、一个 worker。`workerId` 标识这次 `codexp` 进程，必须每次启动唯一；`workingDirectory` 只是 worker 属性，不是 worker 主键。
5. `codexp` / `codexp resume` 必须 local-first：官方 `codex app-server` 和 TUI 不依赖 server 连接成功；server 离线时本地 TUI 继续可用，后台 bridge 持续重试，server 恢复后再 register worker 并同步事件。
6. `threadId` 来自官方 app-server。新 thread 只能由本地 Codex CLI/TUI 或官方 session 恢复产生，server/Web/TG/task 不主动创建 thread。
7. 输入语义按客户端形态分层：Telegram 是单聊天窗口模型，输入使用 `/api/workers/:workerId/turn`，由 server 在提交时解析 worker 的 `currentThreadId`；Web 是多窗口/多 thread UI，输入可以使用选中 thread 的 `/api/threads/:threadId/turn`，但 server 必须校验该 thread 能路由到绑定在线 worker 或同目录唯一在线 worker；官方 app-server bridge 最终始终调用 `turn/start { threadId }`。执行结果再按 `threadId` 镜像回 thread 记录。
8. 同一个 `workingDirectory` 可以同时运行多个 `codexp` / `codexp resume`，即多个官方 Codex/app-server worker。thread 优先发给自己绑定的在线 worker；未绑定 thread 只有在同目录唯一在线 worker 时才自动路由，多 worker 时不能猜。
9. 非 headless 的 `codexp` / `codexp resume` 必须用 PTY wrapper 启动官方 `codex --remote ...` 或 `codex resume --remote ...` TUI，由 `codexp` 作为父进程负责 stdin/stdout/resize 转发、底部状态栏和子进程生命周期，不再使用 `stdio: inherit`。
10. worker 正常退出时必须 unregister；server 也必须通过 heartbeat timeout 把异常退出的 worker 标记为 offline。Heartbeat 是异常兜底，不是正常退出主路径。
11. `codexp list` 必须和 Web 左侧一致：读取 `/api/workers` 并只显示在线 worker。
12. `codexp threads` 必须扫描本机官方 Codex session 历史并按当前工作目录过滤；它不是 server mirror cache，也不读取 `/api/threads`。输出应包含完整 `threadId`、标题和更新时间，作为 `codexp resume <threadId>` 的辅助列表。`--show <count>` 控制最近显示数量，默认 20；实现应优先扫描最近 session 文件并在收集足够当前目录 thread 后停止。

## 选择和关闭语义

1. active 概念必须分层：`worker.currentThreadId` 只表示官方 Codex CLI/app-server 的 runtime current thread；Web 的 `activeTabThreadId` / `activeTabThreadByWorker` 只表示右侧 Tabs 当前查看的 thread。Web tab 点击不能被理解成修改 worker runtime current，worker runtime current 只能由 app-server/TUI/bridge 同步。
2. Web 选择 worker 只是客户端本地选择；server 不维护客户端打开计数。Web 右侧默认显示该 worker 当前的 `currentThreadId`，也允许在 worker 下切换查看/输入其他可路由 thread；TUI 里 `/resume` 切换 thread 后由 app-server event 同步到 Web，但不应强制覆盖用户已经选中的 Web tab，除非当前 tab 已不可用或尚未选择。
3. 客户端读取 thread 详情使用 `GET /api/threads/:threadId`，事件订阅使用 `GET /api/threads/:threadId/events?after=...`。
4. Web 关闭 tab 或 Telegram 切换 thread 只关闭本地 UI/session，不向 server 发送关闭通知。
5. `DELETE /api/threads/:threadId` 表示管理层面的删除 thread 记录；不要把客户端关闭动作映射成删除。
6. Web 左侧只显示在线 worker；worker 正常 unregister 或 heartbeat timeout 后不再出现在主列表。离线 worker 只允许作为诊断数据查看。
7. Telegram 只暴露 `/workers` 作为在线入口并只保存 `workerId`；attach worker 后通过 `/api/workers/events` 持续跟随该 worker 的 `currentThreadId`，并订阅对应 thread SSE 镜像消息。TG 发送消息和状态查询前从 `/api/workers` 重新确认该 worker 仍在线，并使用 worker 的 `currentThreadId` 作为底层 thread。TG 不提供 `/threads` 选择或 `/stop` 控制入口。
8. thread 是否可运行由绑定 worker 或同目录唯一可用 worker 决定；多个同目录 worker 同时在线时，不要在未绑定 thread 上自动选择。

## 事件和消息流

1. `ThreadHub` 负责把 app-server events/read snapshots 转成统一 thread records 和 SSE events。
2. Web 通过 `GET /api/threads/:threadId/events?after=...` 订阅 thread 事件。
3. Telegram bot 由 API server 进程按环境变量内置启动，发送消息时也订阅同一个 thread 事件流；TG 和 Web 应看到同一批 tool/codex/error 消息。
4. Web/TG 不各自拼 transcript；thread 详情 `GET /api/threads/:threadId` 返回后端维护的 `records`。
5. TUI 里创建或恢复的新 thread，由 `codexp` / `codexp resume` 从 app-server event 中发现并注册到 server。
6. `codexp` / `codexp resume` 的主动 app-server events 可以更新 worker 的 `currentThreadId`；周期性 `thread/read` 快照同步不能更新 `currentThreadId`，否则 Web 会在历史 thread 间跳动。
7. Web/TG/API 输入里的 slash command 不当普通 Codex turn 透传。官方 Codex TUI 的 slash command 是 TUI 本地命令；codex-proxy 只在 server 本地处理明确支持的 `/status`、`/help`、`/model`，其他命令形态返回不支持说明。
8. Web 里的 `/model` 是 Web 客户端命令：打开 Runtime 选择器，不转发给官方 TUI。Web 正常 turn 必须把当前 Runtime 的 model / reasoning 作为 app-server `turn/start` override 发送；官方 TUI 本地 `/model` 可能只更新 app-server effective config，因此 `codexp` / `codexp resume` 必须通过 `config/read` 轮询同步 Runtime 设置，并兼容 `thread/settings/updated`。

## API 约定

1. 在线入口优先使用 `/api/workers` snapshot；worker summary 应携带该 worker 下的轻量 thread summaries，Web/TG 不把全局 `GET /api/threads` 当在线入口。
2. 不再新增 `/api/instances`、`/api/turn/stream` 或 `/api/threads/:threadId/cache` 依赖。
3. worker 通信使用 `/api/workers/*`：register/heartbeat/commands/events/unregister。worker 主动出站连接 server，不要求 server 反连 worker 机器。
4. Web 初始化/重连可以读取 `GET /api/workers`，后续 worker 列表、current thread、thread summaries 的实时更新使用 `GET /api/workers/events?after=...` SSE，不做固定间隔轮询。
5. Web 的 context/rate limit usage 使用 worker heartbeat 进入 worker/thread summaries 的 `codexUsage`，通过 `/api/workers/events` 或 thread SSE 更新；不使用 `GET /api/codex-usage?threadId=...` 固定轮询。
6. `/api/workers/:workerId/turn` 是 worker-current-thread 输入入口，主要给 Telegram 这类单上下文客户端使用；它不创建 thread，只在提交时解析 worker 的 `currentThreadId` 并排入 worker 命令队列。
7. `/api/threads/:threadId` 系列用于 thread 详情、SSE 事件、turn/stop/fork/delete 等 thread 操作；Web 可以用 `/api/threads/:threadId/turn` 对选中 thread 输入。`GET /api/threads` 只允许作为诊断/管理兼容列表，不用于 Web 高频轮询。
8. Web 的消息级 Fork 必须只显示在带 app-server turn id 的 final answer 上。官方 app-server 的 `thread/fork` 不支持 `messageId` / `itemId` 定位；按消息 fork 的实现语义是先对源 thread 调 `thread/fork`，再按目标消息所在 turn 之后的 turn 数，对新 thread 调 `thread/rollback { numTurns }`。不要把 Web 传入的 `messageId` 直接当成官方 `thread/fork` 参数。
9. 不提供 `POST /api/threads` 创建入口；server 只能 get/delete、turn、stop、fork，以及诊断性 list。恢复历史 Codex session 必须走官方 TUI/app-server，由 `codexp resume` 或 TUI 内 `/resume` 发现并镜像。
10. server 不读取本机 `~/.codex`、不扫描本机 `.codexp/tasks`、不提供本机文件浏览 API；这些本地职责必须放在 `codexp` worker/CLI 侧。

## `.codexp` 工作区文件约定

1. 工作区 Codex session 索引写入 `.codexp/threads.yaml`，顶层使用 `threads` 数组，每项以 `threadId` 作为主键。
2. 不读取、不写入、不迁移 `.codexp/instances.yaml` 或 `.codexp/index.yaml`。
3. 工作区任务定义放在 `.codexp/tasks/*.yaml`，由 `codexp` CLI/worker 读取，server 不扫描。
4. 工作区任务运行日志放在 `.codexp/task-runs/*.jsonl`，由 `codexp` CLI/worker 写入；每个任务一个文件，每一行是一整次运行的完整记录，便于 `tail` 查看最近几次结果；日志时间使用当前系统时区的 ISO offset 格式，例如 `2026-05-26T22:00:28+08:00`。
5. server 不再把输入图片写入 `.codexp/tmp/`。Web/TG/task 图片输入必须使用 app-server 原生 `{ type: "image", url }` 语义；需要本地临时文件时只能由 `codexp` worker 自己承担。

## 定时任务约定

任务 YAML 最小结构为：

```yaml
version: 1
name: daily-summary
enabled: true
schedule: "0 9 * * *"
thread:
input: |
  检查这个项目昨天到今天的变更，给我总结风险和下一步。
```

1. 任务所在工作区由 `.codexp/tasks/*.yaml` 的位置推导，不在 YAML 里写 `folder`。
2. `thread` 可选；有值时作为官方 Codex session/thread id 传给 `codex exec -C <workspace> resume <thread> -`，没有值时使用 `codex exec -C <workspace> -` 新开非交互 session。不要用 server 线程列表解析 `task run/start` 的目标。
3. 旧 `instance` 字段只允许作为 `thread` 的过渡别名读取，不要重新引入 instance 模型。
4. 任务执行必须 local-first：`codexp task run <task_yaml_path>` 和 `codexp task start` 通过本机 `codex exec` / `codex exec resume` 执行，不依赖 codex-proxy server。
5. 任务并发边界是 task 文件：同一个任务已经 queued/running 时，下一次触发应跳过并记录 `already_queued_or_running`。
6. 任务 CLI 放在 `codexp task` 子命令下，例如 `codexp task list [thread]`、`codexp task template [name]`、`codexp task start`、`codexp task run <task_yaml_path>`。
7. `codexp task list` 默认离线可用，只扫描当前工作区的 `.codexp/tasks`；只有显式传 `--server` 或设置 `CODEX_PROXY_SERVER_URL` 时，才连接 server 并显示 server 是否在线。
9. `codexp task start` 是本地任务调度入口：只扫描当前工作区的 `.codexp/tasks`，按 YAML 里的 `schedule` 在本机执行，不要求 server 能访问本机文件系统。
10. `codexp task run <task_yaml_path>` 是手动单次执行入口：立即本地运行指定 YAML 文件，不看 `schedule`，不要求 server 在线。

## 自举开发和发布

1. 本地默认主入口使用 `8788`，同一个 API server 同时服务 Web `dist` 和 `/api/*`。
2. Prod 使用 5 位 `1xxxx` 端口：主入口 `18788`。
3. API server 统一通过 `codexp server` 启动，只加载当前目录 `.env`；不再提供 `--env`、`--telegram`、`--no-telegram` 或 `CODEX_PROXY_TELEGRAM_ENABLED` 分支开关。
4. `CODEX_PROXY_HOST` / `CODEX_PROXY_PORT` 可以写入 `.env`；CLI `--host` / `--port` 优先级最高，其次是当前 shell 环境变量，然后是 `.env`。
5. Telegram bot 默认随 server 启动；没有 `TELEGRAM_BOT_TOKEN` 时 server 应失败，而不是静默跳过。
6. Prod 由 PM2 管理长期进程：`codex-proxy-prod`。Telegram bot 内置在该 server 进程中。
7. API server 默认直接服务 `dist`；`--serve-static <dir>` 只作为显式目录覆盖，不再用 `CODEX_PROXY_SERVE_STATIC` 区分 dev/prod。
8. 发布使用 `pnpm run publish:prod`，脚本必须先 `pnpm check`、`pnpm build`，再启动或重启 `codex-proxy-prod` 并验证 `/api/health` 和 `/`。
9. 不要让本地 Dev 进程替换 PM2 Prod；开发验证和生产发布必须分开。
