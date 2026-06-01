# codex-proxy

一个 worker-first 的本地 Codex 控制面。当前运行态由 `codexp` / `codexp resume` 启动的官方 `codex app-server` worker 持有，server 负责排队命令和镜像事件。一次 `codexp` 或 `codexp resume` 等价于打开一个官方 Codex：一个 TUI、一个 app-server、一个 worker；同一个目录可以同时运行多个 worker。

- 共享核心：API server 统一镜像 Codex workers 和 threads，Web 左侧按在线 worker 选择，右侧跟随 worker 当前 `threadId`。
- HTTP API：给 Web、外部脚本或本地自动化调用。
- Web UI：React + TypeScript 的会话界面。
- CLI worker：`codexp` / `codexp resume` 复用官方 Codex TUI 和 app-server。
- Telegram bot：由 API server 内置启动，把 Telegram 消息转成 Codex turn。

## 启动

```bash
pnpm install
cp .env.example .env
pnpm build
pnpm run dev:api
```

`codexp server` 是 API server 的启动入口，会固定读取当前目录的 `.env`。`CODEX_PROXY_HOST` / `CODEX_PROXY_PORT` 可以写在 `.env`，也可以用 CLI 覆盖；优先级是 CLI 参数 > 当前 shell 环境变量 > `.env` > 内置默认值。

默认入口：

- Web/API: `http://127.0.0.1:8788`

也可以直接指定监听地址：

```bash
pnpm codexp server --host 0.0.0.0 --port 8788
```

官方 Codex TUI + codex-proxy worker：

```bash
pnpm codexp --server http://127.0.0.1:8788 -C /path/to/project
pnpm codexp --server http://127.0.0.1:8788 resume <threadId> -C /path/to/project
pnpm codexp list
pnpm codexp threads --show 20
```

`codexp [prompt]` 会在当前机器启动官方 `codex app-server`，然后用 PTY wrapper 前台运行官方 `codex --remote ... [prompt]` TUI。`codexp resume [threadId] [prompt]` 走同一套 worker/bridge，只是前台 TUI 改为官方 `codex resume --remote ... [threadId] [prompt]`；不传 `threadId` 时保留官方 resume picker，也可以用 `--last`。codex-proxy server 是可选增强：server 在线时，`codexp` 注册一个本次进程唯一的 worker，同步 app-server event，并接收 Web、Telegram、task 或 API 对同一个 `threadId` 的远程 turn；server 离线时，本地官方 Codex TUI 仍然正常可用，只是暂时不能远程转发。后台 bridge 会持续重试，server 恢复后自动注册并开始同步。Web 主列表只展示在线 worker；右侧展示选中 worker 的当前 thread，TUI 里 `/resume` 切换后会随 app-server event 同步。Codex usage 和本地图片处理等机器相关能力由 `codexp` worker 上报或执行，server 只缓存和转发。非 headless 终端底部会保留一行 `codexp` 状态栏，显示当前 worker、thread 和 server 连接状态。官方 TUI 退出时，`codexp` 会立即 unregister worker；如果 `codexp` 异常消失，server 通过 heartbeat timeout 标记 offline，Web 左侧不再显示该 worker。

`codexp list` 与 Web 左侧一致，只显示当前在线的 codexp worker；`codexp threads` 扫描本机官方 Codex session 历史，只显示当前目录的可 resume threads，并输出标题、更新时间和完整 threadId。`--show` 控制最近显示数量，默认 20。

PTY 支持依赖 `node-pty` native build，仓库的 `pnpm-workspace.yaml` 已允许该依赖运行 build script。

如果只想作为远程 worker，不打开 TUI：

```bash
pnpm codexp --server http://127.0.0.1:18788 -C /path/to/project --headless
```

Telegram bot 随 API server 启动；`.env` 里配置 token 后直接运行 `pnpm run dev:api` 即可：

```bash
TELEGRAM_BOT_TOKEN=xxx
pnpm run dev:api
```

没有 `TELEGRAM_BOT_TOKEN` 时 server 会启动失败；项目不再提供 `--telegram` / `--no-telegram` / `--env` 或 `CODEX_PROXY_TELEGRAM_ENABLED` 这类分支开关。`pnpm bot` 仅保留为手动调试独立 bot 的入口，不要和 server 内置 bot 同时运行。

本地定时任务由 `codexp` 运行，不由 server 扫本机目录：

```bash
pnpm codexp task template daily-summary
pnpm codexp task list
pnpm codexp task start
pnpm codexp task run .codexp/tasks/daily-summary.yaml
```

`codexp task` 子命令使用运行命令时的当前目录作为 workspace。`codexp task list` 默认离线可用，只扫描本地 `.codexp/tasks/*.yaml`；只有显式传 `--server` 或设置 `CODEX_PROXY_SERVER_URL` 时，才连接 server 并额外显示 server 是否在线。`codexp task start` 是给 PM2 或终端常驻使用的本地调度器，按 YAML 里的 `schedule` cron 到点后在本机执行 Codex：YAML 里没有 `thread` 时执行 `codex exec -C <workspace> -`，有 `thread` 时执行 `codex exec -C <workspace> resume <thread> -` 继续该 session。`codexp task run <task_yaml_path>` 立即本地运行指定 YAML 文件一次，不看 `schedule`，也不依赖 codex-proxy server。运行记录写到本地 `.codexp/task-runs/*.jsonl`。

## 生产发布

生产环境由 PM2 管理，使用 5 位 `1xxxx` 端口；API server 同时服务 Web `dist`。

```bash
cp .env.example .env
# 编辑 .env: CODEX_PROXY_PORT=18788
pnpm run publish:prod
```

长期进程：

- `codex-proxy-prod`: `http://127.0.0.1:18788`
- Telegram bot 内置在 `codex-proxy-prod`，由同一个 server 进程启动

发布脚本会先运行 `pnpm check` 和 `pnpm build`，再通过 PM2 启动或重启 `codex-proxy-prod`，最后检查 `/api/health` 和 `/`。

常用命令：

```bash
pm2 list
pm2 logs codex-proxy-prod
pm2 restart codex-proxy-prod
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

Slash commands are handled before forwarding to Codex. `/status` and `/help` return local proxy status/help records. `/model` is a client command in Web and opens the Runtime selector; Web sends the selected model/reasoning with the next normal turn. If the official TUI changes model/reasoning locally, `codexp` / `codexp resume` mirrors app-server Runtime settings back into Web from `thread/settings/updated` events or the effective `config/read` result. Unsupported slash commands are not sent to the Codex app-server as user turns because official TUI slash commands are local UI commands, not app-server turns.

Server 不读取运行机器上的 `~/.codex` session、`.codexp/tasks` 或上传临时图片目录。历史 session 通过 `codexp resume` 或官方 TUI/app-server 恢复后镜像到 server；图片输入使用 app-server 原生 `{ type: "image", url }`；usage 由本地 worker heartbeat 上报；定时任务由 `codexp task start` 在本地通过 `codex exec` 执行。
