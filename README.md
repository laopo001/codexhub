# codex-proxy

一个基于 `@openai/codex-sdk` 的本地 Codex 代理层。第一版提供：

- 共享核心：API server 统一持有 Codex instances，Web/TG 共同 attach。
- HTTP API：给 Web、外部脚本或本地自动化调用。
- Web UI：React + TypeScript 的会话界面。
- CLI TUI：终端里的交互式会话。
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

TUI：

```bash
pnpm tui -- --cwd /home/laop/projects/codex-proxy
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

当前运行态 API 以 instance 为主键：

```bash
INSTANCE_ID=$(curl -sS http://127.0.0.1:8788/api/instances \
  -H 'content-type: application/json' \
  -d '{"workingDirectory":"/home/laop/projects/codex-proxy"}' | jq -r .instanceId)

curl -sS -X POST "http://127.0.0.1:8788/api/instances/$INSTANCE_ID/turn" \
  -H 'content-type: application/json' \
  -d '{"input":"看一下这个项目结构","source":"web"}'

curl -N "http://127.0.0.1:8788/api/instances/$INSTANCE_ID/events?after=0"
```
