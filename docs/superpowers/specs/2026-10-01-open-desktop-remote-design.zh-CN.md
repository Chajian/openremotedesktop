# Open Desktop Remote — 设计规范（中文版）

日期：2026-10-01
状态：会话中的设计方案已通过；书面规范待审核
暂定名称：Open Desktop Remote
目标许可证：Apache-2.0

## 1. 目标

构建一个完全开源、可自托管的 Desktop Commander Remote 云端部分替代方案，同时保留相同的核心工作模式：AI 客户端可以安全地连接到某个所有者的远程电脑，选择目标设备，并在该设备上调用 Desktop Commander 工具。

项目不得依赖维护者的账号、服务器、人工批准或任何强制性的第三方 SaaS。具备一定技术能力的用户必须能够克隆仓库，在自己的 VPS/域名上部署服务端，配对自己的电脑，连接 ChatGPT 或其他兼容标准 MCP 的客户端；即使本项目维护者停止维护，用户也仍然可以继续运行自己的部署。

OpenAI 或用户选择的其他模型提供商，可以按 AI 工作流的需要接收任务数据。自托管服务器属于可信计算边界的一部分。本项目要移除的是 Desktop Commander 官方运营的额外云端服务这一可信方。

## 2. 核心成功标准

一个新用户仅按照仓库 README，就能够：

1. 在 Linux 上通过 Docker Compose 和公网 HTTPS 域名部署一套服务端。
2. 创建唯一的 Owner 账号。
3. 在 Windows、macOS 或 Linux 工作电脑上安装/启动 Agent，而且无需开放任何入站端口。
4. 通过浏览器确认的短设备码流程完成该工作电脑的配对。
5. 使用 OAuth Authorization Code + PKCE，通过标准远程 MCP 将 ChatGPT 接入。
6. 通过 Desktop Commander 读取并修改一个测试文件。
7. 通过 Desktop Commander 启动并持续使用一个 shell/process session。
8. 再配对第二台电脑，并能明确地把工具调用路由到任意一台。
9. 可以分别撤销任意一台设备。
10. 上述全部流程都不需要访问本项目维护者运营的任何服务。

## 3. 范围

### V1 包含

- 单 Owner 的自托管部署。
- 每个 Owner 可配对多台设备。
- 面向 AI 客户端的标准 MCP Streamable HTTP endpoint。
- AI 客户端 OAuth 登录。
- Agent 使用类似 Device Authorization Grant 的设备配对。
- Agent 仅通过主动出站方式建立持久连接。
- 设备注册、改名、状态查看、单独撤销和全部撤销。
- 通过本地 stdio 子进程执行 Desktop Commander 工具。
- Windows、macOS、Linux Agent 支持。
- Linux/Docker 服务端支持。
- 最小化 Web Dashboard。
- SQLite 持久化。
- 使用 Caddy 的 Docker Compose 参考部署方案。
- 公开且带版本控制的 Agent ↔ Server 协议。
- 默认只记录元数据，不向第三方发送 telemetry。
- 自动化测试以及真实平台 smoke test。

### V1 明确不包含

- 多用户或多租户 SaaS。
- 团队权限和共享设备。
- 离线命令队列。
- 自动重放被中断的工具调用。
- 内置云文件存储或大文件中转服务。
- 自定义聊天 UI 或手机 App。
- 强制 Agent 自动更新。
- 插件市场。
- 通用的任意 MCP 托管平台。
- 高可用集群或水平扩容。
- 让自托管服务器也看不到 payload 的端到端加密。
- 重写 Desktop Commander 的文件系统、shell、process 等执行引擎。

## 4. 系统架构

系统划分为四个可以独立理解的边界：

1. **MCP Gateway** —— 对 ChatGPT/Claude/Cursor 暴露远程 MCP，并将工具请求映射到目标设备。
2. **Auth + Control Plane** —— Owner 登录、OAuth、设备配对、设备注册表、撤销、Dashboard 和 SQLite 状态。
3. **Relay Plane** —— 维护 Agent 的出站连接，并承载带版本的工具调用 RPC 消息。
4. **Agent** —— 向自托管服务端完成认证，保持 Relay 连接，管理本机 Desktop Commander stdio 进程，并在 Relay RPC 与本地 MCP stdio 之间进行桥接。

