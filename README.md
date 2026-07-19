# codexhub

一个 local-first 的 Codex 控制面。Web 按机器、项目、项目运行状态和对话组织工作区；本机 Node.js server 负责连接机器、排队命令、镜像事件和保存轻量项目元数据。机器来源分为三类：`local` 表示此电脑，`ssh` 表示本机主动通过 SSH 拉起的远端机器，`registered` 表示远端机器主动连接进来。右侧对话仍以官方 Codex `threadId` 和镜像 transcript 为核心。

CodexHub 0.5.0 要求运行 machine 上的官方 Codex CLI 不低于 `0.144.4`。从 0.4.x 升级前请先阅读 [0.5.0 迁移说明](./MIGRATION.md)。

- 共享核心：API server 统一管理 machines、machine runtime sessions 和 threads，并把轻量 project 元数据投影到 `/api/projects`；Web 左侧按项目优先展示，点击 project 只切换 active path，Add Tab/thread picker 基于该 path 创建或恢复 thread。
- HTTP API：给 Web、外部脚本或本地自动化调用。
- Web UI：React + TypeScript 的会话界面。
- Machine：server 默认内嵌一台 `local` machine；远端或宿主机也可以用 `codexhub server --register-to` 主动注册成 `registered` machine，负责路径校验和维护 machine 级 runtime session。
- SSH：本机 server 可读取 `~/.ssh/config` 的 host 列表，通过系统 `ssh` 建立 reverse tunnel，并默认下发当前 build 的 remote client 到远端运行。
- Telegram bot：由 API server 内置启动，把 Telegram 消息转成 Codex turn。

## 启动

```bash
pnpm install
cp .env.example .env
pnpm build
pnpm run dev:api
```

`codexhub server` 是 API server 的启动入口，会固定读取当前目录的 `.env`。`CODEX_HUB_HOST` / `CODEX_HUB_PORT` 可以写在 `.env` 或 `config.yaml` 的 `env` 字段里，也可以用 CLI 覆盖；优先级是 CLI 参数 > 当前 shell 环境变量 > `.env` > `config.yaml` 的 `env` > 内置默认值。

默认监听 `0.0.0.0:8788`，本机访问入口：

- Web/API: `http://127.0.0.1:8788`

普通本机启动时，server 会默认注册一台 `local` machine，Web 的 Connections / local 可以直接看到它，并通过 Projects 打开本机目录、启动 Codex session。这个内嵌 machine 的默认名称是 `local`，可用 `CODEX_HUB_LOCAL_MACHINE_ID` / `CODEX_HUB_LOCAL_MACHINE_NAME` 固定 ID 或显示名。需要关闭这个内嵌本机入口时设置：

```bash
CODEX_HUB_LOCAL_MACHINE=0 pnpm codexhub server
```

也可以直接指定监听地址：

```bash
pnpm codexhub server --host 0.0.0.0 --port 8788
```

CodexHub 启动官方 `codex app-server` 时会先解析 Codex CLI：优先使用 `CODEX_HUB_CODEX_CLI`，再查找 `PATH`、常见 npm/pnpm 全局 bin 目录；Windows 下会识别 `codex.cmd` / `codex.bat` 并通过 `cmd.exe call` 启动。app-server ready 检查默认等待 60 秒，可用 `CODEX_HUB_APP_SERVER_READY_TIMEOUT_MS` 调整；启动失败时错误会带上最近的 app-server stderr 尾部，方便定位 Codex CLI 或登录环境问题。

远端机器或容器外的宿主机可以主动注册。远端已经安装 CodexHub 时，直接让远端 server 注册到父 server：

```bash
codexhub server --register-to http://127.0.0.1:8788
```

也可以在 Web 的 Connections / Registered 里复制当前 server 的 register 命令。远端只需要能从 `PATH` 找到 `codexhub`、`node` 和官方 `codex` 命令；远端 server 会在提供自身 Web/API 的同时，额外用 machine WebSocket 连回父 server。父 server 只把它看成一台动态 `registered` machine，不同步子 server 的 projects、tasks、config 或 thread transcript 权威数据，也不把这台 machine 写入父 server 的 `config.yaml`；新 machine 在线时 Web 会显示 success message，连接断开后显示 warning message 并从父 server machine 列表消失。页面首次加载已有在线 machine 时不会补弹提示，之后重新连接则会再次提示。打开项目时，父 server 会把请求发给在线 machine；machine 进程在它所在的机器上解析路径，确认它存在且是目录，然后创建或复用 machine 级 runtime session。Registered machine 只启动远端官方 `codex app-server` 并通过同一条 machine WebSocket 反向多路复用 app-server WebSocket 帧；父 server 在本地消费官方 app-server 协议并为该目录创建或复用 thread。除内嵌 `local` machine 外，server 不扫描其他机器的文件系统。

