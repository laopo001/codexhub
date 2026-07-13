# codexhub

一个 local-first 的 Codex 控制面。Web 按机器、项目、项目运行状态和对话组织工作区；本机 Node.js server 负责连接机器、排队命令、镜像事件和保存轻量项目元数据。机器来源分为三类：`local` 表示此电脑，`ssh` 表示本机主动通过 SSH 拉起的远端机器，`registered` 表示远端机器主动连接进来。右侧对话仍以官方 Codex `threadId` 和镜像 transcript 为核心。

- 共享核心：API server 统一管理 machines、machine runtime sessions 和 threads，并把轻量 project 元数据投影到 `/api/projects`；Web 左侧按项目优先展示，点击 project 只切换 active path，Add Tab/thread picker 基于该 path 创建或恢复 thread。
- HTTP API：给 Web、外部脚本或本地自动化调用。
- Web UI：React + TypeScript 的会话界面。
- Machine：server 默认内嵌一台 `local` machine；远端或宿主机也可以用 `codexhub server --register-to` 主动注册成 `registered` machine，负责路径校验和维护 machine 级 runtime session。
- SSH：本机 server 可读取 `~/.ssh/config` 的 host 列表，通过系统 `ssh` 建立 reverse tunnel，并默认下发当前 build 的 remote client 到远端运行。
- Local session CLI：`codexhub [prompt]` 仅作为 legacy/transient headless 入口保留；project path thread 主路径是 server + machine。
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

CodexHub 启动官方 `codex app-server` 时会先解析 Codex CLI：优先使用 `CODEX_HUB_CODEX_CLI`，其次兼容 `CODEX_CLI_PATH`，再查找 `PATH`、常见 npm/pnpm 全局 bin 目录；Windows 下会识别 `codex.cmd` / `codex.bat` 并通过 `cmd.exe call` 启动。app-server ready 检查默认等待 60 秒，可用 `CODEX_HUB_APP_SERVER_READY_TIMEOUT_MS` 调整；启动失败时错误会带上最近的 app-server stderr 尾部，方便定位 Codex CLI 或登录环境问题。

远端机器或容器外的宿主机可以主动注册。远端已经安装 CodexHub 时，直接让远端 server 注册到父 server：

```bash
codexhub server --register-to http://127.0.0.1:8788
```

也可以在 Web 的 Connections / Registered 里复制当前 server 的 register 命令。远端只需要能从 `PATH` 找到 `codexhub`、`node` 和官方 `codex` 命令；远端 server 会在提供自身 Web/API 的同时，额外用 machine WebSocket 连回父 server。父 server 只把它看成一台 `registered` machine，不同步子 server 的 projects、tasks、config 或 thread transcript 权威数据。打开项目时，父 server 会把请求发给在线 machine；machine 进程在它所在的机器上解析路径，确认它存在且是目录，然后创建或复用 machine 级 runtime session。Registered machine 只启动远端官方 `codex app-server` 并通过同一条 machine WebSocket 反向多路复用 app-server WebSocket 帧；父 server 在本地消费官方 app-server 协议并为该目录创建或复用 thread。除内嵌 `local` machine 外，server 不扫描其他机器的文件系统。

父 server Web 左下角会显示可一键复制的 Register URL；如果当前浏览器已经保存父 server auth token，它会生成 `http://host:port?token=...`，否则就是不带 token 的 base URL。已经打开远端 server 的 Web UI 时，可以在 Connections / Registered 里把这个 Register URL 粘贴到唯一的 Parent register URL 输入框并 Connect；动态连接只保存在当前进程内，重启后如需自动连接仍使用 `codexhub server --register-to` 或 `CODEX_HUB_REGISTER_TO`。CLI 和动态 API 都能从 `?token=` 或 `?codexhub_token=` 提取父 server auth token，也可以继续使用 `--register-auth-token` 或 `CODEX_HUB_REGISTER_AUTH_TOKEN`。

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

