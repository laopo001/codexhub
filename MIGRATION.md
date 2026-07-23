# CodexHub 0.6.0 迁移说明

CodexHub 0.6.0 把 runtime 的公共身份从短生命周期 `sessionId` 收敛到稳定 `machineId`，并强制一台 machine 同时最多只有一个在线 Codex app-server runtime。切换生产流量前，应同时升级同一控制面里的 server、local、registered 和 SSH machines。

## 升级前

1. 把所有运行 machine 上的官方 Codex CLI 升级到 `0.144.4` 或更高版本，并用 `codex --version` 核对。
2. 停止依赖 `/api/sessions` 或公共 `sessionId` 的脚本/integration，按下表切换到 machine-scoped API。
3. 在滚动升级场景中先停止旧 machine client，再升级 server 和全部 machine client；0.6.0 的内部 machine command/schema 与旧版本不保证混跑。

## 公共 API 变化

| 0.5.x | 0.6.0 |
| --- | --- |
| `GET /api/sessions` | `GET /api/runtimes` |
| `GET /api/sessions/:sessionId/thread-candidates` | `GET /api/machines/:machineId/thread-candidates` |
| `GET /api/sessions/:sessionId/models` | `GET /api/machines/:machineId/models` |
| `GET /api/sessions/:sessionId/permission-profiles` | `GET /api/machines/:machineId/permission-profiles` |
| `GET /api/sessions/:sessionId/command-palette` | `GET /api/machines/:machineId/command-palette` |
| `POST /api/sessions/:sessionId/threads` | `POST /api/machines/:machineId/threads` |

- 新增 `POST /api/machines/:machineId/runtime/ensure`。它只确保 machine runtime 在线，不创建 thread、不打开或写入 project。
- `POST /api/projects/open` 仍用于显式 project path bootstrap/persistence，但响应中的 `result.sessionId` 改为 `result.machineId`。
- task run 响应和 task run history 不再包含 `sessionId`，改为 `machineId`。
- thread 的 `session` 投影改为 `runtime`，其中只包含 machine identity/status，不包含内部 session ID 或 app-server URL。
- `/api/events/ws` 的 control-plane event 从 `sessions` 改为 `runtimes`，`hello.sessionsAfter` 改为 `hello.runtimesAfter`。
- `/api/sessions` 和所有 session-scoped HTTP route 已删除，不提供兼容 alias。

## 运行时和 Web 状态变化

- 同一 machine 注册新的内部 app-server session 时，旧 session 会被替换，已有 thread 自动重新绑定到该 machine 的新 runtime。
- Web 的 active tab、tab order、model catalog、permission profile 和 command palette cache 都按 `machineId` 保存，不再依赖 runtime 进程代次。
- Add Thread 会先立即打开准备中的选择框；冷 runtime 通过 machine runtime ensure 启动，期间控件禁用，完成后再加载 thread candidates。这个流程不会调用 `/api/projects/open`。
- Web 不再读取 `codexhub-ui-state-v5`、`codexhub-ui-state-vscode-v1` 或 `codexhub-ui-state-theia-v1`。首次打开 0.6.0 会重置本地 workspace tabs 或 UI 偏好；project、task 和 thread transcript 数据源不受影响。
- 旧 task run 中的 `sessionId` 在读取配置时被丢弃，并按 task 所属 `machineId` 补齐稳定 machine identity。

## 验证升级

在仓库 checkout 中运行：

```bash
pnpm install --frozen-lockfile
pnpm run check:app-server-protocol
pnpm check
pnpm run smoke:core
pnpm run smoke:ssh-loopback
pnpm build
```

生产 checkout 使用 `pnpm run publish:prod` 部署。health 响应必须包含部署命令打印的非空 `build` 值。
