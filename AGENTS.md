# codex-proxy 架构约定

## Codex 实例模型

1. `instanceId` 是 codex-proxy 的产品级实例主键；Web tab、Telegram attach、左下角实例列表都必须指向 `instanceId`。
2. `threadId` 是 Codex SDK 的底层会话 id，只能作为实例的内部字段或展示字段，不要作为 UI/API 主键。
3. API server 是唯一持有 Codex 运行态的进程。Web 和 Telegram 都是同一个 `InstanceHub` 的客户端，不能各自 new `CodexProxy`。
4. 空实例允许存在：`POST /api/instances` 创建实例，但不立即创建 Codex thread；第一次 `POST /api/instances/:instanceId/turn` 才创建底层 `threadId`。

## Attach 和关闭语义

1. 客户端打开实例时必须调用 `POST /api/instances/:instanceId/attach`，传入稳定 `clientId`。
2. Web 关闭 tab 时调用 `DELETE /api/instances/:instanceId?clientId=...`。
3. Telegram 切换 folder、attach 其它实例或退出当前实例时，也用同一个 DELETE 语义 detach 当前 `clientId`。
4. 后端只有在实例 attach 计数为 0 时才真正 abort 当前运行、释放 Codex thread 缓存并删除实例。
5. 不要让单个客户端关闭动作直接无条件销毁实例；必须尊重 attach count。

## 事件和消息流

1. `InstanceHub` 负责把 Codex stream 转成统一的实例消息和事件。
2. Web 通过 `GET /api/instances/:instanceId/events?after=...` 订阅实例事件。
3. Telegram bot 发送消息时也订阅同一个实例事件流；TG 和 Web 应看到同一批 tool/codex/error 消息。
4. Web/TG 不各自拼 transcript；实例详情 `GET /api/instances/:instanceId` 返回后端维护的 `messages`。

## API 约定

1. 新功能使用 `/api/instances` 系列接口。
2. 不要再为新逻辑增加 `/api/turn/stream` 或 `/api/threads/:threadId/cache` 依赖。
3. 历史会话读取可以以后重新设计；当前运行态以 instance 为准。

## 自举开发和发布

1. Dev 继续使用原 4 位端口：Web `5173`，API `8788`。
2. Prod 使用 5 位 `1xxxx` 端口：主入口 `18788`，发布健康检查临时端口 `18790`。
3. Prod 由 PM2 管理长期进程：`codex-proxy-prod` 和 `codex-proxy-tg`。
4. 生产 Web 不跑 Vite；API server 在 `CODEX_PROXY_SERVE_STATIC=true` 时直接服务 `dist`。
5. Telegram bot 只连接 Prod API：`http://127.0.0.1:18788`。
6. 发布使用 `pnpm publish:prod`，脚本必须先 `pnpm check`、`pnpm build`，再用 `codex-proxy-next` 在 `18790` 验证 `/api/health` 和 `/`，通过后才重启 Prod。
7. 不要让本地 Dev 进程替换 PM2 Prod；开发验证和生产发布必须分开。