如需临时使用旧模式，可以设置：

```bash
CODEX_HUB_SSH_REMOTE_MODE=installed
```

旧模式会在远端执行全局 `codexhub machine --server http://127.0.0.1:<remotePort> --type ssh`，因此远端需要自行安装并升级 CodexHub。

本机配置文件默认保存到：

```text
~/.config/codexhub/config.yaml
```

可以通过 `CODEX_HUB_DATA_DIR` 覆盖配置目录。这个 YAML 保存共享 UI 偏好、projects、tasks、SSH hosts、machines 等本机控制面配置，也会包含 `updatedAt`、task 最近 run 摘要这类轻量状态字段。它也可以保存一个 `env` 映射；server 启动时会先读取它，只把尚未存在的键填入 `process.env`，不会覆盖 shell 或 `.env`。它不保存 thread summary 或完整 transcript；thread 内容来自 session 从官方 Codex app-server 同步的 turns snapshot、item/rawResponseItem/tokenUsage 实时事件。旧版 `~/.local/share/codexhub/server-state.yaml` 或同一 `CODEX_HUB_DATA_DIR` 下的 `server-state.yaml` 会在首次启动时迁移写入新的 `config.yaml`。

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

本机 codexhub session：

```bash
pnpm codexhub --server http://127.0.0.1:8788 -C /path/to/project
```

`cxh` 是 `codexhub` 的短别名。

`codexhub [prompt]` 是 legacy/transient headless 入口：它会在当前机器启动官方 `codex app-server`，注册一个 headless session，并主动创建初始 thread。传入 `prompt` 时会对这个 thread 发起一轮 turn，然后继续保持 session 在线。已有 thread 的选择、恢复和新建 thread tab 由 Web 或 `/api/sessions/:sessionId/threads` 完成，CLI 不再提供本地历史列表或 resume 子命令。

server 在线时，`codexhub` 会通过 machine websocket 注册一个 transient session host，再把当前 session 挂到这台 session host 下；它只代表这个 headless Codex 进程，不作为项目浏览/启动器。Web 里打开本机任意项目优先使用内嵌 `local` machine；远端或宿主机项目使用 SSH / registered machine。

server 在线时，session 会同步官方 app-server 的 thread/read、item、rawResponseItem 和 tokenUsage 事件，并接收 Web、Telegram、task 或 API 对同一个 `threadId` 的远程 turn；server 离线时，本地 headless bridge 会持续重试，直到进程退出。Web 主列表以 projects/threads 为主，session 是 machine 级 runtime/debug 对象，同一个 `sessionId` 可以承载多个 project cwd 的 threads；`/api/projects` 的 `session` 字段是按 project path 过滤后的 runtime 投影，`/api/sessions` 保留为 session/debug 镜像，不作为 Web 主列表来源。Telegram 绑定到具体 thread。Web 页面只持有一条 `/api/events/ws` 实时连接，在其中多路复用 projects/sessions/tasks/connections 和页面 thread tabs 的事件订阅。Thread usage 由 server 从每个 thread 镜像到的 app-server tokenUsage 事件计算；session 级账号 rate limit 会从 `account/rateLimits/read` 和 `account/rateLimits/updated` 同步到 `/api/sessions`，Web 在当前 thread 没有更新的 tokenUsage rate limit 时用它作为显示兜底。Thread Model 的 model/reasoning/service tier 下拉优先从当前在线 session 的 app-server `model/list` catalog 读取，通过 `/api/sessions/:sessionId/models` 暴露，不写入 `config.yaml`。Web Context 旁的 Compact 按钮和 `/api/threads/:threadId/compact` 会调用官方 app-server `thread/compact/start`，compact 进度继续由 app-server record 流显示。Composer menu 里的 Review changes 和 `/api/threads/:threadId/review` 会调用官方 app-server `review/start`，默认 review 当前 workspace 未提交改动并 inline 跑在当前 thread。

## 连接方式

