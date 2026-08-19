# codexhub

一个 local-first 的 Codex 控制面。Web 按机器、项目、项目运行状态和对话组织工作区；本机 Node.js server 负责连接机器、排队命令、镜像事件和保存轻量项目元数据。机器来源分为三类：`local` 表示此电脑，`ssh` 表示本机主动通过 SSH 拉起的远端机器，`registered` 表示远端机器主动连接进来。右侧对话仍以官方 Codex `threadId` 和镜像 transcript 为核心。

CodexHub 0.8.0 要求运行 machine 上的官方 Codex CLI 不低于 `0.144.4`。VSCode 0.8.0 延续 authority 级共享服务，并优先使用本机 Node.js 与 npm/link 安装的 CodexHub 包；升级前请先阅读 [0.8.0 迁移说明](./MIGRATION.md)。

- 共享核心：API server 统一管理 machines、machine runtime sessions 和 threads，并把轻量 project 元数据投影到 `/api/projects`；Web 左侧按项目优先展示，点击 project 只切换 active path，Add Tab/thread picker 基于该 path 创建或恢复 thread。
- HTTP API：给 Web、外部脚本或本地自动化调用。
- Web UI：React + TypeScript 的会话界面。
- Machine：server 默认内嵌一台 `local` machine；远端或宿主机也可以用 `codexhub server --register-to` 主动注册成 `registered` machine，负责路径校验和维护 machine 级 runtime session。
- SSH：本机 server 可读取 `~/.ssh/config` 的 host 列表，通过系统 `ssh` 建立 reverse tunnel，并默认下发当前 build 的 remote client 到远端运行。
- Telegram bot：由 API server 内置启动，把 Telegram 消息转成 Codex turn。

## 开发

```bash
pnpm install
cp .env.example .env
pnpm dev
```

`pnpm dev` 会同时启动 API 和 Vite Web 开发服务器：

- Web: `http://127.0.0.1:15173`
- API: `http://127.0.0.1:18788`

Vite 会把 `/api` 代理到开发 API。需要单独启动时使用 `pnpm run dev:api` 或 `pnpm run dev:web`。

## 生产/本地 server

`codexhub server` 是生产和普通本地 API server 的启动入口，会固定读取当前目录的 `.env`。`CODEX_HUB_HOST` / `CODEX_HUB_PORT` 可以写在 `.env` 或 `config.yaml` 的 `env` 字段里，也可以用 CLI 覆盖；优先级是 CLI 参数 > 当前 shell 环境变量 > `.env` > `config.yaml` 的 `env` > 内置默认值。

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

CodexHub 不读取或注入 Codex 私有的 `models_cache.json` / `model_catalog_json`。machine 从在线 app-server 取得并归一化 `model/list` 后，会把模型目录缓存到 `${CODEX_HUB_DATA_DIR:-~/.config/codexhub}/runtime-catalog-cache/`；嵌入 surface 使用对应 server data directory。模型缓存按 machine、Codex CLI 版本、app-server 报告的 `codexHome` 和 hidden 模式隔离，每个作用域独立原子写入，避免共享 data directory 的多个进程互相覆盖。默认 6 小时后视为过期，可用 `CODEX_HUB_CATALOG_CACHE_TTL_MS` 调整；旧 `CODEX_HUB_MODEL_CATALOG_CACHE_TTL_MS` 仍作为兼容别名。过期缓存可以先用于响应，同时后台刷新；接口会返回缓存来源，`refresh=true` 可强制刷新。`permissionProfile/list` 和 Command Palette 的 plugin/skill 候选不持久化，Web 在 Composer 挂载后后台加载，并在当前页面按 machine/cwd 复用。

远端机器或容器外的宿主机可以主动注册。远端已经安装 CodexHub 时，直接让远端 server 注册到父 server：

```bash
codexhub server --register-to http://127.0.0.1:8788
```

也可以在 Web 的 Connections / Registered 里复制当前 server 的 register 命令。远端只需要能从 `PATH` 找到 `codexhub`、`node` 和官方 `codex` 命令；远端 server 会在提供自身 Web/API 的同时，额外用 machine WebSocket 连回父 server。父 server 只把它看成一台动态 `registered` machine，不同步子 server 的 projects、tasks、config 或 thread transcript 权威数据，也不把这台 machine 写入父 server 的 `config.yaml`；新 machine 在线时 Web 会显示 success message，连接断开后显示 warning message 并从父 server machine 列表消失。页面首次加载已有在线 machine 时不会补弹提示，之后重新连接则会再次提示。打开项目时，父 server 会把请求发给在线 machine；machine 进程在它所在的机器上解析路径，确认它存在且是目录，然后创建或复用 machine 级 runtime session。Registered machine 只启动远端官方 `codex app-server` 并通过同一条 machine WebSocket 反向多路复用 app-server WebSocket 帧；父 server 在本地消费官方 app-server 协议并为该目录创建或复用 thread。除内嵌 `local` machine 外，server 不扫描其他机器的文件系统。

