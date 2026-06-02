# codexhub

一个 worker-first 的本地 Codex 控制面。当前运行态由 `codexhub` / `codexhub resume` 启动的官方 `codex app-server` worker 持有，server 负责排队命令和镜像事件。一次 `codexhub` 或 `codexhub resume` 等价于打开一个官方 Codex：一个 TUI、一个 app-server、一个 worker；同一个目录可以同时运行多个 worker。

- 共享核心：API server 统一镜像 Codex workers 和 threads，Web 左侧按在线 worker 选择，右侧跟随 worker 当前 `threadId`。
- HTTP API：给 Web、外部脚本或本地自动化调用。
- Web UI：React + TypeScript 的会话界面。
- CLI worker：`codexhub` / `codexhub resume` 复用官方 Codex TUI 和 app-server。
- Telegram bot：由 API server 内置启动，把 Telegram 消息转成 Codex turn。

## 启动

```bash
pnpm install
cp .env.example .env
pnpm build
pnpm run dev:api
```

`codexhub server` 是 API server 的启动入口，会固定读取当前目录的 `.env`。`CODEX_PROXY_HOST` / `CODEX_PROXY_PORT` 可以写在 `.env`，也可以用 CLI 覆盖；优先级是 CLI 参数 > 当前 shell 环境变量 > `.env` > 内置默认值。

默认入口：

- Web/API: `http://127.0.0.1:8788`

也可以直接指定监听地址：

```bash
pnpm codexhub server --host 0.0.0.0 --port 8788
```

官方 Codex TUI + codexhub worker：

```bash
pnpm codexhub --server http://127.0.0.1:8788 -C /path/to/project
pnpm codexhub --server http://127.0.0.1:8788 resume <threadId> -C /path/to/project
pnpm codexhub list
pnpm codexhub threads --show 20
```

`cxh` 是 `codexhub` 的短别名，例如 `pnpm cxh list`。

`codexhub [prompt]` 会在当前机器启动官方 `codex app-server`，然后用 PTY wrapper 前台运行官方 `codex --remote ... [prompt]` TUI。`codexhub resume [threadId] [prompt]` 走同一套 worker/bridge，只是前台 TUI 改为官方 `codex resume --remote ... [threadId] [prompt]`；不传 `threadId` 时保留官方 resume picker，也可以用 `--last`。codexhub server 是可选增强：server 在线时，`codexhub` 注册一个本次进程唯一的 worker，同步 app-server event，并接收 Web、Telegram、task 或 API 对同一个 `threadId` 的远程 turn；server 离线时，本地官方 Codex TUI 仍然正常可用，只是暂时不能远程转发。后台 bridge 会持续重试，server 恢复后自动注册并开始同步。Web 主列表只展示在线 worker；右侧展示选中 worker 的当前 thread，TUI 里 `/resume` 切换后会随 app-server event 同步。Codex usage 和本地图片处理等机器相关能力由 `codexhub` worker 上报或执行，server 只缓存和转发。非 headless 终端底部会保留一行 `codexhub` 状态栏，显示当前 worker、thread 和 server 连接状态。官方 TUI 退出时，`codexhub` 会立即 unregister worker；如果 `codexhub` 异常消失，server 通过 heartbeat timeout 标记 offline，Web 左侧不再显示该 worker。

`codexhub list` 与 Web 左侧一致，只显示当前在线的 codexhub worker；`codexhub threads` 扫描本机官方 Codex session 历史，只显示当前目录的可 resume threads，并输出标题、更新时间和完整 threadId。`--show` 控制最近显示数量，默认 20。

PTY 支持依赖 `node-pty` native build，仓库的 `pnpm-workspace.yaml` 已允许该依赖运行 build script。

如果只想作为远程 worker，不打开 TUI：

```bash
pnpm codexhub --server http://127.0.0.1:18788 -C /path/to/project --headless
```

`--headless` 会在 app-server/bridge 就绪后主动调用一次 app-server `thread/start`，创建该 worker 的初始 `currentThreadId`，因此可以直接接收 Web、Telegram、task 或 API 的 `/api/workers/:workerId/turn` 输入。启动成功后终端会输出 `workerId` 和 `threadId`。