CodexHub 只保留三种 machine 连接方式：

1. `local`：本机内嵌 launcher，直接在本机项目目录启动或复用官方 Codex app-server runtime。
2. `ssh`：本机 server 通过 `ssh -R` 把远端 machine 连接转发回来，让本机控制面调用 SSH 机器上的 Codex CLI/app-server。
3. `registered`：外部机器主动连接当前 server 的 `/api/machines/connect`，把那台机器上的官方 `codex app-server` 通过反向 WebSocket tunnel 暴露给当前控制面；父 server 侧继续复用官方 app-server 协议。

不再支持 CodexHub server-to-server state bridge；也不再提供 `type=server` machine、Connections / Servers tab、`/api/server-connections` 或 normalized thread mirror。`codexhub server --register-to` 只把当前 server 作为一台 `registered` machine 接入父 server，父 server 仍只通过 machine/app-server 协议操作它。

当前在线 machine runtime 状态以 Web 和 `/api/sessions` 为准；project 只是 `machineId + path` 元数据。历史 thread 选择以 Web 的 thread picker 和 `/api/sessions/:sessionId/threads` 为准。

启动成功后终端会输出 `sessionId` 和 `threadId`，Web、Telegram、task 或 API 都应显式用这个 `threadId` 继续投递消息。当前所有本机 session CLI 都是 headless。

