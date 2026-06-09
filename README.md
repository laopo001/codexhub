# codexhub

一个 local-first 的 Codex 控制面。Web 按机器、项目、项目运行状态和对话组织工作区；本机 Node.js server 负责连接机器、排队命令、镜像事件和保存轻量项目元数据。机器来源分为三类：`local` 表示此电脑，`ssh` 表示本机主动通过 SSH 拉起的远端机器，`registered` 表示远端机器主动连接进来。右侧对话仍以官方 Codex `threadId` 和镜像 transcript 为核心。

- 共享核心：API server 统一管理 machines、runtime sessions 和 threads，并把它们投影成 project-first 的 `/api/projects`；Web 左侧按项目优先展示，右侧跟随选中 thread。
- HTTP API：给 Web、外部脚本或本地自动化调用。
- Web UI：React + TypeScript 的会话界面。
- Machine：server 默认内嵌一台 `local` machine；远端或宿主机也可以用 `codexhub machine` 主动注册，负责路径校验和按项目启动 runtime session。
- SSH：本机 server 可读取 `~/.ssh/config` 的 host 列表，通过系统 `ssh` 建立 reverse tunnel，并默认下发当前 build 的 remote client 到远端运行。
- Local session CLI：`codexhub` / `codexhub resume` 继续复用官方 Codex TUI 和 app-server。
- Telegram bot：由 API server 内置启动，把 Telegram 消息转成 Codex turn。

## 启动

```bash
pnpm install
cp .env.example .env
pnpm build
pnpm run dev:api
```

`codexhub server` 是 API server 的启动入口，会固定读取当前目录的 `.env`。`CODEX_HUB_HOST` / `CODEX_HUB_PORT` 可以写在 `.env`，也可以用 CLI 覆盖；优先级是 CLI 参数 > 当前 shell 环境变量 > `.env` > 内置默认值。

默认入口：

- Web/API: `http://127.0.0.1:8788`

普通本机启动时，server 会默认注册一台 `local` machine，Web 的 Connections / This Computer 可以直接看到它，并通过 Projects 打开本机目录、启动 Codex runtime session。需要关闭这个内嵌本机入口时设置：

```bash
CODEX_HUB_LOCAL_MACHINE=0 pnpm codexhub server
```

也可以直接指定监听地址：

```bash
pnpm codexhub server --host 0.0.0.0 --port 8788
```

远端机器或容器外的宿主机可以主动注册：

```bash
pnpm codexhub machine --server http://127.0.0.1:8788 --type registered
```

也可以在 Web 的 Connections / Registered 里复制同等命令。随后在 Web 左侧通过弹窗选择项目路径。server 会把打开项目请求发给在线 machine；machine 进程在它所在的机器上解析路径，确认它存在且是目录，然后创建或复用该目录下的 runtime session。除内嵌 `local` machine 外，server 不扫描其他机器的文件系统。

也可以让本机 server 主动通过 SSH 管理远端机器。SSH host 发现默认读取本机 `~/.ssh/config`，支持 `Include` 引入的配置文件；需要覆盖路径时设置 `CODEX_HUB_SSH_CONFIG=/path/to/config`。连接和认证交给系统 `ssh`、`ssh-agent`、`known_hosts`、ProxyJump 等已有配置：

```bash
pnpm codexhub ssh config-hosts
pnpm codexhub ssh add my-remote
pnpm codexhub ssh hosts
pnpm codexhub ssh connect my-remote --name my-remote
```

`codexhub ssh hosts` 只显示已添加到 CodexHub 的 SSH config alias；HostName、User、Port、ProxyJump 等连接细节仍以本机 SSH config 为准，不复制进 CodexHub state。`codexhub ssh connect` 会建立 reverse tunnel，默认让远端 `node` 通过 `http://127.0.0.1:<remotePort>/api/ssh/remote-client/<hash>` 下载本机当前 build 的 remote client，按 sha256 缓存到 `~/.cache/codexhub/remote-client/<hash>/client.cjs` 后运行。远端不需要预装或升级 CodexHub，但仍需要能从 `PATH` 找到 `node` 和官方 `codex` runtime。断开 SSH 后，这条连接下启动的远端 runtime session 会随进程退出。