父 server Web 左下角会显示可一键复制的 Register URL；如果当前浏览器已经保存父 server auth token，它会生成 `http://host:port?codexhub_token=...`，否则就是不带 token 的 base URL。token 完全可选，父 server 没有启用 `CODEX_HUB_AUTH_TOKEN` 时可以直接用空 token 注册测试。已经打开远端 server 的 Web UI 时，可以在 Connections / Registered 里把这个 Register URL 粘贴到唯一的 Parent register URL 输入框并 Connect。连接成功发起后，子 server 会把规范化后的父 URL、普通 server 的 machine identity 和可选 CodexHub auth token 保存在自身 `config.yaml` 的 `parentRegistration` 中；普通 Web、VSCode、Electron 下次启动都由共享 `startServer()` 自动恢复并继续断线重连。VSCode 同一执行 authority 的所有窗口共享父 URL、可选 token 和一条由 authority ID 派生的稳定 machine transport；Windows、WSL、Remote SSH 等不同 authority 各自注册为独立 machine。Disconnect 会中止正在握手或已在线的 WebSocket、等待 runner 完全退出，并删除自动注册配置。CLI 和动态 API 从 `?codexhub_token=` 提取父 server auth token，也可以使用 `--register-auth-token` 或 `CODEX_HUB_REGISTER_AUTH_TOKEN`；显式空 token 表示不使用认证，CLI / 环境变量的启动时 override 仍只作用于当前进程，不覆盖已保存的 GUI 配置。连接错误和状态只显示去除 query/userinfo 的目标 URL，不记录或投影 token。

CodexHub 会拒绝把一个 server 注册到它自己：同一本机地址且同端口会直接返回错误，目标 `/api/health` 的 `serverInstanceId` 与当前实例相同也会被拒绝。为了本机测试，同一台电脑上不同端口的多个 server 可以互相注册，例如 `127.0.0.1:8789` 注册到 `127.0.0.1:8788` 是允许的。

如果远端不想预装或升级 CodexHub，`/api/registered/bootstrap` 仍保留为 one-shot bootstrap 入口，会通过 `/api/remote-client/:hash` 下载父 server 当前 build 的 remote client 后以同样的 registered tunnel 模式连回。

Project 名称来自目录 basename，不单独持久化展示名或提供重命名入口。Web project 卡片点击只切换 active project path；点击 Add Thread 时才确保该 machine 的唯一 runtime 在线，并为 active path 创建或恢复 thread。卡片不展示 open、history 或 thread 数量，也不提供手动重启/结束 runtime 按钮。runtime 生命周期跟 machine/server 主进程走，project delete、watcher idle-close 和普通空闲都不会关闭它。

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

可以通过 `CODEX_HUB_DATA_DIR` 覆盖配置目录。这个 YAML 保存共享 UI 偏好、parent registration、projects、tasks、SSH hosts、local/SSH machine 元数据等本机控制面配置，也会包含 `updatedAt`、task 最近 run 摘要这类轻量状态字段。普通 Node server、Electron 和 VS Code detached authority 的非编辑器配置也统一从这里读取；它们通过 `env` 映射承载监听地址、authority 端口、app-server、SSH、插件、通知、catalog/runtime 以及 Electron 行为等 CodexHub 参数。父 server 收到的 `registered` machine 只存在于运行时，不写入这里；旧配置中的 registered machine 历史元数据会在加载时自动清理，但它关联的 project/task 配置仍保留。包含 parent auth token 时配置文件会以 `0600` 写入；token 只由后端用于 machine WebSocket，不通过配置或 registration API 返回给 Web。server 启动时会先读取 `env`，只把尚未存在的键填入 `process.env`，不会覆盖 shell 或 `.env`。它不保存 thread summary 或完整 transcript；thread 内容来自 session 从官方 Codex app-server 同步的 turns snapshot、item/rawResponseItem/tokenUsage 实时事件。旧版 `~/.local/share/codexhub/server-state.yaml` 或同一 `CODEX_HUB_DATA_DIR` 下的 `server-state.yaml` 会在首次启动时迁移写入新的 `config.yaml`。

`config.yaml` 里的 `env` 适合 embedded authority service 这类不方便配置 shell 环境变量的场景。例如：

```yaml
version: 1
config:
  ui:
    selectedPetId: guga
    showFloatingPet: false
    showDesktopPet: false
    taskCompleteSystemNotifications: false
env:
  CODEX_HUB_HOST: "0.0.0.0"
  CODEX_HUB_PORT: "8788"
  CODEX_HUB_AUTHORITY_PORT: "28788"
  CODEX_HUB_APP_SERVER_READY_TIMEOUT_MS: "60000"
  CODEX_HUB_SSH_AUTOCONNECT: "1"
  CODEX_HUB_PLUGIN_DIRS: "/home/laop/.local/share/codexhub/plugins"
  CODEX_HUB_ELECTRON_DEVTOOLS: "0"
  # 只有明确需要保护 loopback API 时才设置；VSCode authority 默认无 token
  # CODEX_HUB_AUTH_TOKEN: "replace-with-a-long-random-token"
```

修改 `config.yaml` 后需要重启 server。Embedded authority 是独立于窗口的 detached 进程：关闭该 authority 的全部 VSCode/Electron surface 并等待 30 秒，再重新打开客户端，才能让新的进程重新读取 `env`；只 reload 单个窗口不会强制结束仍被其他 surface 使用的 authority。`CODEX_HUB_DATA_DIR` 本身仍决定去哪读这个配置文件，因此不能靠同一个文件里的 `env.CODEX_HUB_DATA_DIR` 改变当前配置路径。

