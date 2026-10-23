# Issue #5 — Code Review Follow-up（2026-10-23）

- 分支：`fix/issue5-code-review-followup-20261023`
- 评审基线：`f2f126f`
- 范围：OpenRemote 自身的操作恢复与执行器生命周期；不修改 Desktop Commander 上游实现。
- 发布：未执行远程推送、主分支合并或生产发布。

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
- 修复：旧进程关闭失败即拒绝创建替代实例；重启等待失效的启动流程完成关闭。
- 服务器状态通知：仅在旧执行器关闭之后报告 `EXECUTOR_STARTING`，随后完成初始化才报告 `READY`。
- 验证：并发启动、关闭拒绝、启动中失效、Watchdog，以及真实 Server 状态机端到端恢复。

## 验证结果

| 检查 | 结果 |
|---|---|
| Node 24 + pnpm 10 工作区 TypeScript `typecheck` | PASS |
| Protocol / Shared / Tool Contracts | 93 / 10 / 3 项 PASS |
| Server（含真实 SQLite 迁移、故障注入） | 276 项 PASS |
| Desktop Commander Adapter（含子进程关闭确认） | 3 项 PASS |
| Agent（含重启并发与错误状态恢复） | 106 项 PASS |
| 单元及集成测试总数 | **491 项 PASS** |
| MCP + Relay + Agent 端到端 | **14 项 PASS** |
| 上游边界检查 | 58 项 PASS，249 个原始发布文件验证通过 |
| AI 治理结构检查 | 14 项 PASS |
| `git diff --check` | PASS |

主要在 Windows 测试主机及隔离的 Ubuntu WSL2 / Node 24 环境验证。
Windows 实际的 Desktop Commander stdio 子进程关闭并确认 PID 消失的集成测试通过。
WSL 实测 SQLite 可运行；Windows 原生 SQLite 编译仍因缺少 Visual Studio C++ 工具链无法完成。

## 风险与约束

- **不重放命令**：不确定执行结果返回 `EXECUTION_UNKNOWN`，不得自动重新调用产生副作用的工具。
- **关闭失败时选择可用性下降**：无法确认旧进程退出时不创建新进程；同一 Agent 实例维持不可接单状态，需要人工排查。这是防止双进程的权衡。
- **10 分钟硬看门狗**：原有默认行为可能打断合法长耗时任务；此修复不改变该产品策略，需按具体任务评估或配置 `stalledOperationTimeoutMs`。
- **SQLite 持久化故障**：保留调用方可用的 operationId / 执行错误，并记录持久化失败事件；不代表保证故障期所有恢复查询都可成功。
- **平台验收**：Windows 与 Linux/WSL2 已覆盖；基于当前提交的 macOS 原生构建与功能回归尚未执行，标记 NOT_RUN。
- **上游界线**：未修改 `@wonderwhy-er/desktop-commander@0.2.52`，不引入额外进程管理器、队列或协议升级。
- **发布/合并**：截至本次 Review 仅本地分支，未合并 `master`、未推远端、未发布生产。

## 审核结论

本轮三个问题已由先失败的定向回归测试验证，修复后目标测试及 Linux 全量验证通过；
状态机跨层联动由新的真实 WebSocket / MCP E2E 覆盖。
合并前仍建议执行 macOS 原生候选版本的验收，并独立审阅第三个提交。
