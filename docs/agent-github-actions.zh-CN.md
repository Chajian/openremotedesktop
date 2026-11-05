# Agent npm 的 GitHub Actions 发布流程

此项目的 npm 包是能操作本地文件和执行命令的远程 Agent，**npm 只允许 staged publishing，不直接自动公开发布**。GitHub Releases 可由已验证的版本标签自动创建，两种发布相互独立。

## 现有工作流

- `ci.yml`：push / PR 的基础测试、类型检查、E2E 和 Docker 构建。
- `agent-smoke.yml`：Windows、macOS、Linux 的 Agent 与 npm 安装包冒烟验证。
- 该工作流在原生 macOS/Linux 使用 `node --test scripts/posix-support-launcher.test.mjs` 执行实际生成的协助包装脚本，无需安装 Server 工作区。测试使用本地下载和安装器替身，检查两种下载源的参数、退出码、摘要拒绝、邀请失效及临时文件清理，并断言本机用例全部执行；不代表真实联网安装或设备 READY 验收。
- `npm-agent-release.yml`：PR 或手动运行时仅验证；匹配 `agent-v*` 的标签触发跨平台验证、npm 暂存发布，以及带附件的 GitHub Release 自动创建。

发布工作流会在三种系统验证打包及 25 个 Desktop Commander 工具，然后在 Ubuntu 上完整测试并通过 npm OIDC 提交暂存包。批准操作仅能在 npm 账号内由本人执行。另一个独立任务从经过验证的 npm tarball 生成 GitHub Release 附件并发布 GitHub Release，不绕过 npm 审核。

安装包验证包含两个互补步骤：`scripts/smoke-packaged-agent.mjs` 直接检查安装后的上游依赖和 25 个工具契约；`scripts/smoke-packaged-agent-runtime.mjs` 启动实际安装后的 Agent CLI，经过 runtime、Relay、ExecutorManager 和自有 stdio 传输层，验证握手版本、工具目录哈希、READY、一次只读工具调用，以及正常退出时直接子进程的物理关闭。第二项使用临时目录、合成凭据和 loopback 服务；仅测试进程通过 preload 隔离原生 Keyring，不读取真实用户凭据。

POSIX 夹具发送真实 SIGTERM；Windows 夹具通过私有测试 IPC 进入 CLI 已有的停止回调，再检查相同的资源释放结果。这不代表 Windows 强制终止信号具有 POSIX 的优雅退出语义。夹具的异常兜底清理会使测试失败，不能代替 Agent 自己的正常关闭。上述包级验收接入现有三平台工作流，不能代替真实用户安装、配对、升级或生产验收。

Agent 发行版本的唯一来源是 `apps/agent/src/version.json`。Relay 握手中的 `agentVersion` 和生成的 npm 包版本读取同一份数据；`node scripts/set-agent-version.mjs X.Y.Z` 同时更新该数据、Windows/macOS/Linux 安装脚本及 Server 安装器版本。内部工作区包的 `0.0.0` 不作为发行版本。

macOS/Linux 安装器的公共维护源是 `scripts/install-posix.template.sh`；平台专属段使用 `# @if macos` / `# @if linux` 与 `# @endif` 标记（不嵌套），少量平台常量在 `scripts/generate-posix-installers.mjs` 中。修改模板后运行 `node scripts/generate-posix-installers.mjs`，并提交生成的 `scripts/install-macos.sh` 和 `scripts/install-linux.sh`。两份产物仍为完整独立脚本，安装时无需下载或加载模板。版本更新命令会读取更新后的 `version.json` 重新生成脚本；不要手工修改生成文件。

`node scripts/generate-posix-installers.mjs --check` 只检查字节一致性；产物过期或缺失时失败，不改写文件。回归入口为 `node --test scripts/posix-installer-generation.test.mjs scripts/installer-release.test.mjs`。Release 组装在清空输出目录前也会检查一致性，随后复制已审查脚本并重新计算 `SHA256SUMS.txt`；Server 和 Docker 继续使用同一批生成文件。