VS Code 的 `settings.json` 只保存插件自身的窗口级行为，目前只保留 `codexhub.enabled`。`dataDir`、`serverUrl`、`authorityPort`、app-server、SSH、插件、通知、Electron 和共享 UI 配置都不属于 VS Code Settings；它们必须写在共享 authority 使用的 `config.yaml` 中。这样多个 VS Code 窗口、Electron 和普通 Node server 才能看到同一份配置。VS Code 的 `Open Config` 命令打开的也是这份共享 `config.yaml`，不是另一个插件配置副本。

`cxh` 是 `codexhub` 的短别名。

已有 thread 的选择、恢复和新建 thread tab 由 Web 或 `/api/machines/:machineId/threads` 完成。CLI 只提供明确的 `server`、`machine`、`ssh`、`task` 和安装命令，不提供根级 prompt、本地历史列表或 resume 兼容命令。

server 在线时，每台 machine 最多维护一个官方 app-server runtime；内部进程代次使用 `sessionId` 传输，但公共 API、Web state、task history 和 thread 投影都以稳定 `machineId` 表达。该 runtime 会同步官方 app-server 的 thread/turn/item/rawResponseItem/tokenUsage 事件，并接收 Web、Telegram、task 或 API 对具体 `threadId` 的远程 turn。`/api/runtimes` 按 machine 投影当前状态，不暴露内部 session ID 或 app-server URL。Telegram 绑定到具体 thread。Web 页面只持有一条 `/api/events/ws` 实时连接，在其中多路复用 projects/runtimes/tasks/connections 和页面 thread tabs 的事件订阅。Thread context usage 由 server 从 `thread/tokenUsage/updated` 计算；账号 rate limits 独立从 `account/rateLimits/read` 和 `account/rateLimits/updated` 同步到 runtime 投影，Web 合并两者展示。Thread Model 和 Composer Permissions 分别通过 `/api/machines/:machineId/models`、`/api/machines/:machineId/permission-profiles` 读取当前在线 runtime 的 catalog，不写入 `config.yaml`，也不维护静态 fallback。Web Context 旁的 Compact 按钮和 `/api/threads/:threadId/compact` 会调用官方 app-server `thread/compact/start`，compact 进度继续由 app-server record 流显示。Composer menu 里的 Review changes 和 `/api/threads/:threadId/review` 会调用官方 app-server `review/start`，默认 review 当前 workspace 未提交改动并 inline 跑在当前 thread。

## Codex 宠物

Web 和 VS Code 的 Pet 入口只在当前 web window 内显示悬浮宠物。Electron 除了当前 web window 宠物，还可以在 Settings → Pet 中打开独立的桌面宠物；它是透明、置顶、可拖动的 Electron 窗口，不会被主窗口边界限制。宠物汇总当前打开 threads 的状态，按 `Needs input`、`Blocked`、`Ready`、`Running`、`Idle` 显示动画和活动面板；点宠物可以查看需要处理的 thread。只有 Electron 可以打开或关闭桌面宠物。

导入格式与 Codex 桌面端一致：V1 使用 `1536 x 1872`、`8 x 9` 网格，V2 使用 `1536 x 2288`、`8 x 11` 网格；两者都是透明 PNG/WebP、每格 `192 x 208`，文件不超过 20 MiB。选择 V2 图片时必须同时选择带 `spriteVersionNumber: 2` 的 `pet.json`。当前读取 `id`、`displayName`、`description`、`spriteVersionNumber` 和 `spritesheetPath`。V2 宠物空闲时会按指针方向使用新增的 16 个 look 帧。两种宠物都可以拖动，左右拖动分别播放对应移动动画；web window 宠物和 Electron 桌面宠物分别保存位置。咕嘎 V2 与 Red Spark V2 都作为内置宠物打包，咕嘎为默认；导入的宠物保存在 `${CODEX_HOME:-~/.codex}/pets/<id>`，浏览器只在 localStorage 保存显示、选择和位置偏好，不保存图片。

Composer 支持这些本地命令：`/pet` 切换当前 web window 宠物，`/pet off` 收起当前 web window 宠物，`/pet <name>` 选择已安装宠物。这些命令在各 web window 内处理，不会写进 Codex thread transcript；Electron 桌面宠物的开关只在 Electron Pet picker 中提供。

## 连接方式

CodexHub 只保留三种 machine 连接方式：

1. `local`：本机内嵌 launcher，直接在本机项目目录启动或复用官方 Codex app-server runtime。
2. `ssh`：本机 server 通过 `ssh -R` 把远端 machine 连接转发回来，让本机控制面调用 SSH 机器上的 Codex CLI/app-server。
3. `registered`：外部机器主动连接当前 server 的 `/api/machines/connect`，把那台机器上的官方 `codex app-server` 通过反向 WebSocket tunnel 暴露给当前控制面；父 server 侧继续复用官方 app-server 协议。

不再支持 CodexHub server-to-server state bridge；也不再提供 `type=server` machine、Connections / Servers tab、`/api/server-connections` 或 normalized thread mirror。`codexhub server --register-to` 只把当前 server 作为一台 `registered` machine 接入父 server，父 server 仍只通过 machine/app-server 协议操作它。

