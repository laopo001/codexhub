# Surface、Machine、Workspace、Project 与 Thread 边界

本文定义 CodexHub 中 UI surface、执行 machine、workspace、project、thread 和
`workingDirectory` 的权威语义。实现、协议、持久化、恢复逻辑和测试都必须遵守这些边界。

## 核心结论

`workingDirectory` 是 thread 的执行 cwd，不是 project identity，也不是 workspace identity。

- project identity 只有 `machineId + path`；
- workspace 是一个 surface 提供的 project path 集合，可以包含零个、一个或多个 paths；
- surface 拥有该 UI 文档中显式打开的 thread tabs；
- machine 提供执行环境和文件系统命名空间；
- thread 由某台 machine 的 app-server runtime 承载，`workingDirectory` 只描述执行上下文；
- thread 与 project/workspace 的 UI 归属必须来自显式上下文，不能由
  `thread.workingDirectory === project.path` 推导。

## 关系图

```text
Execution authority
├── Machine A ── 0..1 Runtime ── 0..N Threads
│   ├── Project target (Machine A, /repo/a)
│   ├── Project target (Machine A, /repo/b)
│   └── Thread T
│       └── workingDirectory = execution cwd
└── Machine B ── 0..1 Runtime ── 0..N Threads

UI document / window
└── Surface S
    ├── workspace scope
    │   ├── project target (Machine A, /repo/a)
    │   └── project target (Machine A, /repo/b)
    ├── active project selection (optional UI state)
    └── explicitly open thread tabs [T1, T2, ...]
```

Machine 和 surface 不是父子实体：machine 是执行边界，surface 是观察与交互边界。
一个 authority 可以服务多个 surfaces；多个 surfaces 可以观察同一 machine/runtime/thread。
嵌入式 surface 注册 workspace 时会引用一台 machine，但这不把 surface 变成 machine，也不让
workspace 拥有 runtime。

## 概念与身份

### Authority

Authority 是当前执行环境内的 CodexHub server/control plane。它拥有 machine registry、runtime
投影、project catalog、task/config 和 embedded surface leases。Windows、每个 WSL distro、Remote
SSH host/user 和容器是不同 authority，不应合并 identity。

### Machine

Machine 是路径解析、目录/文件读取和 Codex app-server 执行的边界。

- 稳定身份：`machineId`；
- 文件路径只在对应 machine 的文件系统命名空间内有意义；
- 一台在线 machine 最多承载一个公开 runtime；
- runtime 可以同时承载不同 cwd 的多个 threads；
- machine 不拥有 UI tabs，也不拥有 workspace layout。

### Surface

Surface 是一个 Web UI 文档或宿主窗口的交互上下文。

- 普通 Web、VSCode WebView 和 Electron renderer 都是 surface；
- embedded surface 使用 `surfaceId + leaseId` 注册临时窗口 lease；
- `surfaceId` 标识当前窗口代次，稳定 UI 恢复 scope 应使用 `stateScope`/workspace identity；
- surface 拥有 active tab、open tabs、draft、对话订阅等页面状态；
- surface 可以观察同一 authority 下的 machines/runtimes，但不能成为 runtime authority；
- host 只负责提供浏览器无法自行获得的 workspace/SCM/原生能力，Web 仍是 tab 恢复状态机的 owner。

### Workspace

Workspace 是 surface 提供的工作上下文，而不是 project 的别名。

- VSCode 单文件夹窗口通常提供一个 path；
- VSCode multi-root workspace 提供多个 `workspacePaths`；
- Electron 或普通 Web 可以没有宿主 workspace；
- workspace identity 可以由 workspace file 或规范化 folder set 形成稳定 `stateScope`；
- `activeWorkspacePath` 只是 workspace 内的当前 UI 选择，不是完整 membership；
- workspace 的 project targets 是 `workspacePaths.map(path => { machineId, path })`；
- 一个 project target 可以同时出现在多个 surfaces/workspaces 中。

### Project

Project 是 control-plane 中的路径元数据。

- 唯一身份：`machineId + path`；
- `projectId` 由该组合推导；
- project 不拥有 runtime、session、thread 或 transcript；
- project path 是 machine 上的一个可启动/浏览路径；
- workspace 可以引用多个 projects；
- thread 可以在 UI 中从某个 project 打开，但这种来源关系需要显式记录，不能由 cwd 反推。

### Thread

Thread identity 来自官方 Codex app-server 的 `threadId`。

- thread 由 machine runtime 承载；
- app-server 是 transcript、turn 和 item 的权威来源；
- thread 不由 project 或 surface 持有；
- 多个 surfaces 可以订阅同一个 thread；
- surface tab 只是该 surface 对 thread 的显式引用。

### workingDirectory

`workingDirectory` 是 thread/turn 的执行 cwd 或恢复 app-server thread 时使用的 cwd hint。

它可能：

- 恰好等于一个 project path；
- 位于某个 project path 的子目录；
- 是 workspace root 或 workspace 表示路径；
- 对应一个包含多个 project paths 的 workspace 上下文；
- 在旧 snapshot 中缺失，随后仅为一个已显式保存的 thread ID 从 app-server candidate 补齐。