服务端永远不实现文件编辑、shell 执行、搜索、进程控制、PDF 处理或其他 Desktop Commander 业务逻辑。这些能力继续留在目标设备上的 Desktop Commander 内。

Agent 不需要知道上游 AI 客户端究竟是 ChatGPT、Claude、Cursor，还是其他 MCP 客户端。它只负责接收标准化 Relay 请求并返回标准化结果。

## 5. 仓库结构

实现采用 TypeScript monorepo：

```
open-desktop-remote/
  apps/
    server/
    agent/
  packages/
    protocol/
    desktop-commander-adapter/
    auth/
    shared/
  docs/
    protocol.md
    self-hosting.md
    security.md
    architecture.md
    superpowers/specs/
  docker/
  docker-compose.yml
  LICENSE
```

当前实现目标为兼容 Node.js 24 LTS 的 TypeScript。包管理默认使用 pnpm workspaces，除非实施阶段发现明确的技术阻塞。

## 6. 面向 MCP 客户端的行为

服务端通过 Streamable HTTP 暴露标准 MCP。

Desktop Commander 工具以一等 MCP Tool 的形式暴露，而不是隐藏在通用的 `call_tool(name,args)` 包装器后面。每个远程工具由 adapter 增加一个可选的 `deviceId` 路由参数。

路由规则：

- 如果提供 `deviceId`，只路由到该设备。
- 如果没有提供 `deviceId`，且只有一台设备处于 READY，则自动选择该设备。
- 如果没有提供 `deviceId`，且有多台设备处于 READY，则返回结构化的设备选择错误，其中包含可用设备的名称和 ID。
- 如果没有任何 READY 设备，则返回结构化 DeviceUnavailable 错误。
- 设备必须处于 READY，而不是仅仅 socket 已连接，才能接受新的工具调用。

Gateway 还暴露 `list_devices`、`get_device_status` 等控制工具。

## 7. Desktop Commander Adapter

V1 直接复用 Desktop Commander，将其作为本地 stdio MCP 子进程运行。

Agent 负责在需要时启动、监控并重启该子进程。服务器发生短暂断线时，本地 Desktop Commander 子进程保持存活，因此本地 Desktop Commander 的 process/session 状态不会仅仅因为网络断开而丢失。

为了在不重写 Desktop Commander 工具的前提下保持良好的 MCP 工具选择体验，adapter package 会携带一份根据锁定兼容版本 Desktop Commander 自动生成的工具 manifest。CI 会将该 manifest 与真实本地 `tools/list` 返回值进行比较；如果锁定版本发生不兼容变化，CI 必须失败。

在 Agent readiness negotiation 时，adapter 会记录并上报本机 Desktop Commander 版本和 capabilities。

## 8. 设备状态模型

“传输连接已建立”和“本地执行器已就绪”是两个不同概念。

标准状态：

```
OFFLINE
  -> CONNECTED
  -> AUTHENTICATED
  -> EXECUTOR_STARTING
  -> READY
```

额外的临时/错误状态可以包括 `REVOKED`、`INCOMPATIBLE` 和 `EXECUTOR_FAILED`。

只有 READY 设备才能接收新的工具调用。

服务端将持久化的设备身份和 last-seen 元数据存储在 SQLite 中。实时 socket 归属、未完成请求、heartbeat 时间戳和临时 readiness 状态只保存在内存中。

## 9. Agent ↔ Server 传输

Agent 主动向 Server 建立出站 WSS 连接。因此常规部署不需要为工作电脑开放入站端口，也不需要公网 IP、路由器端口转发、VPN 或 SSH 暴露。

所有公网 HTTP、OAuth、MCP、Dashboard 和 Relay 流量都可以通过参考反向代理共用 HTTPS 443 端口。

Relay 是有业务语义的应用层协议，而不是裸 TCP tunnel。V1 协议消息至少包括：

- `agent.hello`
- `agent.ready`
- `agent.executor_status`
- `heartbeat`
- `tool.call`
- `tool.result`
- `tool.error`
- `tool.cancel`
- `server.notice`