`codexhub` 启动官方 Codex app-server 时默认设置 `approvalPolicy=never`；可以通过 `--approval-policy` 或 `CODEX_HUB_APP_SERVER_APPROVAL_POLICY` 改成 `untrusted`、`on-failure`、`on-request` 或 `never`。`sandbox` 默认不覆盖官方 Codex 配置；需要固定 sandbox 时，可显式传 `--sandbox` 或设置 `CODEX_HUB_APP_SERVER_SANDBOX`。`codexhub server`、`codexhub machine` 和 SSH / registered machine 启动 app-server 时都会通过 `-c approval_policy="..."` / `-c sandbox_mode="..."` 传给官方 `codex app-server`。旧的 `codexhub [prompt]` transient session 也会把显式 `--sandbox` / `--approval-policy` 用作 app-server 默认和 turn override。

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
pnpm check
pnpm run smoke:auth
pnpm run smoke:machine-session
pnpm run smoke:registered-machine
pnpm run smoke:ssh-loopback
pnpm run smoke:task-lock
pnpm run smoke:electron
pnpm build
```

`smoke:auth` 覆盖 token 保护、Bearer token、WebSocket token query 和 machine websocket 授权。

`smoke:machine-session` 会启动一个临时 server、内嵌 `local` machine 和官方 Codex app-server，验证 project path thread bootstrap、跨 project 共享 machine runtime、`/api/projects` 不暴露 runtime session/thread 列表、`/api/sessions`、session account rate limits、thread detail 不再暴露 `workerId` 或 current thread，验证 session turn 必须显式带 `threadId`，验证 SSH config `Include`、SSH reverse tunnel 命令构造、插件 CSS 资产、`/status` 对话流、pending shell command 展示、server-local task 创建/运行/校验，并确认旧 `session_register.registration.workerId` 会被 strict schema 拒绝。`smoke:task-lock` 额外覆盖 `/api/sessions/:sessionId/models` 的 session command 通道和 model/reasoning/service tier catalog 响应。

`smoke:registered-machine` 会分别启动真实 `codexhub machine --type registered` 和 `codexhub server --register-to` CLI 子进程，并覆盖动态 `/api/registered/parent` 注册、Register URL `?token=` 提取、自注册拒绝、同机不同端口注册、project path thread bootstrap、machine runtime 启动、`/status` 对话流，以及正常 SIGTERM 后 machine/session unregister 生命周期和 app-server 进程清理。

`smoke:ssh-loopback` 会启动一个临时本机 `sshd`，通过真实 `ssh -R` reverse tunnel 连接回临时 server，验证 SSH machine 注册、project path thread bootstrap、machine runtime 启动、`/status` 对话流，以及 SSH connection 删除后 machine/session 进入 offline。

`smoke:task-lock` 会用假的 registered machine/session 走真实 websocket 协议，验证同一个 task 在已有 queued/running turn 时第二次运行会 `skipped`，且 turn 完成后可以再次运行；同时覆盖 thread records subscription、thread compact command、thread review command、Plan/Goal options、running turn steer、goal set/clear、stop turn、idle-close 和 token usage rate limits。

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

发布脚本会先运行 `pnpm check` 和 `pnpm build`，再通过 PM2 启动或重启 `codexhub-prod`，最后检查 `/api/health` 和 `/`。

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

VSCode extension 打包走独立链路：

```bash
pnpm run package:vscode
pnpm run install:vscode
```

`build:vscode` 会先跑完整 `pnpm build`，再把 extension 打成 Node CJS bundle，显式把 extension host 里的 `navigator` 定义为 `undefined` 并断言 bundle 不引用浏览器全局；staging 目录会包含 Web `dist`、`dist-node/ssh` remote client、media、README 和 LICENSE。仓库内的 VSCode Marketplace 发布 workflow 会在 `main` 分支 push 后自动触发，也支持手动 `workflow_dispatch`，会运行 `pnpm run package:vscode`，并要求仓库 secret `VSCE_PAT`，发布时使用 `vsce publish --packagePath dist-vscode/codexhub.vsix --skip-duplicate`。

## Eclipse Theia

官方 Theia IDE 可以直接安装 CodexHub 的 VSIX，不需要 Theia 源码、不需要修改 `app.asar`，也不需要重编 Theia。Windows Theia Electron 通过 Remote WSL 打开工作区时，CodexHub extension/server 仍运行在 WSL extension host；系统通知由 Windows Theia webview 创建。

通知点击后会先激活发出通知的 Theia 窗口和 Codex Hub view，再把 `threadId` 发送给内嵌 Web UI，跳转到对应 thread。如果当前 Theia 不提供 Web Notification API 或权限没有授予，会自动退回 IDE 自带的 `showInformationMessage`。

```bash
pnpm run install:theia
```

默认目标是 `C:\Users\0laop\AppData\Local\Programs\TheiaIDE\TheiaIDE.exe`。命令会构建同一份 `dist-vscode/codexhub.vsix`，为 Windows frontend 和当前 WSL remote backend 各放置一份 user VSIX，替换同版本的旧部署，再调用 Theia 官方的 `--install-plugin` 参数。已有 Theia 窗口通常会收到安装请求；若 WSL remote backend 没有自动重新加载，断开并重新连接该 WSL 窗口（或完整重启 Theia）即可。

也可以覆盖安装位置：

```bash
pnpm run install:theia -- 'C:\path\to\TheiaIDE'
CODEX_HUB_THEIA_IDE_DIR=/mnt/c/path/to/TheiaIDE pnpm run install:theia
```

仓库仍保留 `@dadigua/codexhub-theia` 编译期 target，供需要深度定制 Theia 产品本身的场景使用：

```bash
pnpm run package:theia
pnpm run smoke:theia
```

该高级产物位于 `dist-theia/`，接入方式见 `targets/theia/README.md`；普通 Theia IDE 用户不需要它。

## API

当前公开 API 分成三层：project 是 `machineId + path` 元数据，`sessionId` 是在线 machine runtime 的投递入口，`threadId` 是 transcript、事件订阅和多 thread 操作的主键。机器和 project path thread bootstrap 入口负责把路径请求路由到在线 machine，再启动或复用 machine runtime：

```bash
curl -sS http://127.0.0.1:8788/api/machines
curl -sS http://127.0.0.1:8788/api/projects

curl -sS -X POST http://127.0.0.1:8788/api/projects/open \
  -H 'content-type: application/json' \
  -d '{"machineId":"machine-example","path":"/path/to/project"}'