本次准备 Agent `0.1.6` 候选版本，支持带邀请的 Windows 下载启动文件：双击自动安装并连接，无需输入协助码或 YES，前台显示权限说明并保留 Ctrl+C 撤销。复用已有安装器、下载校验、可选 npmmirror 加速和停止清理流程。继续使用 Desktop Commander `0.3.1`，不覆盖已发布版本。准备版本号不代表 npm 已公开发布或线上入口已开启；`ODR_AGENT_INSTALL_ENABLED` 和 `ODR_SUPPORT_ENABLED` 保持默认关闭。

临时协助支持 Windows、macOS 和 Linux：发起者登录创建邀请，被协助者无需登录，在邀请页选择系统和官方源或 npmmirror 加速源。Windows 下载 `.cmd` 后双击；macOS 下载 `.command`、Linux 下载 `.sh`，按页面提示使用 Bash 运行。普通命令行仍要求输入 `YES`；0.1.6 起下载启动文件通过显式 `--accept-support` 将运行文件作为开始协助的动作，页面和窗口均说明完整远程权限。POSIX 安装器使用独立的 `OpenRemoteSupport` 目录，前台运行，不读取或保存普通设备凭据、不安装服务。发布后将 `ODR_SUPPORT_AGENT_VERSION` 指向已公开且已验证的精确版本；三个平台的下载启动、READY、真实工具调用及双方结束协助的验收仍需单独完成。自动化测试不能替代实机验收。

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
2. 先查询 npm Registry，确认候选版本尚未公开；已发布版本不能被覆盖，也不能因包名和版本相同就跳过内容核验。
3. 新版本从 `master` 修改：`node scripts/set-agent-version.mjs 0.1.6`（本次候选），提交这些改动并运行测试。打包后可只读运行 `node scripts/check-agent-publication.mjs` 检查版本可用性。
4. 新版本代码合并进入 `master` 后，从该提交创建标签 `agent-v0.1.6` 并推送：

```bash
git checkout master
git pull --ff-only
git tag agent-v0.1.6
git push origin agent-v0.1.6
```

5. GitHub Actions 自动验证标签版本和 `master` 提交关系，通过后创建带下载附件的 GitHub Release，并执行 `npm stage publish --access public`。新标签验证和暂存前都会查询公开 npm Registry：只有明确的 HTTP 404 表示版本可用；已发布版本、认证/限流/服务端错误、网络失败和超时均阻止暂存。即使已发布元数据看似相同，也不把它当作本次 tarball 内容相同的证据。
6. 如果是新 npm 版本，在 npm → Staged Packages 审查包名、版本及内容，并用本人 Passkey 点击 Approve，才会正式发布到 Registry。
7. 在 npm Registry 验证发布版本并在干净 Windows/macOS/Linux 上完成真实配对及 READY 测试后，才可启用 `ODR_AGENT_INSTALL_ENABLED=true`。Linux x64/ARM64 的安装、无桌面配对和重连需分别验收；WSL 夹具或 `--install-only` 不代替真实配对。

GitHub Actions 不能替你批准暂存包；这是有意保留的发布安全门槛。

新标签工作流在版本已经公开后重跑会明确失败，不再静默跳过 npm 暂存后继续发布另一份同版本产物。只需补建已有标签的 GitHub 下载时，使用下方 `release_tag` 手动流程；该流程不检查“尚未发布”，也不执行 npm 暂存。普通 PR 运行预检的离线测试，不依赖 Registry 可用性。

## 自动生成的 GitHub Releases

标签 `agent-v0.1.1` 会在通过验证后自动创建 `Open Desktop Remote Agent 0.1.1` 的公开 GitHub Release，不需要在仓库右侧手工点击“Create a new release”。随 Release 自动附上：

- `open-desktop-remote-agent-0.1.1.tgz`：跨平台 npm 包（不包含 Node 运行时和完整 npm 依赖树）。
- `install-windows.ps1` 与 `install-macos.sh`：当前用户权限的轻量安装脚本；包含 Linux 安装器的新版本还附上 `install-linux.sh`。
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