父 server Web 左下角会显示可一键复制的 Register URL；如果当前浏览器已经保存父 server auth token，它会生成 `http://host:port?codexhub_token=...`，否则就是不带 token 的 base URL。token 完全可选，父 server 没有启用 `CODEX_HUB_AUTH_TOKEN` 时可以直接用空 token 注册测试。已经打开远端 server 的 Web UI 时，可以在 Connections / Registered 里把这个 Register URL 粘贴到唯一的 Parent register URL 输入框并 Connect。连接成功发起后，子 server 会把规范化后的父 URL、普通 server 的 machine identity 和可选 CodexHub auth token 保存在自身 `config.yaml` 的 `parentRegistration` 中；普通 Web、VSCode、Electron 下次启动都由共享 `startServer()` 自动恢复并继续断线重连。VSCode 多窗口只共享父 URL 和可选 token，每个 workspace 使用 `workspaceState` 中独立、稳定的 machineId 和 workspace 名称，避免多个窗口争用同一条 machine transport。Disconnect 会中止正在握手或已在线的 WebSocket、等待 runner 完全退出，并删除自动注册配置。CLI 和动态 API 从 `?codexhub_token=` 提取父 server auth token，也可以使用 `--register-auth-token` 或 `CODEX_HUB_REGISTER_AUTH_TOKEN`；显式空 token 表示不使用认证，CLI / 环境变量的启动时 override 仍只作用于当前进程，不覆盖已保存的 GUI 配置。连接错误和状态只显示去除 query/userinfo 的目标 URL，不记录或投影 token。

CodexHub 会拒绝把一个 server 注册到它自己：同一本机地址且同端口会直接返回错误，目标 `/api/health` 的 `serverInstanceId` 与当前实例相同也会被拒绝。为了本机测试，同一台电脑上不同端口的多个 server 可以互相注册，例如 `127.0.0.1:8789` 注册到 `127.0.0.1:8788` 是允许的。

如果远端不想预装或升级 CodexHub，`/api/registered/bootstrap` 仍保留为 one-shot bootstrap 入口，会通过 `/api/remote-client/:hash` 下载父 server 当前 build 的 remote client 后以同样的 registered tunnel 模式连回。

Project 名称来自目录 basename，不单独持久化展示名或提供重命名入口。Web project 卡片点击即打开或复用该 machine 的 runtime session，并为该 project path 创建或复用 thread；卡片不展示 open、history 或 thread 数量，也不提供手动重启/结束 session 按钮。runtime session 生命周期跟 machine/server 主进程走，project delete、watcher idle-close 和普通空闲都不会关闭它。

也可以让本机 server 主动通过 SSH 管理远端机器。SSH host 发现默认读取本机 `~/.ssh/config`，支持 `Include` 引入的配置文件；需要覆盖路径时设置 `CODEX_HUB_SSH_CONFIG=/path/to/config`。连接和认证交给系统 `ssh`、`ssh-agent`、`known_hosts`、ProxyJump 等已有配置：

```bash
pnpm codexhub ssh config-hosts
pnpm codexhub ssh add my-remote
pnpm codexhub ssh hosts
pnpm codexhub ssh connect my-remote --name my-remote
```

`codexhub ssh hosts` 只显示已添加到 CodexHub 的 SSH config alias；HostName、User、Port、ProxyJump 等连接细节仍以本机 SSH config 为准，不复制进 CodexHub state。`codexhub ssh connect` 会建立 reverse tunnel，默认让远端 `node` 通过 `http://127.0.0.1:<remotePort>/api/ssh/remote-client/<hash>` 下载本机当前 build 的 remote client，按 sha256 缓存到 `~/.cache/codexhub/remote-client/<hash>/client.cjs` 后运行。远端不需要预装或升级 CodexHub，但仍需要能从 `PATH` 找到 `node` 和官方 `codex` 命令。断开 SSH 后，这条连接下启动的远端 session 会随进程退出。

server 启动时会默认读取已添加到 CodexHub 的 SSH alias 并自动连接；添加 alias 后也会由 server 侧尝试启动连接，不依赖 Web 是否切到 SSH tab。需要临时关闭时设置：

```bash
CODEX_HUB_SSH_AUTOCONNECT=0
```

本机配置文件默认保存到：

```text
~/.config/codexhub/config.yaml
```

可以通过 `CODEX_HUB_DATA_DIR` 覆盖配置目录。这个 YAML 保存共享 UI 偏好、parent registration、projects、tasks、SSH hosts、local/SSH machine 元数据等本机控制面配置，也会包含 `updatedAt`、task 最近 run 摘要这类轻量状态字段。父 server 收到的 `registered` machine 只存在于运行时，不写入这里；旧配置中的 registered machine 历史元数据会在加载时自动清理，但它关联的 project/task 配置仍保留。包含 parent auth token 时配置文件会以 `0600` 写入；token 只由后端用于 machine WebSocket，不通过配置或 registration API 返回给 Web。它也可以保存一个 `env` 映射；server 启动时会先读取它，只把尚未存在的键填入 `process.env`，不会覆盖 shell 或 `.env`。它不保存 thread summary 或完整 transcript；thread 内容来自 session 从官方 Codex app-server 同步的 turns snapshot、item/rawResponseItem/tokenUsage 实时事件。旧版 `~/.local/share/codexhub/server-state.yaml` 或同一 `CODEX_HUB_DATA_DIR` 下的 `server-state.yaml` 会在首次启动时迁移写入新的 `config.yaml`。

`config.yaml` 里的 `env` 适合 VSCode embedded server 这类不方便配置 shell 环境变量的场景。例如：

```yaml
version: 1
config:
  ui:
    taskCompleteSystemNotifications: false
env:
  CODEX_HUB_NOTIFICATION_COMMAND: "C:\\Users\\0laop\\.codexhub\\notify.cmd"
  CODEX_HUB_NOTIFICATION_TIMEOUT_MS: "5000"
```

