# codex-proxy

一个 thread-first 的本地 Codex 控制面。当前运行态由 `codexp connect` 启动的官方 `codex app-server` worker 持有，server 负责排队命令和镜像事件。

- 共享核心：API server 统一镜像 Codex threads，Web/TG/task 按 `threadId` 选择和转发。
- HTTP API：给 Web、外部脚本或本地自动化调用。
- Web UI：React + TypeScript 的会话界面。
- CLI worker：`codexp connect` 复用官方 Codex TUI 和 app-server。
- Telegram bot：把 Telegram 消息转成 Codex turn。

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

`codexp connect` 会在当前机器启动官方 `codex app-server`，向 codex-proxy server 注册一个 worker，然后用 PTY wrapper 前台运行官方 `codex --remote ...` TUI。Web、Telegram、task 或 API 对同一个 `threadId` 发送的 turn 会由 server 转成 worker command，在本机 app-server/cwd 内执行。非 headless 终端底部会保留一行 `codexp` 状态栏，显示当前 worker、thread 和 server 连接状态。官方 TUI 退出时，`codexp` 会立即 unregister worker；如果 `codexp` 异常消失，server 通过 heartbeat timeout 标记 offline。

PTY 支持依赖 `node-pty` native build，仓库的 `pnpm-workspace.yaml` 已允许该依赖运行 build script。

如果只想作为远程 worker，不打开 TUI：

```bash
pnpm codexp --api http://127.0.0.1:18788 connect -C /home/laop/projects/codex-proxy --headless
```

Telegram bot：

```bash
TELEGRAM_BOT_TOKEN=xxx pnpm bot
```

## 生产发布

生产环境由 PM2 管理，使用 5 位 `1xxxx` 端口；API server 同时服务 Web `dist`。

```bash
cp .env.prod.example .env.prod
pnpm publish:prod
```

长期进程：

- `codex-proxy-prod`: `http://127.0.0.1:18788`
- `codex-proxy-tg`: Telegram bot，连接 `http://127.0.0.1:18788`

发布脚本会先运行 `pnpm check` 和 `pnpm build`，再用临时端口 `18790` 启动 `codex-proxy-next` 做 `/api/health` 和 `/` 健康检查；检查通过后才重启生产进程。

常用命令：

```bash
pm2 list
pm2 logs codex-proxy-prod
pm2 logs codex-proxy-tg
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