当前在线 machine runtime 状态以 Web 和 `/api/runtimes` 为准；project 只是 `machineId + path` 元数据。历史 thread 选择以 Web 的 thread picker 和 `/api/machines/:machineId/threads` 为准。

project bootstrap 或 thread 创建接口会返回 `machineId` 和 `threadId`；Web、Telegram、task 或 API 都应显式用这个 `threadId` 继续投递消息。

`codexhub` 启动官方 Codex app-server 时不注入默认 approval policy 或 sandbox，未设置时沿用 Codex CLI 自身配置；approval reviewer 默认使用 `auto_review`。需要覆盖时，可显式通过 `--approval-policy` 或 `CODEX_HUB_APP_SERVER_APPROVAL_POLICY` 设置 `untrusted`、`on-request` 或 `never`，通过 `--approvals-reviewer` 或 `CODEX_HUB_APP_SERVER_APPROVALS_REVIEWER` 设置 `user`、`auto_review` 或当前协议保留的 `guardian_subagent`，通过 `--sandbox` 或 `CODEX_HUB_APP_SERVER_SANDBOX` 固定 sandbox。`codexhub server`、`codexhub machine` 和 SSH / registered machine 会把最终生效的启动选项通过对应 `-c` 配置传给官方 `codex app-server`。

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

任务完成时 Web 会播放完成音效；Settings 里的 Task complete popups 控制是否额外发系统通知。普通 Web 使用 browser Notification，VSCode surface 通过 iframe `postMessage` 转成 VS Code notification，并只把对应 project path 的完成事件发到包含该 workspace 的窗口；Electron surface 则在 Electron main process 创建原生系统通知，点击后恢复并聚焦通知来源窗口，再打开对应 `threadId`。这个开关默认关闭并保存在本地 UI state。

如果希望通知像桌宠 Activity 一样反映整个 Turn 生命周期，可以直接配置 ntfy：

```yaml
env:
  CODEX_HUB_NTFY_URL: "https://ntfy.sh/my-codexhub-topic"
  CODEX_HUB_NTFY_TOKEN: "tk_..."
  CODEX_HUB_NTFY_TIMEOUT_MS: "5000"
  CODEX_HUB_NTFY_UPDATE_INTERVAL_MS: "3000"
```

ntfy hook 会为每个 `threadId + turnId` 建立一个稳定的 sequence ID，并依次更新同一条通知：`运行中`、`等待输入`、流式活动更新、`已完成`、`失败` 或 `已停止`。如果当前 Turn 有结构化 Plan，运行中消息还会按已完成步骤显示真实的 `进度 N%`；没有总步骤时只显示活动标题和已用时间，不会伪造百分比。`CODEX_HUB_NTFY_UPDATE_INTERVAL_MS` 用于合并高频 token/item 事件，避免每个字符都发一次 HTTP 请求。

`CODEX_HUB_NTFY_URL` 必须包含 topic，且不要把 sequence ID 预先写入 URL；CodexHub 会自动把它追加到 topic 路径。`CODEX_HUB_NTFY_TOKEN` 使用 ntfy 的 Bearer token。

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

`smoke:machine-session` 会启动一个临时 server、内嵌 `local` machine 和官方 Codex app-server，验证 machine runtime ensure 不写 project、project path thread bootstrap、跨 project 共享唯一 machine runtime、`/api/projects` 不暴露 runtime/thread 列表、`/api/runtimes` 不暴露内部 session ID、runtime account rate limits、thread detail 不暴露 `workerId` 或 current thread，验证 SSH config `Include`、SSH reverse tunnel 命令构造、插件 CSS 资产、`/status` 对话流、pending shell command 展示、server-local task 创建/运行/校验，并确认 machine/session registration 会拒绝未知旧字段。`smoke:task-lock` 额外覆盖 machine-scoped model、permission profile 和 command palette 通道，以及 runtime-authoritative catalog 响应。

`smoke:registered-machine` 会分别启动真实 `codexhub machine --type registered` 和 `codexhub server --register-to` CLI 子进程，并覆盖动态 `/api/registered/parent` 注册、Register URL `?codexhub_token=` 提取、空 token、子 server parent registration 的 `config.yaml` 持久化与 `0600` 权限、父 server 不持久化 registered machine、server 重启自动恢复、Disconnect 清除自动连接、共享父配置下的 authority 级稳定 machine identity、自注册拒绝、同机不同端口注册、project path thread bootstrap、machine runtime 启动、`/status` 对话流，以及正常 SIGTERM 后 machine/session unregister 生命周期和 app-server 进程清理。单元测试还覆盖 embedded authority 端口映射、VSCode/Electron surface lease 与 project 聚合、注册不提前启动 runtime、token 错误脱敏和连接握手期间的强制中止。

`smoke:ssh-loopback` 会启动一个临时本机 `sshd`，通过真实 `ssh -R` reverse tunnel 连接回临时 server，验证 SSH machine 注册、project path thread bootstrap、machine runtime 启动、`/status` 对话流，以及 SSH connection 删除后 machine/session 进入 offline。