每条消息都携带协议版本。请求/响应消息携带全局唯一的 `requestId`；设备范围消息携带 `deviceId`。

Payload schema 放在 `packages/protocol` 中，并在 Server 和 Agent 两端同时校验。

## 10. 协议兼容性

初始协议版本为 `1`。

握手信息包括：

- Agent 支持的协议版本范围；
- Agent 版本；
- OS/platform；
- Desktop Commander 版本；
- adapter capabilities；
- device ID；
- Server 要求的最低协议版本。

如果无法协商出兼容版本，Server 将设备标记为 INCOMPATIBLE，并返回明确的升级错误，而不是让设备表现成“神秘离线”。

协议必须公开并有文档，使第三方未来可以实现自己的兼容 Agent。

## 11. 配对与设备凭证

首次设备配对采用受标准 Device Authorization 流程启发的机制：

1. Agent 请求一个临时 device code 和用户可读的 user code。
2. Agent 输出验证 URL 和短码。
3. Owner 登录自托管 Dashboard。
4. Owner 批准待配对设备，并可设置友好名称。
5. Agent 轮询直到批准或过期。
6. Server 下发设备 refresh credential。
7. Agent 优先将凭证保存在 OS credential store/keychain；不可用时保存到仅当前用户可读的本地文件。
8. Relay 连接使用短生命周期 access credential，并通过长期凭证刷新。

在可行的情况下，Server 端长期设备凭证只保存不可逆 verifier，而不是原始凭证。设备被撤销后，新的 Relay 认证必须立即失败。

## 12. AI 客户端 OAuth

自托管 Server 内置足够支撑单 Owner MCP 部署的 Authorization Server；Google、GitHub、Auth0、Supabase、Firebase 或其他 SaaS 身份服务都不是必需依赖。

MCP 客户端使用 OAuth Authorization Code + PKCE。Server 发布兼容标准 MCP 客户端需要的 metadata。在互操作确有需要时支持 Dynamic Client Registration。

Dashboard 登录和 OAuth consent 共用同一个单 Owner 身份。

Secret 在 bootstrap 时生成；生产部署必须拒绝已知默认 secret。

## 13. Owner Bootstrap

V1 只有一个 Owner。

首次部署时，操作者通过 README 中记录的 bootstrap 机制创建 Owner。初始化成功后，bootstrap 自动禁用，除非操作者从 Server 主机侧显式重置。

不存在公开用户注册 endpoint。

## 14. 请求投递语义

设计优先避免“意外重复产生副作用”。

系统**不宣称网络环境中实际上无法保证的 exactly-once 执行语义**。

替代方案：

- 每次工具调用都获得唯一 `requestId`。
- 如果某个调用已经被下发，而连接在结果确认前进入不确定状态，Server 绝不自动重放该调用。
- Agent 保留一个有边界的近期 request cache；如果再次收到完全相同且已经完成的 `requestId`，直接返回缓存结果。
- 如果请求已经下发，但结果确认之前连接断开，Server 将该调用标记为 `EXECUTION_UNKNOWN`。
- AI/客户端明确收到这个状态，并决定是否先检查实际状态，再决定是否重试。
- 重连绝不能让旧 shell 命令、文件编辑或 process 操作在无提示的情况下再执行一次。

V1 对所有 Desktop Commander 工具都采用这一保守策略，不尝试做不可靠的“读操作/写操作”自动分类。

## 15. 取消与超时

MCP Gateway 为每个 Relay 调用分配 deadline。

如果上游客户端取消请求且 Agent 仍在线，Server 发送 `tool.cancel`。取消是 best-effort，因为底层 OS 操作可能已经完成。

超时不代表回滚。

对于超时或在不确定断线状态下发生的变更操作，返回结果必须包含足够的结构化信息，让 AI 在再次执行之前先验证实际状态。

## 16. 重连行为

Agent 使用 exponential backoff + jitter 自动重连。

Relay 重连不需要重新配对设备，也不会自动重启本地 Desktop Commander 子进程。

Server 将重新认证成功的设备视为同一个 device ID。

未完成调用不会被盲目重放。已完成且仍在 Agent cache 中的 request ID 可以直接恢复结果；无法确认结果的已下发调用进入 `EXECUTION_UNKNOWN`。

