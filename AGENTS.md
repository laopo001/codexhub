# codex-proxy 架构约定

## Thread 模型

1. `threadId` 是 codex-proxy 的产品级运行主键；Web tab、Telegram attach、任务目标和左侧列表都必须指向 `threadId`。
2. 不再引入 `instanceId`。旧的 instance 概念已经被删除，新逻辑不得增加 `/api/instances`、`.codexp/instances.yaml` 或 instance 兼容层。
3. API server 是控制面和事件镜像层，不直接拥有 Codex runtime。Codex runtime 在 `codexp connect` 启动的官方 `codex app-server` worker 里。
4. `workerId` 标识一条 `codexp connect` 连接；worker 负责执行 `turn`、`stop`、`fork_thread` 命令。
5. `threadId` 来自官方 app-server。新 thread 只能由本地 Codex CLI/TUI 或官方 session 恢复产生，server/Web/TG/task 不主动创建 thread。
6. Web/TG/task 发送输入时，server 只把命令排到对应 worker，执行结果再按 `threadId` 镜像回 thread 记录。
7. worker 退出时必须 unregister；server 也必须通过 heartbeat timeout 把异常退出的 worker 标记为 offline。

## Attach 和关闭语义

1. 客户端打开 thread 时调用 `POST /api/threads/:threadId/attach`，传入稳定 `clientId`。
2. Web 关闭 tab、Telegram 切换 thread 或退出当前 thread 时，调用 `POST /api/threads/:threadId/detach`，body 传 `{ "clientId": "..." }`。
3. `DELETE /api/threads/:threadId` 表示管理层面的删除 thread 记录。
4. detach 只减少 attach 计数，不销毁官方 Codex session；真正删除只能走 `DELETE /api/threads/:threadId`。

## 事件和消息流

1. `ThreadHub` 负责把 app-server events/read snapshots 转成统一 thread records 和 SSE events。
2. Web 通过 `GET /api/threads/:threadId/events?after=...` 订阅 thread 事件。
3. Telegram bot 发送消息时也订阅同一个 thread 事件流；TG 和 Web 应看到同一批 tool/codex/error 消息。
4. Web/TG 不各自拼 transcript；thread 详情 `GET /api/threads/:threadId` 返回后端维护的 `records`。
5. TUI 里创建或恢复的新 thread，由 `codexp connect` 从 app-server event 中发现并注册到 server。
6. Web/TG/API 输入里的 slash command 不当普通 Codex turn 透传。官方 Codex TUI 的 slash command 是 TUI 本地命令；codex-proxy 只在 server 本地处理明确支持的 `/status`、`/help`、`/model`，其他命令形态返回不支持说明。
7. Web 里的 `/model` 是 Web 客户端命令：打开 Runtime 选择器，不转发给官方 TUI。Web 正常 turn 必须把当前 Runtime 的 model / reasoning 作为 app-server `turn/start` override 发送；官方 TUI 本地 `/model` 可能只更新 app-server effective config，因此 `codexp connect` 必须通过 `config/read` 轮询同步 Runtime 设置，并兼容 `thread/settings/updated`。

## API 约定

1. 新功能使用 `/api/threads` 和 `/api/workers` 系列接口。
2. 不再新增 `/api/instances`、`/api/turn/stream` 或 `/api/threads/:threadId/cache` 依赖。
3. worker 通信使用 `/api/workers/*`：register/heartbeat/commands/events/unregister。worker 主动出站连接 server，不要求 server 反连 worker 机器。
4. 不提供 `POST /api/threads` 创建入口；server 只能 attach、detach、delete、restore existing Codex session、turn、stop、fork。

## `.codexp` 工作区文件约定

1. 工作区 Codex session 索引写入 `.codexp/threads.yaml`，顶层使用 `threads` 数组，每项以 `threadId` 作为主键。
2. 不读取、不写入、不迁移 `.codexp/instances.yaml` 或 `.codexp/index.yaml`。
3. 工作区任务定义放在 `.codexp/tasks/*.yaml`。
4. 工作区任务运行日志放在 `.codexp/task-runs/*.jsonl`，每个任务一个文件，每一行是一整次运行的完整记录，便于 `tail` 查看最近几次结果；日志时间使用当前系统时区的 ISO offset 格式，例如 `2026-05-26T22:00:28+08:00`。
5. `.codexp/tmp/` 只用于上传图片等临时文件，不要混放任务、thread 索引或长期状态。

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
2. `thread` 可选；有值时匹配完整 `threadId` 或唯一短前缀。
3. `thread` 为空时，如果当前工作区只有 1 个 thread 就使用它；没有 thread 时跳过并记录 `thread_not_found`；多个 thread 时不猜测，跳过并记录 `ambiguous_thread`。
4. 任务并发边界是 thread：同一个 thread 上的任务串行，不同 thread 可以并行。
5. 同一个任务已经 queued/running 时，下一次触发应跳过并记录 `already_queued_or_running`。
6. `codexp list` 应显示每个 thread 对应的 enabled task 数量。
7. 任务 CLI 放在 `codexp task` 子命令下，例如 `codexp task ls`、`codexp task <thread> ls`、`codexp task template [name]`。

## 自举开发和发布

1. Dev 继续使用原 4 位端口：Web `5173`，API `8788`。
2. Prod 使用 5 位 `1xxxx` 端口：主入口 `18788`，发布健康检查临时端口 `18790`。
3. Prod 由 PM2 管理长期进程：`codex-proxy-prod` 和 `codex-proxy-tg`。
4. 生产 Web 不跑 Vite；API server 在 `CODEX_PROXY_SERVE_STATIC=true` 时直接服务 `dist`。
5. Telegram bot 只连接 Prod API：`http://127.0.0.1:18788`。
6. 发布使用 `pnpm publish:prod`，脚本必须先 `pnpm check`、`pnpm build`，再用 `codex-proxy-next` 在 `18790` 验证 `/api/health` 和 `/`，通过后才重启 Prod。
7. 不要让本地 Dev 进程替换 PM2 Prod；开发验证和生产发布必须分开。