`smoke:task-lock` 会用假的 registered machine/session 走真实 websocket 协议，验证同一个 task 在已有 queued/running turn 时第二次运行会 `skipped`，且 turn 完成后可以再次运行；同时覆盖 thread records subscription、thread compact command、thread review command、Plan/Goal options、running turn steer、goal set/clear、stop turn、idle-close、token usage 和 session account rate limits。

`smoke:electron` 会以 headless Electron 启动桌面入口，验证共享 authority service、Electron surface lease、authority descriptor、固定端口语义和 `/api/health`；如果默认 authority 端口已被本机 VSCode authority 占用，smoke 会使用显式隔离测试端口；它不创建真实桌面窗口。

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

## Electron 和 VSCode

Electron 壳和 VSCode extension 现在按同一个“执行 authority”共享服务，不再各自启动一套 server。Windows host、每个 WSL distro、每个 Remote SSH host/user、Dev Container 分别是独立 authority，各自解析自己的目录并拥有自己的 local machine/runtime；特别是 Windows 与 WSL 始终是两台 parent machine，不能因为 localhost 可互通就合并。

| extension host 环境 | authority service 端口 |
| --- | ---: |
| Windows | `28788` |
| macOS | `28788` |
| 普通 Linux | `28788` |
| WSL | `28789` |

WSL 使用桌面端口的 `+1`，是为了在 WSL mirrored networking 与 Windows 共享 localhost 端口空间时避开 Windows 的 `28788`。Remote SSH/Container 在自己的执行环境和网络命名空间中按上表选端口。VSCode 和 Electron authority 默认不读取 `CODEX_HUB_PORT`，也不在占用时顺延；如果固定端口上不是同一个 `authorityId` 和 embedded surface protocol 的 CodexHub 服务，客户端会明确报错。`CODEX_HUB_AUTHORITY_PORT` 可以显式指定隔离开发/测试端口，生产默认不要设置。

第一个客户端会优先从本地 npm/link 包的 `dist-node/authority-service.cjs` 和 `dist` detached 启动服务；没有可用本地包时才使用 VSIX 或 Electron bundle 内的 `authority-service.cjs`。后续客户端只 probe 并 attach。authority ID、共享 `config.yaml` 和 `authority.log` 位于 `CODEX_HUB_DATA_DIR`（默认 `~/.config/codexhub`）；ID 文件尽可能以 `0600` 创建。authority 只监听 `127.0.0.1`，默认不生成或要求 access token，因此可直接打开 `http://127.0.0.1:28788`（WSL 为 `28789`）。只有 extension host 环境或该 authority `config.yaml` 的 `env.CODEX_HUB_AUTH_TOKEN` 显式设置为非空值时，Web/API/WebSocket 才启用认证；显式 token 只通过子进程环境和窗口请求传递，不放进 service 命令行或日志。旧版生成的 `vscode-authority-token` / `authority-token` 文件会在 authority 下次启动时删除，浏览器发现服务未启用认证时也会清掉同 origin 下的旧 token。每个 VSCode 窗口和 Electron 窗口用唯一 `surfaceId + leaseId` 调用 `/api/embedded/surfaces`，分别传 `surface: "vscode"` 或 `surface: "electron"`，之后每 10 秒 heartbeat；正常 deactivate/close 会 unregister，异常退出的 lease 约 30 秒后过期，最后一个 surface 离开后服务再等待 30 秒自动退出。多个客户端注册的 workspace 会聚合成同一 local machine 的 transient projects；相同路径被多个 surface 引用时保留到最后一个 lease 消失。注册只验证目录，不启动 Codex app-server/thread；第一次 Add Thread 才确保 authority 唯一 runtime 在线。

authority 启动时会先读取当前用户登录 shell 的 `PATH`，并把它与 VSCode/Electron 宿主继承的 `PATH` 合并；因此即使从桌面启动，也可以使用用户通过 nvm、fnm、asdf、npm 或 pnpm 配置的 Node 和 CLI。然后优先使用本地 npm/链接包中的 authority service 和 Web `dist`；如果用户 PATH 中的 `codexhub`/`cxh` 没有指向可用构建，才回退到 VSIX/Electron bundle。Node 运行时优先使用用户 PATH 中满足 Node 20+ 要求的 `node`，最后才回退到 VSCode/Electron 宿主自带的 Node。选择结果和 authority 代码来源会显示在 `/api/health` 的 `authorityRuntime`、`authorityServiceSource` 中。更新本地包或 Node 后重启 authority（Settings → Restart CodexHub），下一个首次启动 authority 的客户端就会使用新版本；VSCode 和 Electron 后续会 attach 到同一个已运行的 authority。npm 是包管理器，不负责替换 Node 本身；通常不需要把 Node 或 CodexHub 的绝对路径写入 `config.yaml`。

本地开发包只需要构建，并确保 `codexhub` 或 `cxh` 通过 `npm link` 或其他用户级安装方式出现在用户的 `PATH` 中：

```bash
pnpm build
command -v codexhub || command -v cxh
```

在 WSL 仓库中可以用一个脚本同时更新 WSL 和 Windows 的全局 link。脚本会先完整构建当前版本；WSL 直接对当前 checkout 执行 `npm link`，Windows 则把 `package.json`、`bin`、`dist` 和 `dist-node` 同步到 `%LOCALAPPDATA%\CodexHub\windows-link-package`，在那里执行 Windows `npm install` 和 `npm link`。这样 Windows 端也是标准 npm link，同时避免 npm/cmd 对 WSL UNC 路径生成临时盘符而导致链接重启后失效：

