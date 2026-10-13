# OpenRemoteDesktop 仓库敏感信息防护

此仓库是公开项目。请只提交源码、测试及可公开的示例配置；**不提交任何真实密钥、设备令牌、数据库、运行日志或私有部署记录**。

## 本地开发环境

首次克隆仓库后，在仓库根目录执行：

```bash
pnpm security:hooks
pnpm security:scan
```

- `pre-commit` 扫描 **Git 暂存区（index）的实际内容**，避免未提交但被强制 `git add -f` 的密钥文件进入提交。
- `pre-push` 扫描 **全部本地可达 Git 历史**，包括已经删除但仍存在于旧提交中的数据。
- `pnpm security:scan` 同时执行上述两类扫描；脚本仅输出路径和风险种类，不输出命中的凭据内容。
- `.gitignore` 忽略本地机密，`.dockerignore` 排除 Docker 构建上下文中的机密与运行数据。

## 敏感信息的存放

- 本机 `.env`、任何 `.env.*`（`.env.example` 除外）、`.npmrc`、`.ssh/`、`id_ed25519`、`*.pem`、`*.p8`、`*.pfx` 等由 `.gitignore` 忽略。
- 测试数据库、SQLite WAL、`*.db`、`*.sqlite`、`*.jsonl`、日志、安装打包文件和备份目录不允许提交。
- 私人设备上线脚本、个人主机信息、VPS 运维材料保留在仓库外或单独的受限目录。
- `.env.example` **只能放无效的示例值**，不能用真实密钥代替示例。
- 本地密钥库或凭据回退文件必须限制操作系统文件权限。

## CI 和历史

GitHub Actions 的 CI、Agent Smoke 和 npm 发布验证均执行历史/暂存检查，拉取完整历史后检查每个可达提交中的内容。独立的 `Secret hygiene` 工作流额外使用 Gitleaks v3 检测更多格式，并每天定时复核；检测报告不会作为含敏感内容的公开 Artifact 上传。仅通过最新文件扫描不足以清除旧提交。

需要注意：`.gitignore` **不能保护已经纳入 Git 跟踪的内容，也不能阻止 `git add -f`**。本地 Hook 可以被 `--no-verify` 绕过，因此仍需服务端 PR/Secret Scanning Push Protection 等门禁。

## 若误提交了敏感数据

1. 停止发布，按密钥所属服务立即撤销或轮换凭据；仅删除文件并不能使泄露密钥失效。
2. 在**私有备份**留档后用 `git filter-repo` 等工具清理相关提交；覆盖已推送历史前协调所有参与者。
3. 复查 GitHub PR 引用、Fork、Release、Actions 日志、缓存及任何打包资产；必要时联系 GitHub Support。
4. 重新从远程克隆仓库，对所有分支与 Tag 执行历史扫描，再恢复正式发布。

这些扫描使用启发式规则，不能证明未知格式的秘密 100% 不存在。提交前仍应人工检查变更，并使用 GitHub Secret Scanning / Push Protection 等平台防护。
