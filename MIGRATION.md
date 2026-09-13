# 配置来源与 `.env`（未发布）

CodexHub 不再自动读取或解析项目目录中的 `.env`，也不再提供 `.env.example`。请把持久化设置写入 `config.yaml` 的 `env`，或由启动进程显式传入环境变量。最终优先级为 CLI 显式参数 > `config.yaml` > 继承的进程环境变量 > 默认值；不会自动迁移或删除现有 `.env` 文件。

# CLI 活动来源（未发布）

CLI 的 turn 请求现在使用 `source: "cli"`，现有来源枚举与线程、machine activity 摘要同步扩展；没有新增第二个客户端来源字段。CLI 与 Web 都支持运行中 steer。CLI、接收后端及 registered 转发链上的后端需一起更新；旧后端不支持新来源时会拒绝请求。来源是运行时提示，不回填历史；未知来源不显示标签。

# 对话自动启动与统一委派（未发布）

`codexhub start` / `send` 未指定地址时确保默认本地 server 可用，再创建或恢复对话；server 在 CLI 退出后继续运行。`--connect`、兼容的 `--server` 或非空 `CODEX_HUB_SERVER_URL` 仍只连接指定后端，不可达时报错。

`delegate-to-codex` skill 的委派说明直接调用 CodexHub。未配置地址时自动使用本地 server；直接使用 `codexhub` 时本地新任务的 `--cwd` 可省略。续接继续使用明确 threadId；不支持的目录扩展选项仍明确拒绝。旧 direct 输出过滤/日志与独立 Codex 执行入口不再适用。

# 对话 CLI（未发布）

已移除 `start` / `send` 的 `--stream`、`--wait`、`--no-wait` 参数，以及 `start --json`。`start` 固定持续流式输出，`send` 固定只投递提示词、引导或新任务；需要机器可读的投递确认时使用 `send --json`。CLI 和后端须同步更新：默认持续监听的结束通知依赖新增的 `POST /api/threads/:threadId/end`；该接口仅在 thread 已空闲且队列为空时发出通知。

对话 CLI 增加 `--model`、`--effort` 和 stdin `-` 输入；默认 `start` 持续通过 `/api/events/ws` 输出同一 thread 的 canonical records，直到 `end` 的 transient lifecycle 信号，`send` 只返回投递确认，后续执行回复继续由原 `start` 输出。`delegate-to-codex` skill 的委派说明直接使用 `codexhub --connect <后端>` 创建该后端的 thread，并使用准确 threadId 继续任务；不指定连接时使用默认本地 server 的复用/自动启动路径。Web 通过现有 thread picker 查看同一会话，不需要迁移历史或新增父子任务模型。排查按准确 threadId 查找 Codex 已有 rollout JSONL，不另开 raw 输出流。历史工具记录解析仍可识别旧命令中的 `--stream` 参数。

新增 `codexhub start <input> --name <name>` 创建命名 thread 并发送消息，`codexhub send <threadId> <input>` 继续同一会话，`codexhub stop <threadId>` 停止当前轮并保持 start 监听，`codexhub end <threadId>` 取消队列、停止当前轮并结束原 start 监听。全局 `--connect` / `CODEX_HUB_SERVER_URL` 选择已有本机或远端 CodexHub 后端，认证使用 `CODEX_HUB_AUTH_TOKEN`。start 默认持续监听；send 只投递提示词、引导或后续新任务并返回确认。会话仍由官方 threadId 标识，不新增公共 session 模型或本地会话存储，也不会为每条命令新起 runtime。

连接参数首选 `--connect <url>`，旧 `--server <url>` 继续兼容；同时传入不同地址时明确报错。`register --to` 仍表示父注册目标。

# 后端注册迁移（未发布）

新增 `codexhub register --to <parent>`：向已有本机后端提交注册配置后退出。全局 `--connect` 指定本机后端；`--to` 指定父机。后端未启动时不会自动启动服务。`server --register-to` 保留为启动并注册的快捷入口，Web 注册面板使用相同后端路径。

后端注册现在复用子机 local runtime，父机通过 CodexHub 命令和事件访问子机，子机本地 UI 和父机操作进入同一执行管理路径。它不再为父机另起 app server。子机必须启用 local machine；父连接断开或取消注册不会停止子机 runtime。

升级父子两端后再启用后端注册，并通过原有 thread picker 显式恢复需要的历史 thread；不迁移持久 transcript，不合并父子 project/config/task 数据，也不自动接管旧运行进程。独立 `machine --type registered`、remote-client bootstrap 和 SSH 继续使用原模式。

`register` 使用 `CODEX_HUB_AUTH_TOKEN` 访问本机后端；父机认证由 `--auth-token`、`CODEX_HUB_REGISTER_AUTH_TOKEN` 或 Register URL 提供，两者不要混用。`register` 和 GUI 保存注册配置，`server --register-to` 仍保留启动时 override 语义。

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

后续 workspace identity 版本使用 `codexhub-ui-state-vscode-v4:<workspace-scope>`：保存的工作区优先以 `workspaceFile` URI/path 作为稳定身份，没有 workspace file 时才使用规范化的 folder URI/path；VS Code Stable 与 Insiders 共用同一 workspace profile。v4 不读取、复制、迁移或删除 v3 数据，因此首次进入每个 v4 workspace profile 时从空的本地 Tab 状态开始，server 配置和 app-server thread transcript 仍不受影响。

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
