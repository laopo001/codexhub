# codex-proxy 架构约定

## Codex 实例模型

1. `instanceId` 是 codex-proxy 的产品级实例主键；Web tab、Telegram attach、左下角实例列表都必须指向 `instanceId`。
2. `threadId` 是 Codex SDK 的底层会话 id，只能作为实例的内部字段或展示字段，不要作为 UI/API 主键。
3. API server 是唯一持有 Codex 运行态的进程。Web 和 Telegram 都是同一个 `InstanceHub` 的客户端，不能各自 new `CodexProxy`。
4. 空实例允许存在：`POST /api/instances` 创建实例，但不立即创建 Codex thread；第一次 `POST /api/instances/:instanceId/turn` 才创建底层 `threadId`。

## Attach 和关闭语义

1. 客户端打开实例时必须调用 `POST /api/instances/:instanceId/attach`，传入稳定 `clientId`。
2. Web 关闭 tab、Telegram 切换实例或退出当前实例时，必须调用 `POST /api/instances/:instanceId/detach`，body 传 `{ "clientId": "..." }`。
3. `DELETE /api/instances/:instanceId` 只表示管理层面的真正删除实例，不能再承担 detach 语义。
4. detach 后如果 attach 计数为 0，可以 abort 当前运行、释放 Codex thread 缓存，但实例仍保留在 `InstanceHub` 列表里。
5. 不要让单个客户端关闭动作直接无条件销毁实例；真正删除只能走纯 `DELETE /api/instances/:instanceId`。

## 事件和消息流

1. `InstanceHub` 负责把 Codex stream 转成统一的实例消息和事件。
2. Web 通过 `GET /api/instances/:instanceId/events?after=...` 订阅实例事件。
3. Telegram bot 发送消息时也订阅同一个实例事件流；TG 和 Web 应看到同一批 tool/codex/error 消息。
4. Web/TG 不各自拼 transcript；实例详情 `GET /api/instances/:instanceId` 返回后端维护的 `messages`。

## API 约定

1. 新功能使用 `/api/instances` 系列接口。
2. 不要再为新逻辑增加 `/api/turn/stream` 或 `/api/threads/:threadId/cache` 依赖。
3. 历史会话读取可以以后重新设计；当前运行态以 instance 为准。

## `.codexp` 工作区文件约定

1. 工作区内 `.codexp/instances.yaml` 是 codex-proxy 的 workspace 级 instance/可恢复会话索引，当前格式为 `version: 2`。
2. `.codexp/instances.yaml` 顶层使用 `instances` 数组；每一项必须以 `instanceId` 作为主键，底层 Codex 信息放在 `codex.threadId` 和 `codex.sessionPath`。
3. `.codexp/instances.yaml` 可以包含底层 `threadId`，但文件语义仍然是 codex-proxy instance 索引；对用户和 CLI 不要暴露成 thread 管理模型。
4. 不再兼容 `.codexp/index.yaml`，不要读取、写入或迁移这个文件。
5. 全局保存的实例 registry 在 `~/.codex-proxy/instances.yaml`；它和工作区内 `.codexp/instances.yaml` 不是同一个概念。
6. 工作区任务定义放在 `.codexp/tasks/*.yaml`。
7. 工作区任务运行日志放在 `.codexp/task-runs/*.jsonl`，每个任务一个文件，每一行是一整次运行的完整记录，便于 `tail` 查看最近几次结果。
8. `.codexp/tmp/` 只用于上传图片等临时文件，不要混放任务、实例索引或长期状态。

## 定时任务约定

1. 任务 YAML 最小结构为：

```yaml
version: 1
name: daily-summary
enabled: true
schedule: "0 9 * * *"
instance:
input: |
  检查这个项目昨天到今天的变更，给我总结风险和下一步。
```

2. 任务所在工作区由 `.codexp/tasks/*.yaml` 的位置推导，不在 YAML 里写 `folder`。
3. `instance` 可选；有值时匹配完整 `instanceId` 或唯一短前缀。
4. `instance` 为空时，如果当前工作区只有 1 个实例就使用它；没有实例就创建；多个实例时不猜测，跳过并记录 `ambiguous_instance`。
5. 任务并发边界是实例：同一个实例上的任务串行，不同实例可以并行。
6. 同一个任务已经 queued/running 时，下一次触发应跳过并记录 `already_queued_or_running`。
7. `codexp list` 应显示每个实例对应的 enabled task 数量。
8. 任务 CLI 放在 `codexp task` 子命令下，例如 `codexp task ls`、`codexp task <instance> ls`、`codexp task template [name]`；旧的 `task-template` / `task-templete` 可以保留为兼容入口。

## 自举开发和发布

1. Dev 继续使用原 4 位端口：Web `5173`，API `8788`。
2. Prod 使用 5 位 `1xxxx` 端口：主入口 `18788`，发布健康检查临时端口 `18790`。
3. Prod 由 PM2 管理长期进程：`codex-proxy-prod` 和 `codex-proxy-tg`。
4. 生产 Web 不跑 Vite；API server 在 `CODEX_PROXY_SERVE_STATIC=true` 时直接服务 `dist`。
5. Telegram bot 只连接 Prod API：`http://127.0.0.1:18788`。
6. 发布使用 `pnpm publish:prod`，脚本必须先 `pnpm check`、`pnpm build`，再用 `codex-proxy-next` 在 `18790` 验证 `/api/health` 和 `/`，通过后才重启 Prod。
7. 不要让本地 Dev 进程替换 PM2 Prod；开发验证和生产发布必须分开。
