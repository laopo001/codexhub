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
pnpm dev:api
pnpm dev:web
```

Dev 使用原 4 位端口：

- Web: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:8788`

官方 Codex TUI + codex-proxy worker：

```bash
pnpm codexp --api http://127.0.0.1:18788 connect -C /home/laop/projects/codex-proxy
```

`codexp connect` 会在当前机器启动官方 `codex app-server`，向 codex-proxy server 注册一个本次进程唯一的 worker，然后用 PTY wrapper 前台运行官方 `codex --remote ...` TUI。Web 主列表只展示在线 worker；右侧展示选中 worker 的当前 thread，TUI 里 `/resume` 切换后会随 app-server event 同步。Web、Telegram、task 或 API 对同一个 `threadId` 发送的 turn 会由 server 转成 worker command，在本机 app-server/cwd 内执行。非 headless 终端底部会保留一行 `codexp` 状态栏，显示当前 worker、thread 和 server 连接状态。官方 TUI 退出时，`codexp` 会立即 unregister worker；如果 `codexp` 异常消失，server 通过 heartbeat timeout 标记 offline，Web 左侧不再显示该 worker。

PTY 支持依赖 `node-pty` native build，仓库的 `pnpm-workspace.yaml` 已允许该依赖运行 build script。

如果只想作为远程 worker，不打开 TUI：

```bash
pnpm codexp --api http://127.0.0.1:18788 connect -C /home/laop/projects/codex-proxy --headless
```

Telegram bot 随 API server 启动；`.env` 里配置 token 后直接运行 `pnpm dev:api` 即可：

```bash
TELEGRAM_BOT_TOKEN=xxx
pnpm dev:api
```

没有 `TELEGRAM_BOT_TOKEN` 时 server 会跳过 Telegram。需要临时禁用可设置 `CODEX_PROXY_TELEGRAM_ENABLED=false`。`pnpm bot` 仅保留为手动调试独立 bot 的入口，不要和 server 内置 bot 同时运行。

## 生产发布

生产环境由 PM2 管理，使用 5 位 `1xxxx` 端口；API server 同时服务 Web `dist`。

```bash
cp .env.prod.example .env.prod
pnpm publish:prod
```

长期进程：

- `codex-proxy-prod`: `http://127.0.0.1:18788`
- Telegram bot 内置在 `codex-proxy-prod`，有 `TELEGRAM_BOT_TOKEN` 时自动启动

发布脚本会先运行 `pnpm check` 和 `pnpm build`，再用临时端口 `18790` 启动 `codex-proxy-next` 做 `/api/health` 和 `/` 健康检查；检查通过后才重启生产进程。

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