修改 `config.yaml` 后需要重启 server；VSCode 里执行 `Developer: Reload Window` 让 extension host 重启。`CODEX_HUB_DATA_DIR` 本身仍决定去哪读这个配置文件，因此不能靠同一个文件里的 `env.CODEX_HUB_DATA_DIR` 改变当前配置路径。

`cxh` 是 `codexhub` 的短别名。

已有 thread 的选择、恢复和新建 thread tab 由 Web 或 `/api/sessions/:sessionId/threads` 完成。CLI 只提供明确的 `server`、`machine`、`ssh`、`task` 和安装命令，不提供根级 prompt、本地历史列表或 resume 兼容命令。

server 在线时，machine runtime session 会同步官方 app-server 的 thread/turn/item/rawResponseItem/tokenUsage 事件，并接收 Web、Telegram、task 或 API 对具体 `threadId` 的远程 turn。Web 主列表以 projects/threads 为主，session 是 machine 级 runtime/debug 对象，同一个 `sessionId` 可以承载多个 project cwd 的 threads；`/api/sessions` 保留为 session/debug 镜像，不作为 Web 主列表来源。Telegram 绑定到具体 thread。Web 页面只持有一条 `/api/events/ws` 实时连接，在其中多路复用 projects/sessions/tasks/connections 和页面 thread tabs 的事件订阅。Thread context usage 由 server 从 `thread/tokenUsage/updated` 计算；session 级账号 rate limits 独立从 `account/rateLimits/read` 和 `account/rateLimits/updated` 同步到 `/api/sessions`，Web 合并两者展示。Thread Model 的 model/reasoning/service tier 下拉优先从当前在线 session 的 app-server `model/list` catalog 读取，通过 `/api/sessions/:sessionId/models` 暴露，不写入 `config.yaml`。Web Context 旁的 Compact 按钮和 `/api/threads/:threadId/compact` 会调用官方 app-server `thread/compact/start`，compact 进度继续由 app-server record 流显示。Composer menu 里的 Review changes 和 `/api/threads/:threadId/review` 会调用官方 app-server `review/start`，默认 review 当前 workspace 未提交改动并 inline 跑在当前 thread。

## 连接方式

CodexHub 只保留三种 machine 连接方式：

1. `local`：本机内嵌 launcher，直接在本机项目目录启动或复用官方 Codex app-server runtime。
2. `ssh`：本机 server 通过 `ssh -R` 把远端 machine 连接转发回来，让本机控制面调用 SSH 机器上的 Codex CLI/app-server。
3. `registered`：外部机器主动连接当前 server 的 `/api/machines/connect`，把那台机器上的官方 `codex app-server` 通过反向 WebSocket tunnel 暴露给当前控制面；父 server 侧继续复用官方 app-server 协议。

不再支持 CodexHub server-to-server state bridge；也不再提供 `type=server` machine、Connections / Servers tab、`/api/server-connections` 或 normalized thread mirror。`codexhub server --register-to` 只把当前 server 作为一台 `registered` machine 接入父 server，父 server 仍只通过 machine/app-server 协议操作它。

当前在线 machine runtime 状态以 Web 和 `/api/sessions` 为准；project 只是 `machineId + path` 元数据。历史 thread 选择以 Web 的 thread picker 和 `/api/sessions/:sessionId/threads` 为准。

project bootstrap 或 thread 创建接口会返回 `sessionId` 和 `threadId`；Web、Telegram、task 或 API 都应显式用这个 `threadId` 继续投递消息。

`codexhub` 启动官方 Codex app-server 时不注入默认权限策略；未设置时沿用 Codex CLI 自身配置。需要覆盖时，可显式通过 `--approval-policy` 或 `CODEX_HUB_APP_SERVER_APPROVAL_POLICY` 设置 `untrusted`、`on-request` 或 `never`，通过 `--sandbox` 或 `CODEX_HUB_APP_SERVER_SANDBOX` 固定 sandbox。`codexhub server`、`codexhub machine` 和 SSH / registered machine 只会把这些显式 override 通过 `-c approval_policy="..."` / `-c sandbox_mode="..."` 传给官方 `codex app-server`。

Telegram bot 是内建 integration plugin。`.env` 里配置 token 后直接运行 `pnpm run dev:api` 即可：

```bash
TELEGRAM_BOT_TOKEN=xxx
pnpm run dev:api
```

没有 `TELEGRAM_BOT_TOKEN` 时 server 会跳过 Telegram bot 并继续启动，`/api/plugins` 会显示 `codexhub.telegram` 未配置。需要临时关闭这个内建插件时设置 `CODEX_HUB_PLUGIN_TELEGRAM=0`。项目不再提供 `--telegram` / `--no-telegram` / `--env` 或 `CODEX_HUB_TELEGRAM_ENABLED` 这类分支开关。`pnpm bot` 仅保留为手动调试独立 bot 的入口，不要和 server 内建 Telegram plugin 同时运行。

本地定时任务由本机 server 记录和调度，不写入远端 workspace。任务选择一台 machine、一个 project path、可选 thread，并按 cron schedule 向该 thread 投递一轮对话；第一次没有 `threadId` 时会使用打开 project 后返回的新/复用 thread，并写回 task 状态。

