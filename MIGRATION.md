# CodexHub 0.5.0 迁移说明

CodexHub 0.5.0 删除了旧 CLI、HTTP、UI state 和 Codex app-server shape 的兼容入口。切换生产流量前，应先升级同一控制面里的 server、local、registered 和 SSH machines。

## 升级前

1. 把所有运行 machine 上的官方 Codex CLI 升级到 `0.144.4` 或更高版本，并用 `codex --version` 核对。
2. 脚本和 integration 统一向 `POST /api/threads/:threadId/turn` 发送 turn；session 级 turn 入口已经删除。
3. 把 Rewind 或 `POST /api/threads/:threadId/rollback` 改为 `POST /api/threads/:threadId/fork`。Fork 会创建新 thread，不会原地改写源 thread。
4. 把 `CODEX_CLI_PATH` 改为 `CODEX_HUB_CODEX_CLI`，Register URL 的 `?token=` 改为 `?codexhub_token=`。
5. 删除 `CODEX_HUB_SSH_REMOTE_MODE=installed`。SSH machine 只使用当前 server build 下发的 bootstrap remote client。
6. 把 approval policy `on-failure` 改为当前值：`untrusted`、`on-request` 或 `never`。

## 协议和本地状态变化

- 不再发送或公开 `multiAgentMode`；Ultra 只由 reasoning effort 表达。
- Model 选项只来自在线 app-server `model/list` catalog。catalog 不可用时会禁用 Thread Model 弹窗，不使用静态列表。
- Goal record 只接受当前 camelCase `ThreadGoal` shape；旧 snake_case alias 会被拒绝。
- Machine/session registration 继续使用 strict schema，旧 `workerId`、`workerMode` 和 `currentThreadId` 会被拒绝。
- Web 不再读取 `codexhub-ui-state-v4`。首次打开 0.5.0 可能重置本地 workspace tabs 或 UI 偏好；project、task 和 thread transcript 数据源不受影响。
- 根级 `codexhub [prompt]` transient session 入口已删除。请运行 `codexhub server` 或 `codexhub machine`，再通过 Web/API 创建或恢复 thread。

## 验证升级

在仓库 checkout 中运行：

```bash
pnpm install --frozen-lockfile
pnpm run check:app-server-protocol
pnpm check
pnpm run smoke:core
pnpm run package:release
```

生产 checkout 使用 `pnpm run publish:prod` 部署。health 响应必须包含部署命令打印的非空 `build` 值。
