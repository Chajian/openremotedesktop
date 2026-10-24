# Agent npm 的 GitHub Actions 发布流程

此项目的 npm 包是能操作本地文件和执行命令的远程 Agent，**npm 只允许 staged publishing，不直接自动公开发布**。GitHub Releases 可由已验证的版本标签自动创建，两种发布相互独立。

## 现有工作流

- `ci.yml`：push / PR 的基础测试、类型检查、E2E 和 Docker 构建。
- `agent-smoke.yml`：Windows、macOS、Linux 的 Agent 与 npm 安装包冒烟验证。
- `npm-agent-release.yml`：PR 或手动运行时仅验证；匹配 `agent-v*` 的标签触发跨平台验证、npm 暂存发布，以及带附件的 GitHub Release 自动创建。

发布工作流会在三种系统验证打包及 25 个 Desktop Commander 工具，然后在 Ubuntu 上完整测试并通过 npm OIDC 提交暂存包。批准操作仅能在 npm 账号内由本人执行。另一个独立任务从经过验证的 npm tarball 生成 GitHub Release 附件并发布 GitHub Release，不绕过 npm 审核。

## 配置 npm Trusted Publisher

**先将工作流提交到新 GitHub 仓库的默认分支，再到 npm 配置 Trusted Publisher。** 仓库迁移后应为 `openremotedesktop` 新增 GitHub Actions 可信发布关联，并撤销不再使用的旧仓库关联。npm 包名仍是 `open-desktop-remote-agent`，无需新建 npm 包。

登录 `openremotedesktop`，打开 https://www.npmjs.com/package/open-desktop-remote-agent/access 的 **Settings → Trusted Publisher**：

| 字段 | 填写值 |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `Chajian` |
| Repository | `openremotedesktop` |
| Workflow filename | `npm-agent-release.yml`（只填文件名） |
| Environment name | 留空 |
| Allowed actions | 只允许 `npm stage publish`；不允许 `npm publish` / `npm dist-tag` |

配置 GitHub 工作流中的 `permissions: id-token: write` 仅授予暂存任务；无需向仓库添加任何 `NPM_TOKEN` Secret。

## 首次验证及后续发行

1. 将本分支合并到 GitHub 的 `master` 后，打开 GitHub → Actions → `Agent npm staged release` → Run workflow；这是**只验证、不发布**的安全测试。
2. `open-desktop-remote-agent@0.1.0` 已在 npm Registry 公开发布。新 GitHub 仓库不迁移旧版本的 Release/Tag，不需要为 `0.1.0` 重复创建标签或暂存发布。
3. 新版本从 `master` 修改：`node scripts/set-agent-version.mjs 0.1.1`（示例），提交这些改动并运行测试。
4. 新版本代码合并进入 `master` 后，从该提交创建标签 `agent-v0.1.1` 并推送：

```bash
git checkout master
git pull --ff-only
git tag agent-v0.1.1
git push origin agent-v0.1.1
```

5. GitHub Actions 自动验证标签版本和 `master` 提交关系，通过后创建带下载附件的 GitHub Release，并执行 `npm stage publish --access public`。如果同版本已经正式发布到 npm（例如 `0.1.0`），则跳过重复暂存。
6. 如果是新 npm 版本，在 npm → Staged Packages 审查包名、版本及内容，并用本人 Passkey 点击 Approve，才会正式发布到 Registry。
7. 在 npm Registry 验证发布版本并在干净 Windows/macOS 上完成真实配对及 READY 测试后，才可启用 `ODR_AGENT_INSTALL_ENABLED=true`。

GitHub Actions 不能替你批准暂存包；这是有意保留的发布安全门槛。

## 自动生成的 GitHub Releases

标签 `agent-v0.1.1` 会在通过验证后自动创建 `Open Desktop Remote Agent 0.1.1` 的公开 GitHub Release，不需要在仓库右侧手工点击“Create a new release”。随 Release 自动附上：

- `open-desktop-remote-agent-0.1.1.tgz`：跨平台 npm 包（不包含 Node 运行时和完整 npm 依赖树）。
- `install-windows.ps1` 与 `install-macos.sh`：当前用户权限的轻量安装脚本。
- `README-INSTALLATION.txt`：安装说明及独立 npm 批准提醒。
- `SHA256SUMS.txt`：以上文件的 SHA-256 校验值。

GitHub Release 和 npm Registry 的发布日期可能不同。**在新版本通过 npm 人工批准之前，默认安装脚本可能暂时无法安装相应版本**；下载包仍可用于审核。

### 补建已有标签的 GitHub Release（不重新发布 npm）

如果某个 `agent-vX.Y.Z` 标签的 GitHub Release 自动创建失败，不要删除或者强制移动已发布的版本标签。
合并修复后的工作流到 `master`，打开 GitHub → Actions → `Agent npm staged release` → `Run workflow`，
从默认分支运行，并在可选的 `release_tag` 输入框填写**新仓库中已经存在**的标签（例如未来的 `agent-v0.1.1`）。
验证任务会读取该标签对应的源代码、重建 tarball，随后仅补建 GitHub Release。
手动运行不会执行 `npm stage publish`；留空 `release_tag` 时只执行跨平台验证。
Release 附件会从验证任务上传的 tarball 中提取版本元信息，而不是依赖另一个任务的临时构建目录。

所有附件来自 CI 已验证的 Ubuntu npm 包产物，GitHub Release 任务只获得 `contents: write` 权限；npm 暂存任务才获得 `id-token: write`。标签必须已存在、版本与包一致、提交属于 `master`，已存在的 Release 不会被覆盖。

新仓库以不带旧提交历史和旧 Release Tag 的全新 `master` 初始化。`agent-v0.1.0` 仅属于旧 GitHub 仓库，不应跨仓库复制或重新触发；首次新仓库发布请在 Trusted Publisher 绑定完成后使用 `agent-v0.1.1` 或更高版本。

## 安全注意事项

- 操作发布之前检查 GitHub 工作流确实来自 `Chajian/openremotedesktop`，而不是其他仓库或 fork。
- 版本号来自生成包的 `package.json`；发布标签必须与其严格一致，版本不匹配会失败。
- 标签对应的提交必须已在 `origin/master` 上，不允许直接从个人功能分支进行发布。
- GitHub PR 只测试；手动 Run workflow 不执行 npm 暂存，留空版本时只测试，填写已有 `release_tag` 时只补建 GitHub Release；只有新推送的 `agent-v*` 标签才会尝试 npm 暂存。
- 不允许在 Actions 中保存 npm 密码、Passkey、OTP、恢复码或长期发布 Token。
- 不要把本机现有的 Agent 身份、用户 `.env` 和生产服务器密钥上传到 GitHub。

参考：
- https://docs.npmjs.com/trusted-publishers/
- https://docs.npmjs.com/staged-publishing/
- https://docs.npmjs.com/policies/dual-use/