server 启动时会默认读取已添加到 CodexHub 的 SSH alias 并自动连接；添加 alias 后也会由 server 侧尝试启动连接，不依赖 Web 是否切到 SSH tab。需要临时关闭时设置：

```bash
CODEX_HUB_SSH_AUTOCONNECT=0
```

如需临时使用旧模式，可以设置：

```bash
CODEX_HUB_SSH_REMOTE_MODE=installed
```

旧模式会在远端执行全局 `codexhub machine --server http://127.0.0.1:<remotePort> --type ssh`，因此远端需要自行安装并升级 CodexHub。

server 的轻量状态默认保存到：

```text
~/.local/share/codexhub/server-state.yaml
```

可以通过 `CODEX_HUB_DATA_DIR` 覆盖数据目录。这个 YAML 只保存 machines、projects 和 thread summaries，完整 transcript 来自 runtime session 从官方 Codex app-server 同步的 thread/read 和实时事件镜像。

官方 Codex TUI + codexhub runtime session：

```bash
pnpm codexhub --server http://127.0.0.1:8788 -C /path/to/project
pnpm codexhub --server http://127.0.0.1:8788 resume <threadId> -C /path/to/project
pnpm codexhub list
pnpm codexhub threads --show 20
```

`cxh` 是 `codexhub` 的短别名，例如 `pnpm cxh list`。

`codexhub [prompt]` 会在当前机器启动官方 `codex app-server`，然后用 PTY wrapper 前台运行官方 `codex --remote ... [prompt]` TUI。`codexhub resume [threadId] [prompt]` 走同一套 runtime bridge，只是前台 TUI 改为官方 `codex resume --remote ... [threadId] [prompt]`；不传 `threadId` 时保留官方 resume picker，也可以用 `--last`。

server 在线时，前台 `codexhub` 会通过 machine websocket 注册一个 transient session host，再把当前 runtime session 挂到这台 session host 下；它只代表这个前台 Codex 进程，不作为项目浏览/启动器。Web 里打开本机任意项目优先使用内嵌 `local` machine；远端或宿主机项目使用 SSH / registered machine。

server 在线时，runtime session 会同步官方 app-server 的 thread/read、item、rawResponseItem 和 tokenUsage 事件，并接收 Web、Telegram、task 或 API 对同一个 `threadId` 的远程 turn；server 离线时，本地官方 Codex TUI 仍然正常可用，后台 bridge 会持续重试。Web 主列表以 projects/threads 为主，runtime session 只是 project 当前在线运行能力，并通过 `/api/projects` 的 `runtime` 字段投影；`/api/sessions` 保留为 runtime/debug 镜像，不作为 Web 主列表来源。Telegram 绑定到具体 thread。Web 页面只持有一条 `/api/events/ws` 实时连接，在其中多路复用 projects/sessions/tasks/connections 和页面 thread tabs 的事件订阅。Thread usage 由 server 从每个 thread 镜像到的 app-server tokenUsage 事件计算。

`codexhub list` 与 Web 左侧一致，显示当前 runtime sessions；`codexhub threads` 扫描本机官方 Codex session 历史，只显示当前目录的可 resume threads，并输出标题、更新时间和完整 threadId。`--show` 控制最近显示数量，默认 20。

PTY 支持依赖 `node-pty` native build，仓库的 `pnpm-workspace.yaml` 已允许该依赖运行 build script。

如果只想启动一个 headless runtime session，不打开 TUI：

```bash
pnpm codexhub --server http://127.0.0.1:8788 -C /path/to/project --headless
```

`--headless` 会在 app-server/bridge 就绪后主动调用一次 app-server `thread/start`，创建一个初始 thread。启动成功后终端会输出 `sessionId` 和 `threadId`，Web、Telegram、task 或 API 都应显式用这个 `threadId` 继续投递消息。

`codexhub` 默认不替官方 Codex 设置 `sandbox` 或 `approvalPolicy`；未显式传参时，权限由 Codex 按当前 workspace 的真实配置解析。只有显式传 `--sandbox` 或 `--approval-policy` 时，codexhub 才把这些值作为 app-server override 转发。

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

Codex turn 默认不设等待超时，适合长任务和定时任务持续运行。需要在特定部署里限制单次 turn 时，可以设置 `CODEX_HUB_TURN_TIMEOUT_MS` 为正整数毫秒；不设置或设为 `0` 表示不启用 turn 超时。