`codexhub` 默认不替官方 Codex 设置 `sandbox` 或 `approvalPolicy`；未显式传参时，权限由 Codex 按当前 workspace 的真实配置解析。只有显式传 `--sandbox` 或 `--approval-policy` 时，codexhub 才把这些值作为 app-server override 转发。

Telegram bot 随 API server 启动；`.env` 里配置 token 后直接运行 `pnpm run dev:api` 即可：

```bash
TELEGRAM_BOT_TOKEN=xxx
pnpm run dev:api
```

没有 `TELEGRAM_BOT_TOKEN` 时 server 会启动失败；项目不再提供 `--telegram` / `--no-telegram` / `--env` 或 `CODEX_PROXY_TELEGRAM_ENABLED` 这类分支开关。`pnpm bot` 仅保留为手动调试独立 bot 的入口，不要和 server 内置 bot 同时运行。

本地定时任务由 `codexhub` 运行，不由 server 扫本机目录：

```bash
pnpm codexhub task template daily-summary
pnpm codexhub task list
pnpm codexhub task start
pnpm codexhub task run .codexp/tasks/daily-summary.yaml
```

`codexhub task` 子命令使用运行命令时的当前目录作为 workspace。`codexhub task list` 默认离线可用，只扫描本地 `.codexp/tasks/*.yaml`；只有显式传 `--server` 或设置 `CODEX_PROXY_SERVER_URL` 时，才连接 server 并额外显示 server 是否在线。`codexhub task start` 是给 PM2 或终端常驻使用的本地调度器：启动后会先在当前 workspace 拉起一个 headless codexhub worker，输出 `workerId` 和 `threadId`，再按 YAML 里的 `schedule` cron 到点后投递任务输入。任务 YAML 有 `thread` 时，调度器会先让该 worker 通过 app-server `thread/resume` 恢复这个 thread，再向 `/api/threads/:threadId/turn` 发送；没有 `thread` 时向 worker 当前 thread 的 `/api/workers/:workerId/turn` 发送。`codexhub task run <task_yaml_path>` 立即本地运行指定 YAML 文件一次，不看 `schedule`，保留直接 `codex exec` / `codex exec resume` 的离线一次性执行语义。

## 生产发布

生产环境由 PM2 管理，使用 5 位 `1xxxx` 端口；API server 同时服务 Web `dist`。

```bash
cp .env.example .env
# 编辑 .env: CODEX_PROXY_PORT=18788
pnpm run publish:prod
```

长期进程：

- `codexhub-prod`: `http://127.0.0.1:18788`
- Telegram bot 内置在 `codexhub-prod`，由同一个 server 进程启动

发布脚本会先运行 `pnpm check` 和 `pnpm build`，再通过 PM2 启动或重启 `codexhub-prod`，最后检查 `/api/health` 和 `/`。

常用命令：

```bash
pm2 list
pm2 logs codexhub-prod
pm2 restart codexhub-prod
```

## API

当前运行态 API 以 `threadId` 为主键。新 thread 在本地官方 Codex TUI 里开始，server 只列出、读取和转发已有 thread：

```bash
THREAD_ID=$(curl -sS http://127.0.0.1:8788/api/threads | jq -r '.threads[0].threadId')

curl -sS -X POST "http://127.0.0.1:8788/api/threads/$THREAD_ID/turn" \
  -H 'content-type: application/json' \
  -d '{"input":"看一下这个项目结构","source":"web"}'

curl -N "http://127.0.0.1:8788/api/threads/$THREAD_ID/events?after=0"
```

Slash commands are handled before forwarding to Codex. `/status` and `/help` return local proxy status/help records. `/model` is a client command in Web and opens the Runtime selector; Web sends the selected model/reasoning with the next normal turn. If the official TUI changes model/reasoning locally, `codexhub` / `codexhub resume` mirrors app-server Runtime settings back into Web from `thread/settings/updated` events or the effective `config/read` result. Unsupported slash commands are not sent to the Codex app-server as user turns because official TUI slash commands are local UI commands, not app-server turns.

Server 不读取运行机器上的 `~/.codex` session、`.codexp/tasks` 或上传临时图片目录。历史 session 通过 `codexhub resume` 或官方 TUI/app-server 恢复后镜像到 server；图片输入使用 app-server 原生 `{ type: "image", url }`；usage 由本地 worker heartbeat 上报；定时任务由 `codexhub task start` 在本地扫描任务文件并投递到它启动的 headless worker。