```bash
curl -sS -X POST http://127.0.0.1:8788/api/tasks \
  -H 'content-type: application/json' \
  -d '{
    "name": "daily-summary",
    "enabled": true,
    "schedule": "0 9 * * *",
    "machineId": "machine-example",
    "projectPath": "/path/to/project",
    "input": "检查这个项目昨天到今天的变更，给我总结风险和下一步。"
  }'

curl -sS http://127.0.0.1:8788/api/tasks
curl -sS -X POST http://127.0.0.1:8788/api/tasks/<taskId>/run
```

CLI 也操作同一份 server-local task 状态：

```bash
pnpm codexhub task create \
  --name daily-summary \
  --schedule "0 9 * * *" \
  --machine machine-example \
  --project /path/to/project \
  --input "检查这个项目昨天到今天的变更，给我总结风险和下一步。"

pnpm codexhub task list
pnpm codexhub task run daily-summary
```

server 每 30 秒扫描一次本地 task 状态，间隔可用 `CODEX_HUB_TASK_SCAN_INTERVAL_MS` 调整。task 的 `schedule` 会在保存时校验为五字段 cron 表达式；无效表达式会被 API 拒绝，而不是静默保存后永远不触发。task 不再写入 `.codexp/tasks`，也不由远端 workspace 持有。

任务完成时 Web 会播放完成音效；Settings 里的 Task complete popups 控制是否额外发系统通知。普通 Web 使用 browser Notification，VSCode surface 通过 iframe `postMessage` 转成 VSCode notification；Theia Electron surface 则在 Electron main process 创建原生系统通知，点击后恢复并聚焦通知来源窗口，再打开对应 `threadId`。这个开关默认开启并保存在本地 UI state。

需要自定义通知集成时，可以在 server 进程上设置 hook 环境变量。hook 在 app-server turn 完成并归一成非历史 `task_complete` record 时触发，不依赖浏览器 tab 是否打开：

```bash
CODEX_HUB_NOTIFICATION_COMMAND="/home/laop/bin/codexhub-notify --channel codexhub"
CODEX_HUB_NOTIFICATION_TIMEOUT_MS=5000
```

`CODEX_HUB_NOTIFICATION_COMMAND` 会启动本机命令，并把 JSON payload 写入 stdin；失败只记录日志，不影响 Codex turn/task 完成。VSCode 插件的 embedded server 也读这些环境变量；需要从带有这些 env 的 shell 启动 VSCode，已用这些 env 启动的窗口改配置后执行 `Developer: Reload Window` 让 extension host 重启。

如果不想在 Windows/VSCode 里配置系统环境变量，也可以把同样的键写进对应窗口数据目录下的 `config.yaml` 的 `env` 字段。

Codex turn 默认不设等待超时，适合长任务和定时任务持续运行。需要在特定部署里限制单次 turn 时，可以设置 `CODEX_HUB_TURN_TIMEOUT_MS` 为正整数毫秒；不设置或设为 `0` 表示不启用 turn 超时。

session 的断线判定和 recently disconnected 保留时间可以用 `CODEX_HUB_SESSION_OFFLINE_TIMEOUT_MS`、`CODEX_HUB_SESSION_OFFLINE_RETENTION_MS`、`CODEX_HUB_SESSION_SWEEP_INTERVAL_MS` 调整。runtime session 不做空闲回收；它跟 machine/server 主进程一起保持在线。thread records subscription 的 idle grace 可用 `CODEX_HUB_THREAD_RECORD_SUBSCRIPTION_IDLE_MS` 调整，设为 `0` 表示禁用 subscription idle-close。

## 插件

当前插件系统分两层：外部插件只做本机静态 contribution 注入，server 扫描插件 manifest，Web 根据 `/api/plugins` 返回的 contribution 加载样式；内建插件可以提供受控 integration，例如 `codexhub.telegram`。它不执行外部插件 JS，也不把 SSH、Telegram、theme 全部抽成一个大生命周期框架。

默认插件目录：

```text
~/.local/share/codexhub/plugins
./plugins
```

也可以用 `CODEX_HUB_PLUGIN_DIR` 或 `CODEX_HUB_PLUGIN_DIRS` 覆盖；多个目录用系统 path delimiter 分隔。一个最小主题插件：

```yaml
# ~/.local/share/codexhub/plugins/my-theme/plugin.yaml
version: 1
id: my-theme
name: My Theme
enabled: true
contributes:
  web:
    styles:
      - style.css
```

外部插件也可以声明 integration 作为 UI/管理元数据，但当前只有 `runner: builtin` 的内建 integration 会被 server 启动：

```yaml
version: 1
id: my-integration-notes
name: My Integration Notes
enabled: true
contributes:
  integrations:
    - type: my-channel
      label: My Channel
      requiredEnv:
        - MY_CHANNEL_TOKEN
```

```css
/* ~/.local/share/codexhub/plugins/my-theme/style.css */
:root {
  --codexhub-accent: #2f6fed;
}
```

可用 API：

```bash
curl -sS http://127.0.0.1:8788/api/plugins
```

SSH 继续保留为 machine transport 类型；Telegram 是内建 integration plugin；主题/CSS 是 Web contribution plugin。三者共享插件清单和 contribution 视图，但不强行共享同一套运行时生命周期。

## 验证