runtime session 的断线判定和 recently disconnected 保留时间可以用 `CODEX_HUB_SESSION_OFFLINE_TIMEOUT_MS`、`CODEX_HUB_SESSION_OFFLINE_RETENTION_MS`、`CODEX_HUB_SESSION_SWEEP_INTERVAL_MS` 调整。旧的 `CODEX_HUB_WORKER_*` 变量仍作为过渡兜底读取，但新配置应使用 `SESSION` 命名。

## 插件

当前插件系统分两层：外部插件只做本机静态 contribution 注入，server 扫描插件 manifest，Web 根据 `/api/plugins` 返回的 contribution 加载样式；内建插件可以提供受控 integration runtime，例如 `codexhub.telegram`。它不执行外部插件 JS，也不把 SSH、Telegram、theme 全部抽成一个大生命周期框架。

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

外部插件也可以声明 integration 作为 UI/管理元数据，但当前只有 `runtime: builtin` 的内建 integration 会被 server 启动：

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
pnpm run smoke:machine-session
pnpm run smoke:registered-machine
pnpm run smoke:ssh-loopback
pnpm run smoke:task-lock
pnpm run smoke:electron
pnpm build
```

`smoke:machine-session` 会启动一个临时 server、内嵌 `local` machine 和官方 Codex app-server，打开临时项目，验证 `/api/projects/open`、`/api/sessions`、thread detail 不再暴露 `workerId` 或 runtime current thread，验证 session turn 必须显式带 `threadId`，验证 SSH config `Include`、SSH reverse tunnel 命令构造、插件 CSS 资产、`/status` 对话流、server-local task 创建/运行/校验，并确认旧 `session_register.registration.workerId` 会被 strict schema 拒绝。

`smoke:registered-machine` 会启动一个真实 `codexhub machine --type registered` CLI 子进程，验证 registered machine 注册、项目打开、runtime session 启动、`/status` 对话流，以及正常 SIGTERM 后 machine/session unregister 生命周期。

`smoke:ssh-loopback` 会启动一个临时本机 `sshd`，通过真实 `ssh -R` reverse tunnel 连接回临时 server，验证 SSH machine 注册、项目打开、runtime session 启动、`/status` 对话流，以及 SSH connection 删除后 machine/session 进入 offline。

`smoke:task-lock` 会用假的 registered machine/session 走真实 websocket 协议，验证同一个 task 在已有 queued/running turn 时第二次运行会 `skipped`，且 turn 完成后可以再次运行。

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

容器镜像用于运行本机 Node.js server、Web 和 API。Codex runtime 仍由连接进来的 machine/session 提供；也就是说，宿主机或远端机器继续用 `codexhub machine`、SSH 或前台 `codexhub` 把项目接到这个 server。

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
codexhub machine --server http://127.0.0.1:8788 --type registered
```

## Electron

Electron 壳用于把同一个本机 Node.js server 和 Web UI 包成桌面窗口。它启动一个内嵌 server，默认使用随机空闲端口，然后打开该地址；Codex runtime 仍然由本机/SSH/registered machine session 提供。

```bash
pnpm electron:start
```

这个脚本使用 npm 安装的 Electron binary，并在 Linux 开发环境下传 `--no-sandbox` 规避本地 `chrome-sandbox` setuid 权限问题。正式分发时可以在后续引入 electron-builder / forge，把同一个 `dist-node/electron/main.js` 作为 main process 入口。

可选环境变量：

- `CODEX_HUB_PORT`: Electron 内嵌 server 端口；显式设置后端口被占用会直接报错，未设置时使用随机空闲端口
- `CODEX_HUB_HOST`: Electron 内嵌 server host，默认 `127.0.0.1`
- `CODEX_HUB_ELECTRON_DEVTOOLS=1`: 启动后打开 DevTools

在 Electron 里连接宿主机 project launcher 的方式和 Web 相同；也可以从 Connections / Registered 复制包含当前实际端口的命令。

## API

当前公开 API 分成两层：`sessionId` 是在线 runtime session 的投递入口，`threadId` 是 transcript、事件订阅和多 thread 操作的主键。机器和项目入口负责把路径请求路由到在线 machine，再启动或复用 runtime session：

