# codex-proxy

一个 worker-first 的本地 Codex 控制面。当前运行态由 `codexp connect` 启动的官方 `codex app-server` worker 持有，server 负责排队命令和镜像事件。一次 `codexp connect` 等价于打开一个官方 Codex：一个 TUI、一个 app-server、一个 worker；同一个目录可以同时运行多个 worker。

- 共享核心：API server 统一镜像 Codex workers 和 threads，Web 左侧按在线 worker 选择，右侧跟随 worker 当前 `threadId`。
- HTTP API：给 Web、外部脚本或本地自动化调用。
- Web UI：React + TypeScript 的会话界面。
- CLI worker：`codexp connect` 复用官方 Codex TUI 和 app-server。
- Telegram bot：由 API server 内置启动，把 Telegram 消息转成 Codex turn。

## 启动

```bash
pnpm install
cp .env.example .env
pnpm run dev:api
pnpm run dev:web
```

`codexp server` 是 API server 的启动入口，会固定读取当前目录的 `.env`。`CODEX_PROXY_HOST` / `CODEX_PROXY_PORT` 可以写在 `.env`，也可以用 CLI 覆盖；优先级是 CLI 参数 > 当前 shell 环境变量 > `.env` > 内置默认值。

Dev 使用原 4 位端口：

- Web: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:8788`

也可以直接指定监听地址：

```bash
pnpm codexp server --host 0.0.0.0 --port 8788
```

官方 Codex TUI + codex-proxy worker：

```bash
pnpm codexp --api http://127.0.0.1:8788 connect -C /path/to/project
```

`codexp connect` 会在当前机器启动官方 `codex app-server`，向 codex-proxy server 注册一个本次进程唯一的 worker，然后用 PTY wrapper 前台运行官方 `codex --remote ...` TUI。Web 主列表只展示在线 worker；右侧展示选中 worker 的当前 thread，TUI 里 `/resume` 切换后会随 app-server event 同步。Web、Telegram、task 或 API 对同一个 `threadId` 发送的 turn 会由 server 转成 worker command，在本机 app-server/cwd 内执行。Codex usage 和本地图片处理等机器相关能力由 `codexp` worker 上报或执行，server 只缓存和转发。非 headless 终端底部会保留一行 `codexp` 状态栏，显示当前 worker、thread 和 server 连接状态。官方 TUI 退出时，`codexp` 会立即 unregister worker；如果 `codexp` 异常消失，server 通过 heartbeat timeout 标记 offline，Web 左侧不再显示该 worker。

PTY 支持依赖 `node-pty` native build，仓库的 `pnpm-workspace.yaml` 已允许该依赖运行 build script。

如果只想作为远程 worker，不打开 TUI：

```bash
pnpm codexp --api http://127.0.0.1:18788 connect -C /path/to/project --headless
```

Telegram bot 随 API server 启动；`.env` 里配置 token 后直接运行 `pnpm run dev:api` 即可：

```bash
TELEGRAM_BOT_TOKEN=xxx
pnpm run dev:api
```

没有 `TELEGRAM_BOT_TOKEN` 时 server 会启动失败；项目不再提供 `--telegram` / `--no-telegram` / `--env` 或 `CODEX_PROXY_TELEGRAM_ENABLED` 这类分支开关。`pnpm bot` 仅保留为手动调试独立 bot 的入口，不要和 server 内置 bot 同时运行。

本地定时任务由 `codexp` 运行，不由 server 扫本机目录：

```bash
pnpm codexp --api http://127.0.0.1:8788 task template daily-summary
pnpm codexp --api http://127.0.0.1:8788 task ls
pnpm codexp --api http://127.0.0.1:8788 task daemon
```

`--cwd` 默认是运行命令时的当前目录；需要操作其他目录时再显式指定。`codexp task daemon` 只读取该工作区的 `.codexp/tasks/*.yaml`，按 cron 到点后通过 server API 把输入投递给匹配的在线 thread，并把运行记录写到本地 `.codexp/task-runs/*.jsonl`。

## 生产发布

生产环境由 PM2 管理，使用 5 位 `1xxxx` 端口；API server 同时服务 Web `dist`。

```bash
cp .env.example .env
# 编辑 .env: CODEX_PROXY_PORT=18788, CODEX_PROXY_SERVE_STATIC=true, CODEX_PROXY_STATIC_DIR=dist
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

Slash commands are handled before forwarding to Codex. `/status` and `/help` return local proxy status/help records. `/model` is a client command in Web and opens the Runtime selector; Web sends the selected model/reasoning with the next normal turn. If the official TUI changes model/reasoning locally, `codexp connect` mirrors app-server Runtime settings back into Web from `thread/settings/updated` events or the effective `config/read` result. Unsupported slash commands are not sent to the Codex app-server as user turns because official TUI slash commands are local UI commands, not app-server turns.

Server 不读取运行机器上的 `~/.codex` session、`.codexp/tasks` 或上传临时图片目录。历史 session 通过官方 TUI/app-server 恢复后由 `codexp connect` 镜像到 server；图片输入使用 app-server 原生 `{ type: "image", url }`；usage 由本地 worker heartbeat 上报；定时任务由 `codexp task daemon` 在本地执行。
