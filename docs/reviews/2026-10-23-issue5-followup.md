# Issue #5 — Code Review Follow-up（2026-10-23）

- 分支：`fix/issue5-code-review-followup-20261023`
- 评审基线：`f2f126f`
- 范围：OpenRemote 自身的操作恢复与执行器生命周期；不修改 Desktop Commander 上游实现。
- 发布：本次验收用于 PR Code Review；创建 PR 不等于主分支合并或生产发布。

## 已修复

### 1. 发送前拒绝留下 Legacy 内存关联
- 提交：`c3bd693`
- 修复：`PreDispatchRejectedError` 同时清除旧协议关联和数据库元数据。
- 验证：1,000 次容量拒绝均未发出命令，数据库和内存无关联残留。
- 边界：已经尝试发送的请求仍保持 `EXECUTION_UNKNOWN`，不会自动重放。

### 2. SQLite 记录失败覆盖原始操作错误
- 提交：`42a1de9`
- 修复：持久化异常与原始调用错误分离；尽可能保留 `operationId`，并记录持久化失败事件。
- 验证：`markUnknown`、发送前清理及日志记录器异常故障注入。
- 边界：SQLite 持久化失败不代表持久化成功；读回仍以现有恢复证据为准。

### 3. 执行器重启时的双进程/状态提前发布风险
- 提交：`ca371d5`
- 修复：旧进程关闭失败即拒绝创建替代实例；重启等待失效的启动流程完成关闭。
- 服务器状态通知：仅在旧执行器关闭之后报告 `EXECUTOR_STARTING`，随后完成初始化才报告 `READY`。
- 验证：并发启动、关闭拒绝、启动中失效、Watchdog，以及真实 Server 状态机端到端恢复。

### 4. 额外评审发现的重复 FAILED 状态导致 Relay 断线
- 提交：`d3d8487`
- 复现：在旧执行器 close() 失败时，Agent 连续发送两次 `EXECUTOR_FAILED`，Server 拒绝重复转换并关闭 Relay（4400）。
- 修复：只对同一 Relay 会话发送实际变化的状态；不放宽 Server 状态机规则。
- 验证：新增真实 MCP / WebSocket 故障注入 E2E，证明关闭失败后保持连接、不接受新命令、不重复执行。

## 验证结果

| 检查 | 结果 |
|---|---|
| Node 24 + pnpm 10 工作区 TypeScript `typecheck` | PASS |
| Protocol / Shared / Tool Contracts | 93 / 10 / 3 项 PASS |
| Server（含真实 SQLite 迁移、故障注入） | 276 项 PASS |
| Desktop Commander Adapter（含子进程关闭确认） | 3 项 PASS |
| Agent（含重启并发与错误状态恢复） | 106 项 PASS |
| 单元及集成测试总数 | **491 项 PASS** |
| MCP + Relay + Agent 端到端 | **15 项 PASS** |
| 上游边界检查 | 58 项 PASS，249 个原始发布文件验证通过 |
| AI 治理结构检查 | 14 项 PASS |
| `git diff --check` | PASS |
| macOS 15.3.1 arm64 / Node 24.21.0 (`d3d8487`) | TypeScript + 491 项单元/集成 + 15 项 E2E PASS |
| macOS 本地 Agent 打包与安装 | `pnpm agent:package`、`verify-agent-release`、`npm pack`、隔离前缀 `npm install`、CLI 和 26 工具 smoke PASS |

Windows 测试主机和隔离的 Ubuntu WSL2 / Node 24 环境完成验证，Windows 原生 Desktop Commander 进程关闭测试通过。
最终代码已在 macOS arm64 测试主机（macOS 15.3.1）完成校验，在独立 QA 源码副本中完成 TypeScript、SQLite、Agent、Server、Adapter 和全量 E2E；未替换 Mac 上已安装的 Agent。
Windows 原生 SQLite 编译仍缺少 Visual Studio C++ 工具链；macOS / WSL2 的 SQLite 集成测试均通过。

## 风险与约束

- **不重放命令**：不确定执行结果返回 `EXECUTION_UNKNOWN`，不得自动重新调用产生副作用的工具。
- **关闭失败时选择可用性下降**：无法确认旧进程退出时不创建新进程；同一 Agent 实例维持不可接单状态，需要人工排查。这是防止双进程的权衡。
- **10 分钟硬看门狗**：原有默认行为可能打断合法长耗时任务；此修复不改变该产品策略，需按具体任务评估或配置 `stalledOperationTimeoutMs`。
- **SQLite 持久化故障**：保留调用方可用的 operationId / 执行错误，并记录持久化失败事件；不代表保证故障期所有恢复查询都可成功。
- **平台验收**：Windows、Linux/WSL2、macOS arm64 原生测试及 npm 独立安装 smoke 已覆盖；不是线上服务器和生产 Agent 灰度验收。
- **npm 依赖告警**：隔离 `npm install` 出现 `glob`、`rimraf` 等已弃用间接依赖，以及 3 个包的安装脚本提示；真实 CLI/26 工具及原始文件校验仍通过。此类告警目前作为非阻断项保留，后续单独管理依赖升级。
- **上游界线**：未修改 `@wonderwhy-er/desktop-commander@0.2.52`，不引入额外进程管理器、队列或协议升级。
- **发布/合并**：本次验收用于 PR 阶段，合并 `master` 与生产发布仍需单独授权。

## 审核结论

原定三个问题均已通过故障注入与回归验证；追加的重复 FAILED 状态缺陷由真实 E2E 先复现、再修复。
最终代码 `d3d8487` 在 macOS arm64 上通过 491 项单元/集成及 15 项 E2E，并保持 Desktop Commander 原版不变。
合并前建议复核四个独立修复提交；本次没有执行主分支合并或生产发布。