```bash
pnpm run check:app-server-protocol
pnpm check
pnpm run smoke:core
pnpm run smoke:ssh-loopback
pnpm run smoke:electron
pnpm build
```

`smoke:auth` 覆盖普通 API 仅接受 Bearer token、WebSocket 和文件预览仅在指定路径接受 `?codexhub_token=`，以及 registered bootstrap 传递 Bearer token。

`smoke:machine-session` 会启动一个临时 server、内嵌 `local` machine 和官方 Codex app-server，验证 project path thread bootstrap、跨 project 共享 machine runtime、`/api/projects` 不暴露 runtime session/thread 列表、`/api/sessions`、session account rate limits、thread detail 不暴露 `workerId` 或 current thread，验证 SSH config `Include`、SSH reverse tunnel 命令构造、插件 CSS 资产、`/status` 对话流、pending shell command 展示、server-local task 创建/运行/校验，并确认 machine/session registration 会拒绝未知旧字段。`smoke:task-lock` 额外覆盖 `/api/sessions/:sessionId/models` 的 session command 通道和 model/reasoning/service tier catalog 响应。

`smoke:registered-machine` 会分别启动真实 `codexhub machine --type registered` 和 `codexhub server --register-to` CLI 子进程，并覆盖动态 `/api/registered/parent` 注册、Register URL `?codexhub_token=` 提取、空 token、子 server parent registration 的 `config.yaml` 持久化与 `0600` 权限、父 server 不持久化 registered machine、server 重启自动恢复、Disconnect 清除自动连接、共享父配置下的 VSCode workspace 独立 machine identity、自注册拒绝、同机不同端口注册、project path thread bootstrap、machine runtime 启动、`/status` 对话流，以及正常 SIGTERM 后 machine/session unregister 生命周期和 app-server 进程清理。单元测试还覆盖 token 错误脱敏和连接握手期间的强制中止。

`smoke:ssh-loopback` 会启动一个临时本机 `sshd`，通过真实 `ssh -R` reverse tunnel 连接回临时 server，验证 SSH machine 注册、project path thread bootstrap、machine runtime 启动、`/status` 对话流，以及 SSH connection 删除后 machine/session 进入 offline。

`smoke:task-lock` 会用假的 registered machine/session 走真实 websocket 协议，验证同一个 task 在已有 queued/running turn 时第二次运行会 `skipped`，且 turn 完成后可以再次运行；同时覆盖 thread records subscription、thread compact command、thread review command、Plan/Goal options、running turn steer、goal set/clear、stop turn、idle-close、token usage 和 session account rate limits。

`smoke:electron` 会以 headless Electron 启动桌面入口的内嵌 server，验证它会使用随机空闲端口，并检查 `/api/health` 可用；它不创建真实桌面窗口。

## 生产发布

生产环境由 PM2 管理；API server 同时服务 Web `dist`，监听地址由 `.env` 或 CLI 参数决定。

```bash
cp .env.example .env
pnpm run publish:prod
```

长期进程：

- `codexhub-prod`: 端口跟随 `.env` 里的 `CODEX_HUB_PORT`
- Telegram bot 内置在 `codexhub-prod`，由同一个 server 进程启动

发布脚本会先备份当前生产产物，再运行 `pnpm check` 和 `pnpm build`，用 `v<version>+<git-sha>[.dirty]` 注入非空 `CODEX_HUB_BUILD_ID`，然后通过 PM2 的仓库 `bin/codexhub` 入口启动或重启 `codexhub-prod`，最后检查 `/api/health`、build ID 和 `/`。任一步失败会恢复先前的 `dist`、`dist-node` 和 PM2 进程快照。

`main` push 的 CI 全部通过后，`Deploy Production` workflow 会进入 GitHub `production` environment，通过专用 SSH key 把 `scripts/deploy-prod-commit.sh` 发送到生产服务器。服务器只检出这次 push 的精确 commit；如果已有更新的 `main`，旧部署会直接跳过。随后服务器安装 lockfile 依赖并调用同一个 `publish:prod`。自动部署需要在 `production` environment 配置 `PROD_HOST`、`PROD_PORT`、`PROD_USER`、`PROD_PATH`、`PROD_SSH_KEY` 和固定主机指纹 `PROD_KNOWN_HOSTS`；不要保存 SSH 密码。

常用命令：

```bash
pm2 list
pm2 logs codexhub-prod
pm2 restart codexhub-prod
```

## Docker

容器镜像用于运行本机 Node.js server、Web 和 API。Codex app-server/headless 进程仍由连接进来的 machine/session 提供；也就是说，宿主机或远端机器继续用 `codexhub server --register-to`、SSH 或 `codexhub` headless session 把项目接到这个 server。

```bash
docker build -t codexhub .

docker run --rm \
  -p 8788:8788 \
  -v codexhub-data:/data \
  -v "$HOME/.local/share/codexhub/plugins:/plugins:ro" \
  codexhub
```

容器默认环境：

- `CODEX_HUB_HOST=0.0.0.0`
- `CODEX_HUB_PORT=8788`
- `CODEX_HUB_DATA_DIR=/data`
- `CODEX_HUB_PLUGIN_DIR=/plugins`
- `CODEX_HUB_LOCAL_MACHINE=0`