```bash
pnpm run link:all
```

完成后可以分别检查：

```bash
command -v codexhub
/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command 'Get-Command codexhub'
```

如果命令能在用户 shell 中解析到本地包，VSCode/Electron 启动 authority 时会自动发现它对应的包根目录。`authorityServiceSource` 为 `linked-package` 时表示实际使用了 PATH 中的本地 `npm link` 包；`configured-package` 表示使用了显式 `CODEX_HUB_AUTHORITY_PACKAGE`；`bundled` 表示回退到了 VSIX/Electron 自带代码。Windows 的 link 镜像每次运行脚本都会按当前 WSL 构建覆盖更新；只有 Remote SSH、多个全局 Node 并存等特殊场景，才建议显式配置 `CODEX_HUB_AUTHORITY_PACKAGE` 或 `CODEX_HUB_AUTHORITY_NODE`。

同一 authority 的 VSCode/Electron client 共享 local runtime、SSH/tasks/plugins/Registered 配置和一条 parent machine transport，但 Web UI 仍按当前 URL 携带的 workspace paths 过滤项目，localStorage 按稳定 client scope 隔离，task completion popup 也只路由到包含对应 project path 的窗口。VSCode iframe 使用和普通 Web 相同的完整左侧控制面；Webview 和 Open in Browser 都通过 `vscode.env.asExternalUri`，因此 Remote SSH、端口转发或 tunnel 环境仍可访问。没有 file workspace folder 的 VSCode 只显示状态页；Electron 仍可注册空 workspace surface。

命令面板里的 `Codex Hub: Open Config File` 会打开当前 authority service 使用的共享 `config.yaml`；文件不存在时会先创建一个最小配置。用户在 UI 中显式保存 transient project 后，它才会进入共享的普通 CodexHub project list。

```bash
pnpm electron:start
```

这个脚本使用 npm 安装的 Electron binary，并在 Linux 开发环境下传 `--no-sandbox` 规避本地 `chrome-sandbox` setuid 权限问题。

Windows x64 安装包可以直接在 WSL 中交叉构建，产物由 electron-builder 生成 NSIS 安装器：

```bash
pnpm package:electron:win
```

安装器输出到 `release-artifacts/electron/CodexHub-Setup-<version>-x64.exe`。如果只需要检查解包后的 Windows 应用目录，可以运行：

```bash
pnpm package:electron:win:dir
```

WSL 首次构建需要安装 Wine（包含 32 位组件，用于 NSIS 工具链）：

```bash
sudo dpkg --add-architecture i386
sudo apt update
sudo apt install wine64 wine32:i386
```

构建脚本会先执行完整的 `pnpm build`，然后把 Electron main process、detached authority service、Web `dist` 和 SSH remote client 放入 Windows 包。Windows 安装包未配置代码签名证书，因此发布到用户机器时可能触发 SmartScreen 提示；正式发布前需要接入 Windows 代码签名证书。安装器是在 WSL 中生成的，但最终运行验证仍应在 Windows 上进行，因为 Windows 与 WSL 是两台独立的执行 authority，各自使用所在系统的 Codex CLI、配置和 runtime。

可选环境变量：

- `CODEX_HUB_AUTHORITY_PORT`: 可选的 embedded authority 端口覆盖，主要用于隔离开发/测试；默认按执行环境使用 `28788` 或 WSL 的 `28789`
- `CODEX_HUB_AUTHORITY_PACKAGE`: 可选的本地 CodexHub npm/link 包根目录；指定后优先使用其中的 `dist-node/authority-service.cjs`、`dist` 和 SSH client bundle
- `CODEX_HUB_AUTHORITY_NODE`: 可选的 authority Node 可执行文件路径；未设置时优先使用 `PATH` 中的 Node，再回退到宿主运行时
- `CODEX_HUB_DATA_DIR`: VSCode/Electron 共享 authority 数据目录，默认 `~/.config/codexhub`
- `CODEX_HUB_ELECTRON_DEVTOOLS=1`: 启动后打开 DevTools；也可以写入共享 `config.yaml` 的 `env`

Electron 关闭时只注销自己的 surface lease；如果 VSCode 仍在线，共享 authority 和 runtime 会继续运行。最后一个 surface 离开后，authority 等待约 30 秒自动退出。在 Electron 里连接宿主机 project launcher 的方式和 Web 相同。

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

`build:vscode` 会先跑完整 `pnpm build`，再把 extension 与 detached authority service 分别打成 Node CJS bundle，显式把 Node host 里的 `navigator` 定义为 `undefined` 并断言两个 bundle 都不引用浏览器全局；共享 VSIX staging 位于 `dist-vsix/`，会包含 `extension.cjs`、`authority-service.cjs`、Web `dist`、`dist-node/ssh` remote client、media、README 和 LICENSE，供 VS Code 使用。

## 发布新版本

仓库使用 `.github/workflows/release.yml` 统一发布，不再在每次 `main` push 时分别发布 npm 和 Marketplace。发布 workflow 只接受与根 `package.json` 版本严格一致的 `v<version>` 标签，一次构建并验证以下两个产物：