Heartbeat 过期后，设备应迅速离开 READY 状态。

## 17. 本地执行器生命周期

V1 中，一个 Agent 管理一个本地 Desktop Commander stdio 进程。

进入 READY 必须满足：

1. Desktop Commander 进程成功启动。
2. MCP initialization 完成。
3. 工具发现/capability check 完成。
4. 版本/manifest 兼容性检查通过。

如果子进程异常退出，Agent 转入 EXECUTOR_FAILED/EXECUTOR_STARTING，并可按受限 backoff 策略重启。在恢复 READY 之前，新的远程工具调用必须被拒绝。

## 18. Server 持久化模型

V1 唯一必需数据库是 SQLite。

持久化表至少包括：

- owner/settings；
- MCP 互操作所需的 OAuth clients 和 grants；
- 已配对设备；
- 哈希化/verifier 形式的设备凭证；
- 设备名称和平台元数据；
- 撤销状态；
- 最小审计元数据配置。

临时工具 payload、文件内容、截图和 shell 输出默认不写入 SQLite。

## 19. 日志与隐私

默认日志可以包含：

- timestamp；
- request ID；
- device ID/name；
- tool name；
- duration；
- success/failure；
- 结构化 error class；
- connection/reconnect 事件。

默认日志不得包含工具参数、文件内容、截图、shell stdout/stderr 正文、access token、refresh credential 或 OAuth authorization code。

可以提供明确记录在文档中的 debug-payload 日志模式，但默认关闭，并且开启时必须明确警告可能暴露敏感工作数据。

默认不向项目维护者发送任何 telemetry。未来如加入 telemetry，必须由用户显式 opt-in。

## 20. 安全边界

自托管 Server 是可信的，可以看到传输中的 payload。TLS 负责保护网络传输；V1 不额外加入“让 Server 本身也无法读取 payload”的应用层端到端加密。

本地工具实际拥有的执行权限，就是运行 Agent/Desktop Commander 进程的 OS 用户权限。

项目不会声称 Desktop Commander 的目录配置等同于完整 sandbox。需要更强隔离的操作者，应让 Agent 运行在专用低权限用户、VM 或适合其工作负载的 container 中。

文档必须包含设备撤销和 Owner 凭证轮换流程。

## 21. Dashboard

Dashboard 刻意保持最小化。

必须支持的页面/操作：

- Owner 登录；
- 待配对设备批准；
- 设备列表；
- 修改设备友好名称；
- 显示状态、last-seen、版本；
- 单设备撤销；
- revoke all；
- MCP 连接说明；
- 基本的 Server/版本健康状态。

Dashboard 是管理界面，不是单独的终端用户聊天产品。

## 22. 部署

正式参考部署使用 Linux + Docker Compose。

参考 stack 包括：

- Open Desktop Remote Server；
- 持久化 SQLite volume；
- 用于 HTTPS 和反向代理的 Caddy。

应用本身不得依赖 Caddy 的专有行为，并记录 nginx/Traefik 兼容方式。

生产部署公网只开放 HTTPS/443。本地开发允许使用 localhost HTTP。

贡献者仍然可以直接运行非容器版 Server。

## 23. Agent 安装

V1 面向开发者，不要求图形化安装器。

目标 CLI 形态：

```
npx <package-name> agent connect --server https://remote.example.com
```

最终 package name 推迟到公开命名/仓库发布阶段决定。

V1 允许 Agent 前台常驻终端。原生 daemon/service 安装属于后续增强，不是 V1 验收要求。

## 24. 大数据行为

本项目不是大文件批量传输服务。

工具结果具有可配置的大小限制。面对大数据时，系统应优先使用路径、摘要、分块或专用文件工作流，而不是把数百 MB 内容直接塞进 MCP/model context。

V1 Server 不提供持久化云文件缓存。

## 25. 并发

多个 MCP 客户端可以同时连接到同一套单 Owner Server。

Relay 支持多个并发 request ID，不会把整台设备全局串行化。

文件系统/process 操作之间的冲突交由底层工具和 OS 语义处理。只有在真实故障证明有必要时，项目才增加有针对性的资源级控制。