因此禁止把 `workingDirectory` 当成：

- project ID；
- 唯一 project path；
- workspace ID；
- surface membership；
- “这个 tab 是否属于当前 VSCode 窗口”的证明。

## 合法与非法推导

| 输入 | 可以推导 | 不可以推导 |
| --- | --- | --- |
| `machineId` | 执行/文件系统命名空间 | 当前 surface、project 或 workspace |
| `machineId + project.path` | 唯一 project target | thread ownership |
| surface registration | 当前 workspace scope 与全部 project targets | machine runtime ownership |
| exact surface tab snapshot | 该 surface 重启前显式打开的 thread IDs | 全部历史 threads |
| `threadId + machineId` | 要查询/恢复的明确 thread target | project identity |
| `workingDirectory` | app-server 执行 cwd/hint | project、workspace 或 surface membership |
| `workspacePaths` | workspace 引用的 project targets | thread 的 cwd |

路径包含关系、basename、唯一匹配或“当前只有一台在线 machine”都不能升级为 identity 规则。
它们最多用于展示或有明确降级标识的搜索建议。

## UI 归属与打开动作

### Surface project membership

VSCode/Electron host 注册完整 workspace paths；authority 将每个 path 投影成一个 project target，
并用 surface identity/group 保留其 workspace 来源。侧边栏 workspace project group 由该注册集合决定，
不能只看 active path。

### Authority open-thread sidebar

侧栏的 Open threads 汇总当前 authority 下所有已连接窗口显式打开的 thread，包含 local、SSH 和 registered machines。
共享 Web 通过现有 `/api/events/ws` 的 `set_open_threads` 上报当前窗口的 tab 集合；authority 用 `open_threads` 推送按 `machineId + threadId` 去重的并集。
窗口关闭或连接断开只撤销该连接的集合；其他窗口仍打开的条目继续保留。重连重新上报当前集合，旧连接关闭不会撤销新连接的集合。

这是 transient 控制面投影，不写入 config 或改变任何窗口的 tab snapshot，也不通过 runtime 历史、cwd 或 project 关系推断打开状态。
点击跨窗口条目时，在当前窗口显式打开该 thread，并携带来源 machine、cwd hint 和存在时的 explicit project target。

### Surface thread-tab membership

一个 thread tab 属于 surface 的条件是：它由该 surface 显式打开，或存在于该 surface 的精确、
版本化 tab snapshot 中。

如果 UI 需要知道 tab 从哪个 project 打开，应在动作边界记录可选的：

```ts
type ProjectTarget = {
  machineId: string;
  path: string;
};
```

这个 `ProjectTarget` 是 UI routing metadata，不进入 app-server thread identity，也不替换
`workingDirectory`。历史 thread 没有显式 project target 时应保持“未解析”，不能猜测。

### Active project selection

Active project 是 surface-local UI state。它决定 Add Thread、thread picker 和文件浏览的默认
project target，但不能更改已经打开 thread 的 machine、cwd 或 transcript ownership。

## Thread 创建与恢复

### 创建

1. surface 选择明确的 `ProjectTarget { machineId, path }`；
2. Web 调用对应 machine thread API，并把 `path` 作为新 thread 的初始 cwd；
3. app-server 返回 `threadId` 和真实 cwd；
4. surface 把 `threadId` 加入自己的 open tabs，并可保留打开动作的 `ProjectTarget`；
5. 后续 app-server 返回的 `workingDirectory` 仍只是执行状态，不反向改写 project identity。

### Authority replacement 后恢复

1. 从当前 surface/state scope 读取版本化 exact tab snapshot；
2. 只使用 snapshot 中真实 `openThreadIds`，不得加入 pending IDs、thread order、candidates 或历史列表；
3. 每个 tab target 至少保留 `threadId + machineId`，`workingDirectory` 仅作为 resume cwd hint；
4. surface membership 来自 exact snapshot/scope，不能再用 cwd 与 project paths 的相等关系过滤；
5. thread detail 暂不可用时，只为该显式 thread ID 执行 bounded retry/resume；
6. 成功打开后才把 tab 写回新的 snapshot；
7. inactive tab 仍需加载 canonical detail 和订阅，但不能抢走用户后来选择的焦点。

Legacy snapshot 若无法证明 surface scope 或 open-set 语义，应丢弃 tab metadata，仅保留普通 UI 偏好。

## State ownership

| 状态 | Canonical owner |
| --- | --- |
| machine identity/capability | machine registry |
| filesystem/path validation | 对应 machine |
| runtime online/status/catalog | machine app-server runtime projection |
| project identity | control plane 的 `machineId + path` |
| embedded workspace paths | host producer + authority surface lease |
| surface open/active tabs | shared Web document + versioned per-surface snapshot |
| thread transcript/turn/items | official app-server |
| thread execution cwd | app-server thread detail/summary |
| optional tab origin project | surface-local explicit action metadata |

## 当前实现

当前 producer 已支持多 project workspace：

- VSCode URL 发送全部 `workspaceFolder`；
- embedded surface registration 保存全部 `workspacePaths`；
- authority 为每个 workspace path 投影一个同 surface group 的 project；
- Web 能列出同一 surface 的多个 projects。