```

`/api/projects/open` 是兼容保留的 project path thread bootstrap 入口：它返回 machine runtime 的 `sessionId` 和创建/恢复的 `threadId`，但 project 本身不拥有 runtime lifecycle。CodexHub 不提供 per-project runtime stop/restart API；runtime 不由 watcher idle 或 project delete 结束，只随 machine/server 生命周期断开或由内部 shutdown 清理。

单上下文入口（例如 Telegram 或脚本）可以绑定 session，但发送时仍然必须显式指定 `threadId`：

```bash
SESSION_ID=$(curl -sS http://127.0.0.1:8788/api/sessions | jq -r '.sessions[0].sessionId')
THREAD_ID=$(curl -sS http://127.0.0.1:8788/api/threads | jq -r '.threads[0].threadId')

curl -sS -X POST "http://127.0.0.1:8788/api/sessions/$SESSION_ID/turn" \
  -H 'content-type: application/json' \
  -d "{\"threadId\":\"$THREAD_ID\",\"input\":\"继续这个 thread\",\"source\":\"telegram\"}"
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

`/api/sessions/:sessionId/models` 由在线 machine/session bridge 调用官方 app-server `model/list`，返回当前账号/配置可见的 model、supported reasoning efforts 和 service tiers；Web Thread Model 弹窗用它生成下拉选项，失败时才回退本地静态兜底。

`POST /api/threads/:threadId/compact` 由在线 machine/session bridge 调用官方 app-server `thread/compact/start`。它只触发 app-server 对该 thread 的上下文压缩，不改写 CodexHub server 本地 records；Web 通过实时 record 流显示 `context_compaction` / `compacted` 进度和结果。

`POST /api/threads/:threadId/review` 由在线 machine/session bridge 调用官方 app-server `review/start`。当前 Web 入口是 composer `+` 菜单里的 Review changes，target 固定为 `uncommittedChanges`，delivery 为 `inline`，review turn 仍按普通 app-server record 流展示。

`options` 可随 turn 传递 Web 运行选择：`model`、`modelReasoningEffort`、`serviceTier`、`collaborationMode:"plan"`、`goalMode:true`、`goalObjective` 和 `goalTokenBudget`。`serviceTier` 应使用 `/api/sessions/:sessionId/models` 返回的 catalog value；当前 app-server 的 Fast tier 通常是 `priority`。传 `null` 表示清除显式 tier，回到 Codex 配置默认值。Plan mode 只会把本轮输入标记为只规划不实施，不覆盖 app-server sandbox；权限仍由当前 Codex 配置或显式 `--sandbox` 决定。Goal mode 会先通过 app-server `thread/goal/set` 为该 thread 建立 active goal，再启动 turn；如果 Web 在 running thread 上用 Goal mode 发送，则只更新 active goal，不对当前 turn 做 `turn/steer`。

Slash command 会在转发给 Codex 前先处理。`/status` 和 `/help` 返回本地代理状态/帮助记录；`/fast on`、`/fast off`、`/fast status` 会设置或查看当前 thread 的 app-server service tier；Web 里的 `/model` 是客户端命令，会打开 Session 选择器，下一次普通 turn 再把选中的 model/reasoning/service tier 发给 app-server。`codexhub` 会从 `thread/settings/updated` 或有效的 `config/read` 结果镜像 model/reasoning/service tier。不支持的 slash command 不会作为普通 user turn 发给 Codex app-server。

Server 不读取运行机器上的 `~/.codex` session、远端 `.codexp/tasks` 或上传临时图片目录。历史 session 通过 Web/API 或 app-server 恢复后镜像到 server；图片输入使用 app-server 原生 `{ type: "image", url }`；thread usage 由 server 从 app-server tokenUsage 事件镜像计算，session account rate limits 只作为当前账号窗口的 UI 兜底；新定时任务由本机 `config.yaml` 里的 task 配置调度。