- `release-artifacts/dadigua-codexhub-<version>.tgz`：CLI npm 包，内含同版本共享 VSIX
- `release-artifacts/codexhub-<version>.vsix`：发布到 VS Code Marketplace

本地预检可以运行：

```bash
pnpm run check:app-server-protocol
pnpm run smoke:core
pnpm run package:release
pnpm run smoke:vscode-install
pnpm run smoke:notification-hooks
```

验证通过后提交版本修改，再推送 `main` 和对应标签：

```bash
VERSION=$(node -p "require('./package.json').version")
git push origin main
git tag -a "v${VERSION}" -m "CodexHub ${VERSION}"
git push origin "v${VERSION}"
```

标签会依次发布 `@dadigua/codexhub`、VS Code Marketplace，并创建包含两个文件的 GitHub Release。npm 发布前会检查精确版本是否已存在，Marketplace 使用 `--skip-duplicate`，GitHub Release 采用 create-or-upload，因此失败后可以在 Actions 中选择同一标签手动重跑；不得移动或复用已经指向其他提交的版本标签。仓库需要配置 `NPM_TOKEN` 和 `VSCE_PAT`。

## API

当前公开 API 分成三层：project 是 `machineId + path` 元数据，runtime 以稳定 `machineId` 标识，`threadId` 是 turn 投递、transcript、事件订阅和多 thread 操作的主键。机器和 project path thread bootstrap 入口负责把路径请求路由到在线 machine，再启动或复用它的唯一 runtime：

设置 `CODEX_HUB_AUTH_TOKEN` 后，普通 API 使用 `Authorization: Bearer <token>`。`?codexhub_token=` 只用于 `/api/events/ws`、`/api/machines/connect` 和无法添加 Authorization header 的 `/api/file` 图片预览，不会授权其他 API 路径。

```bash
curl -sS http://127.0.0.1:8788/api/machines
curl -sS http://127.0.0.1:8788/api/projects

curl -sS -X POST http://127.0.0.1:8788/api/projects/open \
  -H 'content-type: application/json' \
  -d '{"machineId":"machine-example","path":"/path/to/project"}'
```

`/api/projects/open` 是显式 project path thread bootstrap/persistence 入口：它返回 `machineId` 和创建/恢复的 `threadId`，但 project 本身不拥有 runtime lifecycle。Add Thread 冷启动改用 `/api/machines/:machineId/runtime/ensure`，不会借由 project open 修改 project 状态。CodexHub 不提供 per-project runtime stop/restart API；runtime 不由 watcher idle 或 project delete 结束，只随 machine/server 生命周期断开或由内部 shutdown 清理。

Telegram、脚本和 Web 都直接针对明确的 `threadId` 投递：

```bash
THREAD_ID=$(curl -sS http://127.0.0.1:8788/api/threads | jq -r '.threads[0].threadId')

curl -sS -X POST "http://127.0.0.1:8788/api/threads/$THREAD_ID/turn" \
  -H 'content-type: application/json' \
  -d '{"input":"继续这个 thread","source":"telegram"}'
```

Web 这类多 thread UI 可以直接针对选中的 thread 投递，或让 machine 当前 runtime start/resume 一个 thread tab。Web 前端使用单条 `/api/events/ws` WebSocket 实时流，连接后发送 `hello` 订阅控制面事件，再用 `subscribe_thread` / `unsubscribe_thread` 在同一条连接里维护页面 thread tabs：

```bash
MACHINE_ID=$(curl -sS http://127.0.0.1:8788/api/machines | jq -r '.machines[0].machineId')
THREAD_ID=$(curl -sS http://127.0.0.1:8788/api/threads | jq -r '.threads[0].threadId')

curl -sS -X POST "http://127.0.0.1:8788/api/threads/$THREAD_ID/turn" \
  -H 'content-type: application/json' \
  -d '{"input":"看一下这个项目结构","source":"web"}'

# /api/events/ws messages:
# {"type":"hello","runtimesAfter":0,"projectsAfter":0,"tasksAfter":0,"connectionsAfter":0}
# {"type":"subscribe_thread","threadId":"<threadId>","after":0}

curl -sS -X POST "http://127.0.0.1:8788/api/machines/$MACHINE_ID/runtime/ensure" \
  -H 'content-type: application/json' \
  -d '{"cwd":"/path/to/project"}'

curl -sS -X POST "http://127.0.0.1:8788/api/machines/$MACHINE_ID/threads" \
  -H 'content-type: application/json' \
  -d '{"action":"resume","threadId":"019e...","cwd":"/path/to/project"}'

curl -sS -X POST "http://127.0.0.1:8788/api/machines/$MACHINE_ID/threads" \
  -H 'content-type: application/json' \
  -d '{"action":"new","cwd":"/path/to/project"}'

curl -sS "http://127.0.0.1:8788/api/machines/$MACHINE_ID/models"

curl -sS -X POST "http://127.0.0.1:8788/api/machines/$MACHINE_ID/files/preview" \
  -H 'content-type: application/json' \
  -d '{"path":"/path/to/project/src/index.ts"}'
```