Docker 默认不启动内嵌 `local` machine，因为容器内看到的是容器文件系统。若确实要让容器内 server 管理挂载进来的项目目录，可以显式设置 `CODEX_HUB_LOCAL_MACHINE=1` 并挂载对应路径。

如果要让容器里的 server 读取本机 SSH 配置并主动连接远端 machine，可以额外挂载 SSH 配置：

```bash
docker run --rm \
  -p 8788:8788 \
  -v codexhub-data:/data \
  -v "$HOME/.ssh:/root/.ssh:ro" \
  codexhub
```

宿主机作为 registered machine 连接容器里的 server：

```bash
codexhub server --register-to http://127.0.0.1:8788 --port 8789
```

## Electron

Electron 壳用于把同一个本机 Node.js server 和 Web UI 包成桌面窗口。它启动一个内嵌 server，默认使用随机空闲端口，然后打开该地址；Codex app-server/headless 进程仍然由本机/SSH/registered machine session 提供。

VSCode extension 每个窗口默认启动自己的随机端口嵌入 server；显式设置 `CODEX_HUB_PORT` 时才固定端口，端口被占用会直接失败。VSCode iframe 使用和普通 Web 相同的左侧控制面与 SSH/tasks/plugins/Registered 能力，`surface=vscode` 只保留通知桥和嵌入兼容用途。extension 会先从 `/api/machines` 找到在线的 `local` project launcher，再把当前窗口的 file workspace folders 通过 `/api/projects/open` 以 `persist:false` bootstrap 成 VSCode workspace project group；这个窗口内嵌的 local machine 和这些项目都只存在于该窗口 server 的内存中，不写入 `config.yaml`。用户在 UI 中显式保存 transient project 后，它才会进入普通 CodexHub project list。

命令面板里的 `Codex Hub: Open Config File` 会打开当前 VSCode 窗口 embedded server 使用的 `config.yaml`；文件不存在时会先创建一个最小配置。

VSCode Webview 和 Open in Browser 都通过 `vscode.env.asExternalUri` 使用 VSCode 提供的外部 URI，而不是直接把 loopback URL 写进 iframe；这让远程 VSCode、端口转发或 tunnel 环境也能访问内嵌 server。工作区项目打开会对 transient local launcher race 做最多 30 次、每次 500ms 的重试；如果当前窗口没有 file workspace folder，会显示状态页而不是启动项目。

```bash
pnpm electron:start
```

这个脚本使用 npm 安装的 Electron binary，并在 Linux 开发环境下传 `--no-sandbox` 规避本地 `chrome-sandbox` setuid 权限问题。正式分发时可以在后续引入 electron-builder / forge，把同一个 `dist-node/electron/main.js` 作为 main process 入口。

可选环境变量：

- `CODEX_HUB_PORT`: Electron 内嵌 server 端口；显式设置后端口被占用会直接报错，未设置时使用随机空闲端口
- `CODEX_HUB_HOST`: Electron 内嵌 server host，默认 `127.0.0.1`
- `CODEX_HUB_ELECTRON_DEVTOOLS=1`: 启动后打开 DevTools

在 Electron 里连接宿主机 project launcher 的方式和 Web 相同；也可以从 Connections / Registered 复制包含当前实际端口的命令。

发布后的 CodexHub CLI 自带共享 VSIX，可以直接安装到 VS Code：

```bash
codexhub install-vscode
```

命令会先调用当前环境的 `code --install-extension ... --force` 并核对 `dadigua.codexhub@<version>`；在 WSL 中还会把 VSIX 复制到 Windows 本地路径，再额外调用 Windows `code.cmd` 安装和验收宿主版本。安装完成后 Reload Window。自定义包可以使用 `codexhub install-vscode --vsix /path/to/codexhub.vsix`。

源码仓库里的 VS Code extension 打包和安装链路仍为：

```bash
pnpm run package:vscode
pnpm run install:vscode
```

`build:vscode` 会先跑完整 `pnpm build`，再把 extension 打成 Node CJS bundle，显式把 extension host 里的 `navigator` 定义为 `undefined` 并断言 bundle 不引用浏览器全局；共享 VSIX staging 位于 `dist-vsix/`，会包含 Web `dist`、`dist-node/ssh` remote client、media、README 和 LICENSE，供 VS Code 与官方 Theia IDE 共用。

## Eclipse Theia

官方 Theia IDE 可以直接安装 CodexHub 的 VSIX，不需要 Theia 源码、不需要修改 `app.asar`，也不需要重编 Theia。Windows Theia Electron 通过 Remote WSL 打开工作区时，CodexHub extension/server 仍运行在 WSL extension host；系统通知由 Windows Theia webview 创建。

通知点击后会先激活发出通知的 Theia 窗口和 Codex Hub view，再把 `threadId` 发送给内嵌 Web UI，跳转到对应 thread。如果当前 Theia 不提供 Web Notification API 或权限没有授予，会自动退回 IDE 自带的 `showInformationMessage`。

发布后的 CodexHub CLI 会自带同版本的 Theia-compatible VSIX。在目标 extension host 的终端执行：

```bash
codexhub install-theia
```

命令会把插件原子部署到 `~/.theia-ide/deployedPlugins/dadigua.codexhub@<version>`；同版本重装也会安全替换，部署校验失败时保留旧版本。Theia 连接的是 SSH/WSL 远程工作区时，应在该远程工作区的终端执行，命令会自然安装到远端 extension host。完成后断开并重新连接 Theia 工作区。

