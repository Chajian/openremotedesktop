# OpenRemoteDesktop 的 AI 项目管理规范

本文件面向 Codex、Claude 和开发者，规定如何在 OpenRemoteDesktop 的真实 GitHub 工程中接手、开发和验收。它不是 TokenHub 规范，也不替代 [根规则](../AGENTS.md)、[系统架构](architecture.md)、[安全模型](security.md) 或 [仓库敏感信息防护](repository-security.zh-CN.md)。

## 一、唯一规则源与入口

- AI 工程约束只维护根目录 `AGENTS.md`。Codex 直接读取它；Claude 通过同层 `CLAUDE.md` 的 `@AGENTS.md` 引入同一份约束。
- `docs/agent.md` 是产品工作站 Agent 的使用手册，不是给 AI 编程助手的指令文件，名称相近但职责不同。
- 对特定任务，只补充读取目标模块代码、协议、现有测试和必要的设计文档，不全文加载历史计划。若现有代码、规格和部署记录不一致，以当前源码与可复现证据区分「已实现」「计划」「待验收」。

## 二、架构边界

| 模块 | 归属 | 核心风险与验收 |
| --- | --- | --- |
| Server：`apps/server/` | OAuth/GitHub 登录、授权、Dashboard、租户隔离、SQLite 和转发 | Token/CSRF、跨账号授权、设备撤销、敏感日志 |
| Agent：`apps/agent/` | 配对、受保护凭据、出站 WSS、Desktop Commander 子进程、重连 | 跨平台运行、进程清理、重复执行、READY 状态 |
| Protocol：`packages/protocol/`、`packages/shared/` | 客户端和服务端共享消息契约 | 类型、兼容性、协议/超时、错误语义 |
| Adapter：`packages/desktop-commander-adapter/` | 上游 Desktop Commander 与 MCP 工具清单 | 锁定版本、工具映射、实时 stdio 兼容 |
| 发布：`scripts/`、`.github/workflows/`、`docker/` | npm Agent 包、安装脚本、镜像与部署 | 签名/校验、安装升级、回滚、跨平台 CI |

安全底线：只有已授权 READY 设备执行请求；跨账号访问拒绝；断线后已发送的操作不能自动重试；正常日志不记录工具参数/正文/凭据。公开仓库禁止写入真实个人设备、内网信息和生产密钥。

## 三、需求到交付：一项任务对应一个 Issue

使用 [.github/ISSUE_TEMPLATE/ai-task.md](../.github/ISSUE_TEMPLATE/ai-task.md) 创建可执行工单，记录「目标、非目标、受影响模块、验收条件、证据、阻塞和当前切片」。需要长周期设计或跨模块取舍时，再在 `docs/superpowers/specs/`、`docs/superpowers/plans/` 保存一份有明确状态的规格或实施计划，并从 Issue 链接；不按每轮对话生成计划副本。

推荐的阶段依次为：Triage（澄清）→ Ready（可实施）→ In progress（独立 Worktree 开发）→ Review（PR 与 CI）→ Verified（实际证据）→ Done（按授权合并/交付）。遇到证据不足则标记 Blocked/Unverified，不得把某个测试通过推断为整体发布成功。

## 四、多人、多 AI 和跨会话恢复

每个并行任务使用单独的分支与 Worktree，避免 Claude、Codex 或远程开发者同时在同一工作目录修改。开工前核对 `git status --short --branch`、当前 HEAD、既有 Worktree，保留所有不属于本任务的修改。

结束会话或移交给另一个 AI 时，在原 Issue（或当前 PR）更新简短状态卡，记录：

1. 当前主线：具体问题及最终交付目标。
2. 当前切片：下一项可执行的小变更，不能只写“继续优化”。
3. 已完成：精确提交、代码/文档变更和真正跑过的验证。
4. 下一步：最近一个动作及其验收判断。

同时注明未解决问题、工作区路径、真实测试环境、未验证范围和所需人工授权。**不要把聊天上下文或模型“记忆”作为唯一任务记录**。

## 五、验证分层

| 类型 | 首选检查 | 不能替代 |
| --- | --- | --- |
| 规则/文档 | `pnpm governance:check`、链接检查、`git diff --check`、仓库秘密扫描 | 模型实际加载规则的实测 |
| TypeScript / Protocol | `pnpm typecheck`、`pnpm test:run` | Server/Agent 联通后的真实设备状态 |
| MCP/多设备/权限 | `pnpm test:e2e`、跨用户拒绝和撤销测试 | 生产 OAuth、真实 VPS 的稳定性 |
| Agent、安装包、更新 | 三平台 `agent-smoke.yml`、安装和包内依赖检查 | 真正的用户级 Windows/macOS 安装、配对、READY、升级/回滚 |
| 生产发布 | 已有 CI、秘密扫描、Release 与镜像校验、部署回执 | 人工操作批准或真实回退演练 |

`EXECUTION_UNKNOWN` 表示调用可能已经执行，必须先检查设备实际结果再决定如何恢复；不能让自动化无条件重放写文件、终止进程或清理目录等命令。

## 六、PR 和 CI 门禁

提交 Pull Request 时使用 [PR 模板](../.github/pull_request_template.md)，清楚列出改动范围、兼容/安全风险、验证命令和实际结果、未验证边界、回滚策略以及关联 Issue。根目录的 `pnpm governance:check` 被纳入现有 `.github/workflows/ci.yml`，这是**可执行的静态项目文档/模板门禁**，不意味着 CI 可以强制模型思考遵守规则。

主干保护、必过检查和 CODEOWNERS 等 GitHub 仓库设置必须由仓库管理员在平台上实际配置和核对，不宣称仅提交 YAML 就完成了保护；推送、合并、生产部署与 npm 发布仍遵守既有授权要求。

## 七、维护原则

每一类事实只认一个来源：规则在 `AGENTS.md`，系统细节在架构/协议/安全手册，开发任务在 GitHub Issue，评审与测试在 PR/CI，真实运行证据在对应任务或现有部署记录。纠正过时结论应更新权威文档并保留可追溯来源，不复制一套 TokenHub 的文档树。