`POST /api/machines/:machineId/files/preview` 把绝对路径发给实际拥有该文件系统的在线 machine，而不是让 server 扫描远端文件。UTF-8 文本和按签名确认的常见位图继续返回内联预览，默认最多读取 2 MiB（可用 machine 环境变量 `CODEX_HUB_MAX_FILE_PREVIEW_BYTES` 调整）。按 ISO BMFF `ftyp` 签名确认的 MP4 会返回隐藏绝对路径的短期 `/api/file-stream/:ticketId` URL；该 URL 支持 `HEAD`、单段 HTTP `Range`、`206 Content-Range` 和拖动播放，由 local/SSH/registered machine 校验文件 size/mtime 后按 1 MiB 以内的 chunk 提供内容。ticket 默认 30 分钟过期且每次访问续期，可用 server 环境变量 `CODEX_HUB_FILE_STREAM_TICKET_TTL_MS` 调整；关闭预览对话框会主动删除 ticket。Web 和 Electron 用 `<video controls preload="metadata">` 播放，VS Code surface 仍把链接交给扩展的 `vscode.open`。

`/api/machines/:machineId/models` 由该 machine 当前在线 runtime 调用官方 app-server `model/list`，返回当前账号/配置可见的 model、supported reasoning efforts 和 service tiers；Web Thread Model 弹窗只使用这份 runtime catalog 或它的带时间戳缓存。`?refresh=true` 可强制实时刷新。catalog 尚未就绪且没有缓存或读取失败时会禁用选择并显示加载/错误状态，不使用本地静态 model fallback。

`/api/machines/:machineId/permission-profiles?cwd=<project-path>` 由该 machine 当前在线 runtime 实时调用官方 app-server `permissionProfile/list`，返回该 cwd 当前可见的 profile `id`、`description` 和 `allowed`，不做后端持久缓存。Web 在 Composer 挂载后后台加载并在当前页面按 machine/cwd 复用；权限菜单只渲染已加载结果，被 requirements 禁止的 profile 会禁用，读取失败时显示错误，不补入 `:read-only`、`:workspace` 或 `:danger-full-access` 等静态选项。

`POST /api/threads/:threadId/compact` 由在线 machine/session bridge 调用官方 app-server `thread/compact/start`。它只触发 app-server 对该 thread 的上下文压缩，不改写 CodexHub server 本地 records；Web 通过 app-server `contextCompaction` item 归一化出的 `context_compaction` record 显示进度和结果。

`POST /api/threads/:threadId/review` 由在线 machine/session bridge 调用官方 app-server `review/start`。当前 Web 入口是 composer `+` 菜单里的 Review changes，target 固定为 `uncommittedChanges`，delivery 为 `inline`，review turn 仍按普通 app-server record 流展示。

`options` 可随 turn 传递 Web 运行选择：`model`、`modelReasoningEffort`、`serviceTier`、`approvalPolicy`、`approvalsReviewer`、`permissions`、`collaborationMode:"plan"`、`goalMode:true`、`goalObjective` 和 `goalTokenBudget`。`serviceTier` 应使用 `/api/machines/:machineId/models` 返回的 catalog value；当前 app-server 的 Fast tier 通常是 `priority`。`permissions` 应使用 `/api/machines/:machineId/permission-profiles` 返回的 profile id，且不能和兼容旧客户端的 `sandboxPolicy` 同时传递。Plan mode 只会把本轮输入标记为只规划不实施，不覆盖 app-server permissions。Goal mode 会先通过 app-server `thread/goal/set` 为该 thread 建立 active goal，再启动 turn；如果 Web 在 running thread 上用 Goal mode 发送，则只更新 active goal，不对当前 turn 做 `turn/steer`。

Web 的普通 Goal 编辑只更新目标内容，不要求也不会隐式修改 7d 额度。旁边的燃烧入口会为同一个 Goal 额外设置 CodexHub 本地 `consumeUntilWeeklyRemainingAtOrBelow` 策略；百分比表示“7d 剩余降到该值时开始收尾”，不是硬停止上限。达到触发线后，CodexHub 会取消后续自动续跑，并向当前 Turn 发送一次安全收尾 steer；当前 Turn 可以正常完成且可能略微超过该值。收尾过程中保留原 Goal 内容，不会改写成另一个“收尾工作”目标。

Slash command 会在转发给 Codex 前先处理。`/status` 和 `/help` 返回本地代理状态/帮助记录；`/fast on`、`/fast off`、`/fast status` 会设置或查看当前 thread 的 app-server service tier；Web 里的 `/model` 是客户端命令，会打开 Session 选择器，下一次普通 turn 再把选中的 model/reasoning/service tier 发给 app-server。`codexhub` 会从 `thread/settings/updated` 或有效的 `config/read` 结果镜像 model/reasoning/service tier。不支持的 slash command 不会作为普通 user turn 发给 Codex app-server。

Server 不读取运行机器上的 `~/.codex` session、远端 `.codexp/tasks` 或上传临时图片目录。历史 session 通过 Web/API 或 app-server 恢复后镜像到 server；图片输入使用 app-server 原生 `{ type: "image", url }`；thread context usage 由 server 从 app-server tokenUsage 事件镜像计算，session account rate limits 作为独立账号窗口与它合并展示；新定时任务由本机 `config.yaml` 里的 task 配置调度。
