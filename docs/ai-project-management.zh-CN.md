# OpenRemoteDesktop 的 AI 项目管理规范

本文件面向 Codex、Claude 和开发者，规定如何在 OpenRemoteDesktop 的真实 GitHub 工程中接手、开发和验收。它不替代 [根规则](../AGENTS.md)、[当前仓库架构](architecture.md)、[安全模型](security.md) 或 [仓库敏感信息防护](repository-security.zh-CN.md)。

## 一、唯一规则源与入口

- AI 工程约束只维护根目录 `AGENTS.md`。Codex 直接读取它；Claude 通过同层 `CLAUDE.md` 的 `@AGENTS.md` 引入同一份约束。
- `docs/agent.md` 是产品工作站 Agent 的使用手册，不是给 AI 编程助手的指令文件，名称相近但职责不同。
- 对特定任务，只补充读取目标模块代码、协议、现有测试和必要的设计文档，不全文加载历史计划。**代码、文档与线上状态的证据分开判断**：当前分支的实现以源码/测试为准；旧 specs/plans 仅提供设计背景；生产状态必须以实际 VPS 镜像、运行配置、Dashboard 和服务验证为准。
- [架构总览](architecture.md) 已对齐本仓库中的传统 Owner 与 GitHub 多用户模式；[早期多用户说明](multi-user-github.zh-CN.md) 带有历史分支/未验收前提，不能推导出当前代码没有多用户，也不能推导出该能力已上线。

## 二、架构边界

| 模块 | 归属 | 核心风险与验收 |
| --- | --- | --- |
| Server：`apps/server/` | OAuth/GitHub 登录、授权、Dashboard、租户隔离、SQLite 和转发 | Token/CSRF、跨账号授权、设备撤销、敏感日志 |
| Agent：`apps/agent/` | 配对、受保护凭据、出站 WSS、Desktop Commander 子进程、重连 | 跨平台运行、进程清理、重复执行、READY 状态 |
| Protocol：`packages/protocol/`、`packages/shared/` | 客户端和服务端共享消息契约 | 类型、兼容性、协议/超时、错误语义 |
| Adapter：`packages/desktop-commander-adapter/` | 上游 Desktop Commander 与 MCP 工具清单 | 锁定版本、工具映射、实时 stdio 兼容 |
| 发布：`scripts/`、`.github/workflows/`、`docker/` | npm Agent 包、安装脚本、镜像与部署 | 签名/校验、安装升级、回滚、跨平台 CI |

安全底线：只有已授权 READY 设备执行请求；跨账号访问拒绝；断线后已发送的操作不能自动重试；正常日志不记录工具参数/正文/凭据。公开仓库禁止写入真实个人设备、内网信息和生产密钥。

**现有生产兼容门禁**：部署文档记录了 VPS/Nginx 与现有 Server 数据库，但实际部署基线必须先核实运行镜像与配置，不能用仓库 Caddy 示例直接替换。双域名共用原有 OAuth Issuer，但 `/mcp` 的资源受众必须按实际可信来源匹配；保留旧域名登录、刷新令牌和设备身份。发布前对照 [双域名部署与回滚](dual-domain-github-mcp.zh-CN.md) 检查线上 UI、OAuth 与 Agent 实际状态；本地编译通过不代表线上已更新。

## 三、按复杂度管理任务：Issue 按需使用

小修复、局部重构与普通文档更新可以直接在独立工作分支处理，通过 commit/PR 记录结果，不要求先建公开 Issue。跨会话、多人并行、复杂故障或需要公开追踪的任务才使用 [GitHub Issue 模板](../.github/ISSUE_TEMPLATE/ai-task.md)；不能因为缺少 Issue 就拒绝修复。与社区公开讨论无关的私有部署信息、设备标识和日志不可写入公开 Issue。

重大跨模块设计或复杂实施使用已有 `docs/superpowers/specs/` 与 `docs/superpowers/plans/`，注明设计/已实施/待验证状态；必要时由 Issue/PR 链接，避免每次对话生成相同计划的副本。无论是否创建 Issue，都要明确目标、非目标、变更边界和验收标准。

推荐的阶段依次为：Triage（澄清）→ Ready（可实施）→ In progress（独立 Worktree 开发）→ Review（PR 与 CI）→ Verified（实际证据）→ Done（按授权合并/交付）。遇到证据不足则标记 Blocked/Unverified，不得把某个测试通过推断为整体发布成功。

## 四、多人、多 AI 和跨会话恢复

每个并行任务使用单独的分支与 Worktree，避免 Claude、Codex 或远程开发者同时在同一工作目录修改。开工前核对 `git status --short --branch`、当前 HEAD、既有 Worktree，保留所有不属于本任务的修改。对于无需并行的短任务，不强制创建第二个 Worktree，但不得覆盖未提交内容。

结束会话或移交给另一个 AI 时，在现有 Issue、PR 或当前任务的受版本管理计划中更新简短状态卡（无须创建专用会话文档），记录：

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

## 六、PR、CI 与 Agent 发布门禁

提交 Pull Request 时使用 [PR 模板](../.github/pull_request_template.md)，清楚列出改动范围、兼容/安全风险、验证命令、未验证边界和回滚策略；关联 Issue 仅在存在时填写。根目录的 `pnpm governance:check` 已纳入 `.github/workflows/ci.yml`，检查项目规则文件、文档引用、模板与 CI 入口的结构，不校验任意关键术语，更不证明模型已经执行规则。

**Agent Release Gate**：相关改动需要三平台 Agent Smoke 和打包检查。正式发布必须遵守 [npm staged publishing 审批流程](agent-github-actions.zh-CN.md)：从已审核的 `master` 版本提交创建 `agent-vX.Y.Z` 标签；自动阶段只提交 npm 暂存并经人工 2FA 审核。Agent 包、Server 发布的安装脚本及安装器展示版本必须可追溯并相互兼容；`ODR_AGENT_INSTALL_ENABLED` 在对应版本正式上架、脚本/摘要验证和干净 Windows/macOS 配对达到 READY 前维持关闭。详见 [一键设备接入发布门禁](one-command-onboarding.md)。

主干保护、必过检查和 CODEOWNERS 等 GitHub 仓库设置必须由仓库管理员在平台上实际配置和核对，不宣称仅提交 YAML 就完成了保护；推送、合并、生产部署与 npm 发布仍遵守既有授权要求。

## 七、维护原则

每一类事实只认一个来源：规则在 `AGENTS.md`，系统细节在架构/协议/安全手册，必要的公共任务在 GitHub Issue，评审与测试在 PR/CI，真实运行证据在对应任务或现有部署记录。纠正过时结论应更新权威文档并保留可追溯来源，不为同一任务另建第二份进度总表。