当前 consumer 已按本模型完成解耦：

- `src/web/appEffects.ts` 直接持久化当前 surface 的显式 open set，不再按 cwd/project path 过滤；
- `src/web/appActions/realtimeActions.ts` 直接恢复 exact snapshot，并保留首次失败后的 document-lifetime retry target；
- `src/web/helpers/surfaceThreadScope.ts` 只负责 workspace project catalog 和显式 `ProjectTarget` 比较；
- `src/web/appSelectors.ts` 和 active-thread selection 只用显式 project target 建立 project-specific 选择；
- Add Thread、project thread picker、project bootstrap 等明确入口传递可选 `ProjectTarget`；
- generic machine picker、外部 thread ID 和未知历史 thread 不会从 cwd 生成 project target；
- persisted `openThreadTargets` 保留 `machineId + workingDirectory` 执行坐标，并以可选
  `projectTarget` 保存明确的 UI 来源；
- realtime 长连接通过同步 ref 读取最新 project target，ref 不成为第二状态真源；
- close、失败 rollback、non-retryable restore 和 retry exhaustion 都清理对应的 surface-local metadata；
- embedded completion/registered activity 路由使用显式 project target，而不是 workingDirectory membership。

### Activity 与完成通知点击路由

Activity 和完成通知同时携带两个相互独立的可选路由字段：

```ts
type ProjectTarget = { machineId: string; path: string };
type WorkspaceTarget = {
  machineId: string;
  kind: "vscode" | "electron";
  groupId: string;
  workspacePaths: string[];
  workspaceFile?: string;
  vscodeChannel?: "stable" | "insiders";
  label?: string;
};
```

`ProjectTarget` 只表示明确的项目来源；`WorkspaceTarget` 表示完整的宿主 workspace 上下文，不能用
`ProjectSource` 或 `workingDirectory` 替代。Pet、stream completion、task completion 和 registered
activity 只有在对应生产路径拥有显式 target 时才生成这些字段；未知来源保持 unresolved。

Electron desktop Pet 与 Electron native completion notification 是跨宿主入口：

1. 先按 `WorkspaceTarget.kind` 选择 Electron surface 或 VSCode workspace；
2. VSCode 优先使用合法 `workspaceFile`；没有 workspaceFile 时只允许唯一 workspace path；
3. 多根 workspace 没有可证明的同 workspace CLI 恢复能力，或 target unresolved/launch 失败时，
   Electron desktop Pet 与 native notification 都安全回退到 Electron thread；
4. 再使用可选 `ProjectTarget` 选择项目。

Project-only、workingDirectory-only 或旧的 source/path payload 不能启动 VSCode workspace。已有 VSCode
窗口收到 notification 时只在当前窗口 focus/open thread；若 workspace target 不属于当前窗口则安全忽略并提示，
不得跨 workspace launch。

`tabSnapshotVersion: 1` 保持兼容；`projectTarget` 是 additive optional metadata。已有 v1 exact open set
不会因为升级而丢失，unversioned snapshot 仍丢弃 tab metadata。Task 配置自身携带显式
`projectPath`；task picker 中按 cwd 查询历史候选只作为该显式 project 的候选检索，不建立新的
thread/project identity。

## 已采用的迁移顺序

1. 建立共享 `ProjectTarget`、surface workspace scope 和 surface tab target；
2. 将 tab membership 从 cwd/path equality 改为 exact surface open-set/scope；
3. persistence/restore 只使用显式 surface tab membership，保留 cwd 作为 resume hint；
4. 在明确的 project 动作边界携带 project target，generic/unknown 入口保持 unresolved；
5. 将 project-specific selectors、projection 和 embedded notification routing 迁到显式 target；
6. 删除 `threadIdsForSurfaceProjects()` 的旧 membership 语义和重复 matcher；
7. 保持 v1 snapshot 兼容，以 optional additive field 承载 project origin；
8. 保留 `activeWorkspacePath` 作为过渡期 UI 选择字段，不再赋予 membership 含义。

## 验收矩阵

至少覆盖：

- 单文件夹 workspace：cwd 等于 project path；
- multi-root workspace：一个 surface 有 A/B 两个 project paths；
- workspace-level cwd：cwd 不等于 A 或 B，tab 仍按 exact surface snapshot 恢复；
- nested cwd：cwd 位于 A 子目录，不能因此创建新的 project identity；
- 两台 machines 上相同 path：必须由 machineId 隔离；
- 两个 surfaces 引用同一 project：project 可共享，tab open/active state 相互独立；
- authority replacement 初次 resume 失败：snapshot 被正常写空后，document-lifetime target 仍能重试；
- workspace scope 改变：不能从旧 scope 恢复 tabs；
- legacy/unversioned snapshot：不恢复 tabs；
- candidates：只能补一个已显式保存 thread 的 cwd，不能扩张 open set；
- project association 缺失：保持 unresolved，不使用唯一 path/machine/history 猜测。

任何只用单一 `workingDirectory === project.path` fixture 的测试，都不足以证明 workspace/surface
归属正确。