```bash
curl -sS http://127.0.0.1:8788/api/machines
curl -sS http://127.0.0.1:8788/api/projects

curl -sS -X POST http://127.0.0.1:8788/api/projects/open \
  -H 'content-type: application/json' \
  -d '{"machineId":"machine-example","path":"/path/to/project"}'
```

单上下文入口（例如 Telegram 或脚本）可以绑定 runtime session，但发送时仍然必须显式指定 `threadId`：

```bash
SESSION_ID=$(curl -sS http://127.0.0.1:8788/api/sessions | jq -r '.sessions[0].sessionId')
THREAD_ID=$(curl -sS http://127.0.0.1:8788/api/threads | jq -r '.threads[0].threadId')

curl -sS -X POST "http://127.0.0.1:8788/api/sessions/$SESSION_ID/turn" \
  -H 'content-type: application/json' \
  -d "{\"threadId\":\"$THREAD_ID\",\"input\":\"继续这个 thread\",\"source\":\"telegram\"}"
```

Web 这类多 thread UI 可以直接针对选中的 thread 投递，或让在线 session start/resume 一个 thread tab。Web 前端使用单条 `/api/events/ws` WebSocket 实时流，连接后发送 `hello` 订阅控制面事件，再用 `subscribe_thread` / `unsubscribe_thread` 在同一条连接里维护页面 thread tabs；`/api/threads/:threadId/events` SSE 仍保留给简单脚本和兼容客户端：

```bash
SESSION_ID=$(curl -sS http://127.0.0.1:8788/api/sessions | jq -r '.sessions[0].sessionId')
THREAD_ID=$(curl -sS http://127.0.0.1:8788/api/threads | jq -r '.threads[0].threadId')

curl -sS -X POST "http://127.0.0.1:8788/api/threads/$THREAD_ID/turn" \
  -H 'content-type: application/json' \
  -d '{"input":"看一下这个项目结构","source":"web"}'

# /api/events/ws messages:
# {"type":"hello","sessionsAfter":0,"projectsAfter":0,"tasksAfter":0,"connectionsAfter":0}
# {"type":"subscribe_thread","threadId":"<threadId>","after":0}

curl -N "http://127.0.0.1:8788/api/threads/$THREAD_ID/events?after=0"

curl -sS -X POST "http://127.0.0.1:8788/api/sessions/$SESSION_ID/threads" \
  -H 'content-type: application/json' \
  -d '{"action":"resume","threadId":"019e..."}'

curl -sS -X POST "http://127.0.0.1:8788/api/sessions/$SESSION_ID/threads" \
  -H 'content-type: application/json' \
  -d '{"action":"new"}'
```

`options` 可随 turn 传递 Web 运行选择：`model`、`modelReasoningEffort`、`collaborationMode:"plan"`、`goalMode:true`、`goalObjective` 和 `goalTokenBudget`。Plan mode 会把本轮输入标记为只规划不实施，并在 app-server `turn/start` 上强制使用 read-only sandbox；下一次普通 turn 会恢复之前观察到的非只读 sandbox。Goal mode 会先通过 app-server `thread/goal/set` 为该 thread 建立 active goal，再启动 turn。

Slash command 会在转发给 Codex 前先处理。`/status` 和 `/help` 返回本地代理状态/帮助记录；Web 里的 `/model` 是客户端命令，会打开 Runtime 选择器，下一次普通 turn 再把选中的 model/reasoning 发给 app-server。如果官方 TUI 在本地改了 model/reasoning，`codexhub` / `codexhub resume` 会从 `thread/settings/updated` 或有效的 `config/read` 结果镜像回 Web。不支持的 slash command 不会作为普通 user turn 发给 Codex app-server，因为官方 TUI 的 slash command 是本地 UI 命令，不是 app-server turn。

Server 不读取运行机器上的 `~/.codex` session、远端 `.codexp/tasks` 或上传临时图片目录。历史 session 通过 `codexhub resume` 或官方 TUI/app-server 恢复后镜像到 server；图片输入使用 app-server 原生 `{ type: "image", url }`；thread usage 由 server 从 app-server tokenUsage 事件镜像计算；新定时任务由本机 server state 调度。
