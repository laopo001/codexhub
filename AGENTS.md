# codexhub 架构约定

## 总体方向

codexhub 是本机 Node.js server + Web 控制面。server 负责 machines、projects、runtime sessions、threads、tasks、plugins 和 SSH connections 的控制面与事件镜像；真正的 Codex runtime 仍在官方 Codex app-server 进程里，由 machine 侧启动并上报。

当前公开模型使用 `machineId`、`projectId`、`sessionId`、`threadId`。旧 `workerId` 只允许作为 `ThreadHub` 等内部实现细节继续存在，不能重新暴露成产品概念或公共 API。

## Machine / Session / Thread 模型

1. `MachineType = "local" | "ssh" | "registered"`。
2. `local` 表示本机 server 内嵌的 project launcher；普通本机启动默认启用，Docker 默认关闭。
3. `ssh` 表示本机 server 通过系统 `ssh -R` reverse tunnel 拉起的远端 `codexhub machine --type ssh`。SSH 断开后，该 machine 和其下 runtime session 应进入 offline；先不做自动恢复或后台保活。
4. `registered` 表示外部机器主动运行 `codexhub machine --server ... --type registered` 连接进来。它注册的是机器，不是 worker。
5. machine 是 project launcher 和命令执行入口。server 不扫描远端文件系统；目录解析、权限检查和启动 session 都在 machine 所在机器执行。
6. runtime session 是一次官方 Codex app-server/headless runtime。公开 ID 是 `sessionId`；一个 project 可以没有 session，也可以复用或启动新的 session。
7. `threadId` 来自官方 Codex session。server/Web/TG/task 读取和展示 thread transcript，但 transcript 的权威来源仍是 runtime session 镜像的 records/jsonl。
8. `session_current_changed` 才能更新 runtime session 的 current thread。Web 选择 tab、读取 thread、普通 records 或 task 输入都不能推断或改写 runtime current。
9. slash command 不按普通 Codex turn 透传。server 本地只处理明确支持的 `/status`、`/help`、`/model` 语义；其他 slash command 返回不支持说明。

## 公共 API 约定

1. 公开 API 以这些入口为准：`/api/machines`、`/api/machines/connect`、`/api/projects`、`/api/projects/open`、`/api/sessions`、`/api/sessions/:sessionId/turn`、`/api/sessions/:sessionId/threads`、`/api/threads/*`、`/api/tasks`、`/api/plugins`、`/api/ssh/*`。
2. 不再恢复 `/api/workers` 作为公共入口，也不要添加 `/api/instances`、`.codexp/instances.yaml` 或 instance 兼容层。
3. machine websocket 先发送 `register` 注册机器，再用 `session_register` 注册该机器下的 runtime session。`session_register.registration` 必须是 strict schema，不能接受旧 `workerId`。
4. 公共 JSON 返回不应包含 `workerId`。如果内部代码仍使用 worker 命名，必须在 API 边界映射为 `sessionId`。
5. Web/TG/task 发送对话时优先使用 `sessionId` 或 `threadId`。单上下文入口使用 `/api/sessions/:sessionId/turn`，多 thread UI 可以使用 `/api/threads/:threadId/turn`。
6. server 可以持久化轻量 machine/project/thread/task 摘要到 `CODEX_HUB_DATA_DIR` 下的 server state，但不能把这个状态当成 Codex runtime 或远端文件系统权限。

## SSH 模型

1. server 读取 SSH config 用 `src/core/sshConfig.ts`，支持 `Include` 和简单 `*`/`?` glob；可用 `CODEX_HUB_SSH_CONFIG` 指向测试或自定义配置。
2. `/api/ssh/connect` 通过系统 `ssh` 建立 `-R 127.0.0.1:<remotePort>:<localHost>:<localPort>`，远端默认执行 `codexhub machine --server http://127.0.0.1:<remotePort> --type ssh`。
3. 如果 server 监听 `0.0.0.0` 或 `::`，reverse tunnel 的本机目标应映射到 `127.0.0.1`。
4. SSH 是 connection/transport 方式，不需要把所有 transport 都抽象成插件系统。先保持直接、可验证、断开即结束。

## Project / Task 模型

1. project 是 `machineId + path` 推导出的 server UI/路由元数据，不拥有 Codex runtime。
2. `POST /api/projects/open` 必须发给在线 machine，由 machine 在本机确认 path 是可进入目录，再启动或复用 runtime session。
3. task 记录在本机 server state，选择 machine、project path、可选 thread 和 cron schedule，然后按计划投递一轮对话。
4. 不再让 server 扫描 `.codexp/tasks`。旧本地 YAML task scheduler 不应恢复；如需离线 workspace task，以新的 CLI 设计另行加入。
5. task 并发边界是 task 记录本身；同一 task running/queued 时不要叠加执行。

## 插件模型

1. 插件系统先保持轻量 contribution hub：读取本地 plugin dir，汇总 Web styles 和 integration metadata。
2. Telegram 是内建 integration plugin；没有 token 时插件可列出但 runtime 为未配置/未启动。
3. 主题/CSS 是 Web contribution plugin。外部插件 CSS 通过 `/api/plugins/:pluginId/assets/*` 服务。
4. 不执行外部 JS，不把 SSH 强行改造成插件 runtime。需要新增 channel/input/output 时，先用 integration metadata + 明确 server 适配层。

## Web / Electron / Docker

1. Web 继续复用现有对话展示：右侧以 thread records 为准，左侧按 machines/projects/sessions 展示。
2. Web 本地选择状态使用 `activeSessionId`；兼容读取旧 localStorage 可以做迁移，但新写入不能再用 `activeWorkerId`。
3. Docker 镜像运行 server/Web/API，默认 `CODEX_HUB_LOCAL_MACHINE=0`，由宿主机或远端通过 registered/ssh machine 接入 runtime。
4. Electron 只包装同一个本机 server 和 Web UI。默认尝试 `127.0.0.1:18788`，未显式指定端口且被占用时可 fallback 到空闲端口。

## 发布和验证

1. 本地默认端口是 `8788`；生产由 `codexhub server` 启动，PM2 进程名为 `codexhub-prod`。
2. 发布脚本必须先 `pnpm check`、`pnpm build`，再重启 PM2 并验证 `/api/health` 和 `/`。
3. 关键验证命令：

```bash
pnpm check
pnpm run smoke:machine-session
pnpm run smoke:registered-machine
pnpm run smoke:ssh-loopback
pnpm run smoke:task-lock
pnpm run smoke:electron
pnpm build
```

4. `smoke:machine-session` 覆盖 local machine、project open、session/thread `/status`、server-local task、plugin CSS、SSH 参数构造和旧 worker registration 拒绝。
5. `smoke:registered-machine` 覆盖真实 `codexhub machine --type registered` CLI、项目打开、runtime session/thread 对话流和正常 unregister lifecycle。
6. `smoke:ssh-loopback` 覆盖真实本机 sshd、`ssh -R` reverse tunnel、远端 `codexhub machine --type ssh`、项目打开、runtime session/thread 对话流和断开 lifecycle。
7. `smoke:task-lock` 覆盖同一 task queued/running 时的并发跳过，以及 turn 完成后的重新运行。
8. `smoke:electron` 覆盖 Electron main process 启动内嵌 server、默认端口占用 fallback 和 `/api/health`。
