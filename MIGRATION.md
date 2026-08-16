# CodexHub 0.8.0 迁移说明

CodexHub 0.8.0 在 0.7.0 的共享 authority 基础上，增加了 VSCode/Electron 对本机 Node.js 和本机 npm/link CodexHub 包的优先解析。这样更新 Node.js 或通过源码构建、`pnpm link --global` 更新 CodexHub 后，embedded authority 可以直接使用本地版本，不必等待 VSIX 或 Electron 内置 bundle 更新。

## 从 0.7.0 升级

1. 在 CodexHub 仓库中构建最新本地包：

   ```bash
   pnpm install
   pnpm build
   pnpm link --global
   ```

2. VSCode 和 Electron 启动 authority 时会自动读取当前用户登录 shell 的 `PATH`，并优先查找其中的 `codexhub`/`cxh` 本地包，最后才回退到内置 bundle。一般不需要把 checkout 的绝对路径写进配置；确认用户 PATH 已生效即可：

   ```bash
   command -v codexhub || command -v cxh
   ```

3. authority 的 Node.js 运行时会优先解析用户 PATH 中满足最低版本要求的 Node.js，再回退到 VSCode/Electron 宿主运行时。只有需要覆盖用户 PATH 时，才显式指定：

   ```bash
   export CODEX_HUB_AUTHORITY_NODE=/path/to/node
   ```

4. 在 `/api/health` 中检查 `authorityRuntime.nodeSource` 和 `authorityServiceSource`：`path` 表示使用用户 PATH 中的 Node，`configured-package` 表示使用显式本地包，`linked-package` 表示从用户 PATH 中的 npm/link 命令发现本地包，`bundled` 表示回退到 VSCode/Electron 内置 bundle。

5. 安装新 VSIX 或更新 Electron 后，已打开的 VSCode 窗口执行 `Developer: Reload Window`；Electron 退出后重新启动。authority 会在现有 surface 全部来自新 build 后完成接管。

## 0.8.0 验证

```bash
pnpm check
pnpm build
pnpm run package:vscode
```

确认 VSIX 的 manifest 版本为 `0.8.0`，并用 `/api/health` 确认实际运行的 Node.js 和 authority service 来源。

---

## CodexHub 0.7.0 历史迁移说明

CodexHub 0.7.0 把 VSCode 从“每个窗口一个 embedded server/runtime”迁移为“每个执行 authority 一个 detached service，窗口通过 lease 注册”。当前 embedded authority 协议继续把 Electron 纳入同一套 surface 注册模型：VSCode 和 Electron 可以 attach 到同一个 authority、共享 local runtime 与 parent machine transport。普通 `codexhub server`、SSH 与 registered machine 的公共 runtime 模型不变。

## 从 0.6.0 升级

1. 安装 0.7.0 VSIX 后，对所有已打开的 VSCode 窗口执行 `Developer: Reload Window`。旧版每窗口 embedded server 会随旧 extension host 退出；新版窗口会连接或启动 authority service。
2. Windows、macOS 和普通 Linux authority 固定监听 `127.0.0.1:28788`；WSL 固定监听 `127.0.0.1:28789`，从而在 mirrored networking 下避开 Windows 的 `28788`。端口不再按 workspace 生成，也不会在占用时顺延；非匹配进程占用固定端口会直接报错。
3. Windows host、每个 WSL distro、每个 Remote SSH host/user 和容器仍是独立 authority。它们各自运行 service、解析自己的路径并启动自己的 Codex runtime；不要把 Windows 与 WSL 合并成同一个 machine。
4. 同一 authority 的所有 VSCode/Electron surface 现在共享 `CODEX_HUB_DATA_DIR` 下的 `config.yaml`（默认 `~/.config/codexhub`）、local machine/runtime、SSH/tasks/integrations 和唯一 parent registration machine transport。authority 只监听 loopback，默认不生成或要求 access token；只有 extension host 环境或该 authority `config.yaml` 的 `env.CODEX_HUB_AUTH_TOKEN` 显式非空时才启用认证。早期构建生成的 `vscode-authority-token` / `authority-token` 文件不再读取，并会在 authority 下次启动时删除。父 server 会看到每个 authority 一台 machine，不再看到每个 workspace 一台 machine。
5. 窗口自动 workspace 仍是 transient project。关闭或失联窗口后，surface lease 会被清理；同一路径仍被其他 surface 注册时不会被移除。最后一个 VSCode/Electron surface 离开后 authority 等待 30 秒退出。surface 注册协议从 VSCode 专用 endpoint 统一为 `/api/embedded/surfaces`，协议版本递增后旧 authority 必须退出或等待 lease idle，再由新客户端启动。

## VSCode UI 状态

VSCode Web 不再读取共享的 `codexhub-ui-state-vscode-v2`，改为 `codexhub-ui-state-vscode-v3:<workspace-scope>`，避免共享 authority origin 后不同窗口互相覆盖 tabs、active project 和草稿。升级后各 workspace 的本地 UI 状态会重置一次；`config.yaml`、project/task 配置和 app-server thread transcript 不受影响。

## 验证 0.7.0

```bash
pnpm run check:app-server-protocol
pnpm check
pnpm run package:vscode
```

安装 VSIX 并 reload 两个属于同一 authority 的 VSCode 窗口，再启动 Electron 后，`/api/health` 应在桌面 host 的 `28788` 或 WSL 的 `28789` 返回相同 `authority.authorityId`；未显式设置 `CODEX_HUB_AUTH_TOKEN` 时还应返回 `authRequired: false`，且 `/api/projects` 无 token 可直接访问。`/api/projects` 应同时包含 VSCode/Electron surface 的 transient workspace，而 `/api/runtimes` 在 Add Thread 前仍为空。

## 0.6.0 历史迁移说明

CodexHub 0.6.0 把 runtime 的公共身份从短生命周期 `sessionId` 收敛到稳定 `machineId`，并强制一台 machine 同时最多只有一个在线 Codex app-server runtime。切换生产流量前，应同时升级同一控制面里的 server、local、registered 和 SSH machines。

### 升级前

1. 把所有运行 machine 上的官方 Codex CLI 升级到 `0.144.4` 或更高版本，并用 `codex --version` 核对。
2. 停止依赖 `/api/sessions` 或公共 `sessionId` 的脚本/integration，按下表切换到 machine-scoped API。
3. 在滚动升级场景中先停止旧 machine client，再升级 server 和全部 machine client；0.6.0 的内部 machine command/schema 与旧版本不保证混跑。

### 公共 API 变化

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

### 运行时和 Web 状态变化

- 同一 machine 注册新的内部 app-server session 时，旧 session 会被替换，已有 thread 自动重新绑定到该 machine 的新 runtime。
- Web 的 active tab、tab order、model catalog、permission profile 和 command palette cache 都按 `machineId` 保存，不再依赖 runtime 进程代次。
- Add Thread 会先立即打开准备中的选择框；冷 runtime 通过 machine runtime ensure 启动，期间控件禁用，完成后再加载 thread candidates。这个流程不会调用 `/api/projects/open`。
- Web 不再读取 `codexhub-ui-state-v5` 或 `codexhub-ui-state-vscode-v1`。首次打开 0.6.0 会重置本地 workspace tabs 或 UI 偏好；project、task 和 thread transcript 数据源不受影响。
- 旧 task run 中的 `sessionId` 在读取配置时被丢弃，并按 task 所属 `machineId` 补齐稳定 machine identity。

### 验证升级

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