非默认配置目录或源码 checkout 中的自定义 VSIX 可以显式指定：

```bash
codexhub install-theia --config-dir ~/.theia-ide
codexhub install-theia --vsix /path/to/codexhub.vsix
```

在源码仓库里直接运行 CLI 前，先用 `pnpm run package:vscode` 生成 `dist-vsix/codexhub.vsix`。

仓库开发环境仍保留 Windows frontend + 当前 WSL backend 的双端安装器：

```bash
pnpm run install:theia
```

Theia IDE 与 VSCode 可以使用同一份 `dist-vsix/codexhub.vsix`。Theia 1.73.x 后端支持 `--install-plugin`，并把 `--install-extension` 作为别名，但没有 VSCode `--force` 那样的同版本替换参数。`install:theia` 会构建这份共享 VSIX，把完整结构原子部署到 Windows frontend 和当前 WSL remote backend；复制或校验失败时旧 deployment 不会被删除。安装器最后会分别让 Windows 与 WSL 的 Theia 后端执行插件列表检查，只有两边都实际列出对应的 `dadigua.codexhub@<version>` 才算成功。命令结束后重新连接 WSL 窗口即可激活新版本。

也可以覆盖 user config 位置：

```bash
CODEX_HUB_THEIA_WSL_CONFIG_DIR=/path/to/.theia-ide pnpm run install:theia
CODEX_HUB_THEIA_WINDOWS_CONFIG_DIR='C:\path\to\.theia-ide' pnpm run install:theia
CODEX_HUB_THEIA_IDE_DIR='C:\path\to\TheiaIDE' pnpm run install:theia
CODEX_HUB_THEIA_WSL_RUNTIME_DIR=/path/to/theia-remote-runtime pnpm run install:theia
```

Theia 官方的交互式安装入口仍然可用：在命令面板运行 `Extensions: Install from VSIX...`，选择命令生成的 `D:\Downloads\codexhub-theia.vsix`。自动安装器不会把“VSIX 已复制”误当成安装完成，也不会在新部署就绪前删除现有 CodexHub。

仓库仍保留 `@dadigua/codexhub-theia` 编译期 target，供需要深度定制 Theia 产品本身的场景使用：

```bash
pnpm run package:theia
pnpm run smoke:theia
```

该高级产物位于 `dist-theia/`，接入方式见 `targets/theia/README.md`；普通 Theia IDE 用户不需要它。它与 `dist-vsix/codexhub.vsix` 是两种不同实现：VSIX 运行在兼容 VS Code Extension API 的 IDE extension host，`@dadigua/codexhub-theia` 则是编译进自定义 Theia 产品的原生 frontend/backend contribution。

## 发布新版本

仓库使用 `.github/workflows/release.yml` 统一发布，不再在每次 `main` push 时分别发布 npm 和 Marketplace。发布 workflow 只接受与根 `package.json` 版本严格一致的 `v<version>` 标签，一次构建并验证以下三个产物：

- `release-artifacts/dadigua-codexhub-<version>.tgz`：CLI npm 包，内含同版本共享 VSIX
- `release-artifacts/codexhub-<version>.vsix`：发布到 VS Code Marketplace，也可安装到官方 Theia IDE
- `release-artifacts/dadigua-codexhub-theia-<version>.tgz`：供自定义 Theia 产品编译期接入的原生 npm 包

本地预检可以运行：

```bash
pnpm run check:app-server-protocol
pnpm run smoke:core
pnpm run package:release
pnpm run smoke:vscode-install
pnpm run smoke:theia
pnpm run smoke:theia-host
pnpm run smoke:theia-install
pnpm run smoke:notification-hooks
```

验证通过后提交版本修改，再推送 `main` 和对应标签：

```bash
VERSION=$(node -p "require('./package.json').version")
git push origin main
git tag -a "v${VERSION}" -m "CodexHub ${VERSION}"
git push origin "v${VERSION}"
```

标签会依次发布 `@dadigua/codexhub`、`@dadigua/codexhub-theia`、VS Code Marketplace，并创建包含三个文件的 GitHub Release。npm 发布前会检查精确版本是否已存在，Marketplace 使用 `--skip-duplicate`，GitHub Release 采用 create-or-upload，因此失败后可以在 Actions 中选择同一标签手动重跑；不得移动或复用已经指向其他提交的版本标签。仓库需要配置 `NPM_TOKEN` 和 `VSCE_PAT`。

## API

当前公开 API 分成三层：project 是 `machineId + path` 元数据，`sessionId` 标识在线 machine runtime，`threadId` 是 turn 投递、transcript、事件订阅和多 thread 操作的主键。机器和 project path thread bootstrap 入口负责把路径请求路由到在线 machine，再启动或复用 machine runtime：

设置 `CODEX_HUB_AUTH_TOKEN` 后，普通 API 使用 `Authorization: Bearer <token>`。`?codexhub_token=` 只用于 `/api/events/ws`、`/api/machines/connect` 和无法添加 Authorization header 的 `/api/file` 图片预览，不会授权其他 API 路径。

```bash
curl -sS http://127.0.0.1:8788/api/machines
curl -sS http://127.0.0.1:8788/api/projects

curl -sS -X POST http://127.0.0.1:8788/api/projects/open \
  -H 'content-type: application/json' \
  -d '{"machineId":"machine-example","path":"/path/to/project"}'
```