## 26. 错误分类

跨边界返回的错误使用稳定、机器可读的错误码，至少包括：

- `DEVICE_NOT_FOUND`
- `DEVICE_OFFLINE`
- `DEVICE_NOT_READY`
- `DEVICE_REVOKED`
- `PROTOCOL_INCOMPATIBLE`
- `EXECUTOR_FAILED`
- `REQUEST_TIMEOUT`
- `REQUEST_CANCELLED`
- `EXECUTION_UNKNOWN`
- `TOOL_NOT_SUPPORTED`
- `TOOL_EXECUTION_ERROR`

错误码同时附带人类可读消息，但客户端不得依赖解析 message 文本来判断错误类型。

## 27. 测试策略

单元测试覆盖：协议 schema 校验、路由、设备状态转换、凭证校验、request 去重、超时/取消和日志脱敏。

集成测试使用 fake Agent 对接真实 Server，覆盖：配对、READY negotiation、工具调用、断线、重连、撤销和不确定投递。

Adapter 集成测试启动真实 Desktop Commander stdio 进程，并用实时 `tools/list` 验证生成的 tool manifest。

端到端测试验证完整链路：

```
MCP client -> server -> relay -> agent -> Desktop Commander -> result
```

Release smoke test 在 Windows、macOS 和 Linux 上运行 Agent。Server 参考部署在 Linux Docker 上验证。

安全测试必须确认：

- 未认证访问 MCP/Relay 会被拒绝；
- 已撤销设备不能重新连接；
- secret 会被脱敏；
- debug payload logging 默认关闭；
- 初始化成功后 bootstrap 不能再次使用。

## 28. 开源与生态契约

仓库必须包含运行整个系统需要的全部关键代码：

- server；
- agent；
- relay protocol；
- OAuth/设备配对；
- dashboard；
- database migration；
- Desktop Commander adapter；
- Docker 部署；
- 协议与自托管文档。

任何关键运行时能力都不得调用维护者掌控的 secret service。

协议文档与参考 Agent 实现相互独立，使第三方可以根据协议自己实现 Agent。

V1 使用 Apache-2.0。接受第三方在保留许可证声明并遵循 Apache 专利授权条款的前提下，基于本项目建立商业托管服务。

## 29. 版本管理

Server、Agent 和 Protocol 分别拥有独立版本。

发布 package 遵循 Semantic Versioning。

协议 breaking change 必须提升 protocol major version，并通过兼容性协商处理。实际可行时，Server 更新应至少兼容上一代协议，但 V1 不承诺无限期兼容旧协议。

Agent 可以检查并提示新版本，但 V1 不自动安装更新。

## 30. V1 验收清单

只有在全新环境中实际证明以下所有项目后，V1 才算通过验收：

- 用户可以只依靠公开仓库部署 Server，不依赖维护者服务。
- HTTPS 和 Owner bootstrap 正常工作。
- 与 ChatGPT 兼容的远程 MCP OAuth 成功。
- Windows Agent 无需开放入站端口即可完成配对并达到 READY。
- `list_devices` 正确显示设备状态。
- Desktop Commander 文件读取成功。
- 文件编辑成功。
- 可以启动并继续使用持久 shell/process session。
- 临时网络断开后，无需重新配对即可恢复。
- 已经下发但结果不确定的请求不会被静默重放。
- 第二台设备可以完成配对并能被明确指定为目标。
- 撤销其中一台设备后，该设备无法重新连接，而另一台设备继续正常工作。
- 默认 Server 持久化数据和日志中不包含工具 payload 正文。
- 另一位技术用户从 fresh clone 开始，只依靠 README 就能完整复现系统。

## 31. 延后决定的事项

以下内容明确不作为 V1 设计阻塞项：

- 最终公开项目名/package name；
- 官方托管 SaaS；
- 未来 major version 是否从 Apache 改为 AGPL；
- 图形化安装器；
- 后台系统服务安装器；
- 通用任意 MCP adapter；
- 插件市场；
- E2E payload 加密；
- 多 Owner 支持；
- HA 部署。

这些事项未来应分别进行独立设计，而不是偷偷塞进第一版范围。
