# codex-proxy

一个基于 `@openai/codex-sdk` 的本地 Codex 代理层。第一版提供：

- 共享核心：统一创建、恢复、运行 Codex thread。
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

TUI：

```bash
pnpm tui -- --cwd /home/laop/projects/codex-proxy
```

Telegram bot：

```bash
TELEGRAM_BOT_TOKEN=xxx pnpm bot
```

## API

```bash
curl -N http://127.0.0.1:8788/api/turn/stream \
  -H 'content-type: application/json' \
  -d '{"input":"看一下这个项目结构","workingDirectory":"/home/laop/projects/codex-proxy","skipGitRepoCheck":true}'
```