`/api/projects/open` 是 project path thread bootstrap 入口：它返回 machine runtime 的 `sessionId` 和创建/恢复的 `threadId`，但 project 本身不拥有 runtime lifecycle。CodexHub 不提供 per-project runtime stop/restart API；runtime 不由 watcher idle 或 project delete 结束，只随 machine/server 生命周期断开或由内部 shutdown 清理。

Telegram、脚本和 Web 都直接针对明确的 `threadId` 投递：

```bash
THREAD_ID=$(curl -sS http://127.0.0.1:8788/api/threads | jq -r '.threads[0].threadId')

curl -sS -X POST "http://127.0.0.1:8788/api/threads/$THREAD_ID/turn" \
  -H 'content-type: application/json' \
  -d '{"input":"继续这个 thread","source":"telegram"}'
```

Web 这类多 thread UI 可以直接针对选中的 thread 投递，或让在线 session start/resume 一个 thread tab。Web 前端使用单条 `/api/events/ws` WebSocket 实时流，连接后发送 `hello` 订阅控制面事件，再用 `subscribe_thread` / `unsubscribe_thread` 在同一条连接里维护页面 thread tabs：

```bash
SESSION_ID=$(curl -sS http://127.0.0.1:8788/api/sessions | jq -r '.sessions[0].sessionId')
THREAD_ID=$(curl -sS http://127.0.0.1:8788/api/threads | jq -r '.threads[0].threadId')

curl -sS -X POST "http://127.0.0.1:8788/api/threads/$THREAD_ID/turn" \
  -H 'content-type: application/json' \
  -d '{"input":"看一下这个项目结构","source":"web"}'

# /api/events/ws messages:
# {"type":"hello","sessionsAfter":0,"projectsAfter":0,"tasksAfter":0,"connectionsAfter":0}
# {"type":"subscribe_thread","threadId":"<threadId>","after":0}

curl -sS -X POST "http://127.0.0.1:8788/api/sessions/$SESSION_ID/threads" \
  -H 'content-type: application/json' \
  -d '{"action":"resume","threadId":"019e..."}'

curl -sS -X POST "http://127.0.0.1:8788/api/sessions/$SESSION_ID/threads" \
  -H 'content-type: application/json' \
  -d '{"action":"new"}'

curl -sS "http://127.0.0.1:8788/api/sessions/$SESSION_ID/models"
```

`/api/sessions/:sessionId/models` 由在线 machine/session bridge 调用官方 app-server `model/list`，返回当前账号/配置可见的 model、supported reasoning efforts 和 service tiers；Web Thread Model 弹窗只使用这份在线 catalog。catalog 尚未就绪或读取失败时会禁用选择并显示加载/错误状态，不使用本地静态 model fallback。

`POST /api/threads/:threadId/compact` 由在线 machine/session bridge 调用官方 app-server `thread/compact/start`。它只触发 app-server 对该 thread 的上下文压缩，不改写 CodexHub server 本地 records；Web 通过 app-server `contextCompaction` item 归一化出的 `context_compaction` record 显示进度和结果。

`POST /api/threads/:threadId/review` 由在线 machine/session bridge 调用官方 app-server `review/start`。当前 Web 入口是 composer `+` 菜单里的 Review changes，target 固定为 `uncommittedChanges`，delivery 为 `inline`，review turn 仍按普通 app-server record 流展示。

`options` 可随 turn 传递 Web 运行选择：`model`、`modelReasoningEffort`、`serviceTier`、`collaborationMode:"plan"`、`goalMode:true`、`goalObjective` 和 `goalTokenBudget`。`serviceTier` 应使用 `/api/sessions/:sessionId/models` 返回的 catalog value；当前 app-server 的 Fast tier 通常是 `priority`。传 `null` 表示清除显式 tier，回到 Codex 配置默认值。Plan mode 只会把本轮输入标记为只规划不实施，不覆盖 app-server sandbox；权限仍由当前 Codex 配置或显式 `--sandbox` 决定。Goal mode 会先通过 app-server `thread/goal/set` 为该 thread 建立 active goal，再启动 turn；如果 Web 在 running thread 上用 Goal mode 发送，则只更新 active goal，不对当前 turn 做 `turn/steer`。

Slash command 会在转发给 Codex 前先处理。`/status` 和 `/help` 返回本地代理状态/帮助记录；`/fast on`、`/fast off`、`/fast status` 会设置或查看当前 thread 的 app-server service tier；Web 里的 `/model` 是客户端命令，会打开 Session 选择器，下一次普通 turn 再把选中的 model/reasoning/service tier 发给 app-server。`codexhub` 会从 `thread/settings/updated` 或有效的 `config/read` 结果镜像 model/reasoning/service tier。不支持的 slash command 不会作为普通 user turn 发给 Codex app-server。

Server 不读取运行机器上的 `~/.codex` session、远端 `.codexp/tasks` 或上传临时图片目录。历史 session 通过 Web/API 或 app-server 恢复后镜像到 server；图片输入使用 app-server 原生 `{ type: "image", url }`；thread context usage 由 server 从 app-server tokenUsage 事件镜像计算，session account rate limits 作为独立账号窗口与它合并展示；新定时任务由本机 `config.yaml` 里的 task 配置调度。
