# 多用户隔离与 GitHub 登录（试验性）

此文档适用于 `feature/multiuser-github-auth-20261010` 分支。它改造自单 Owner 的 Open Desktop Remote V1；尚未进行真实 GitHub 授权或线上升级验收。

## 安装与启用

1. **先完整备份**原有 SQLite 数据库和配置，并在测试环境验证恢复。启动新版 Server 会自动执行 V5 数据迁移。
2. 在 GitHub Developer Settings 创建 OAuth App，Application callback URL 精确设置为 `https://你的域名/auth/github/callback`。GitHub 回调依赖稳定的 HTTPS 公网域名；若使用每次重启可能换域名的 Cloudflare Quick Tunnel，需同步更新 OAuth App 回调地址，建议改用稳定域名。
3. 服务端环境变量设置 `ODR_GITHUB_CLIENT_ID`、`ODR_GITHUB_CLIENT_SECRET`。二者都必须设置；均为空时 GitHub 登录入口不可用。
4. Docker Compose 已透传上述两个变量；将值填进仅由服务端管理员可读取的 `.env`，不要放进仓库或客户端。
5. 以服务器配置的 `ODR_PUBLIC_BASE_URL` 为准打开 `/dashboard/login`，选择“Sign in with GitHub”。
6. 在电脑上启动 Agent 获取配对短码，在已登录的个人 Dashboard 手动输入短码批准设备。后台不再公开列出全站待认领短码。

**不要直接对当前生产实例执行 `docker compose up` 以尝试本功能；先备份并测试升级。**
## 身份与权限边界

- 现有本地 Owner 仍使用原有口令，历史设备在迁移时归属此 Owner。
- GitHub 账号按稳定数字 ID 映射成独立本地用户；不会继承 Owner 的设备、管理口令或 MCP 授权。
- GitHub 仅负责浏览器登录。GitHub access token 不会直接当成 MCP bearer token，也不会持久化保存。
- 用户批准 ChatGPT 等客户端时，OAuth 授权以 `(client_id, user_id)` 为单位保存。撤销一个用户的授权不会撤销其他用户对同一客户端的授权。
- Dashboard 和设备 API 的设备列表、改名、撤销操作按用户限制。MCP 的设备列表、状态查询、自动路由和远程工具均由经过验证的令牌所属用户限制。
- 新配对设备在审批事务中归属批准者；用户必须持有 Agent 上的短码。待审批短码不对全站账户公开。
- 本地 Owner 口令修改仅属于旧 Owner，GitHub 账号不显示该表单；“Sign out”只注销当前浏览器会话。
- 对携带错误 Origin 或 Sec-Fetch-Site 的浏览器跨源 API 请求做拒绝处理，但这**不能代替**完整的请求速率限制和纵深 CSRF 防护。

## 限制与上线门槛

- 当前只支持 github.com 的 OAuth App 登录（非 GitHub Enterprise Server）。
- 尚未验证真实 GitHub OAuth App 凭据和公网回调，仍需预发布环境联调。
- 服务器仍能看见工具输入和结果，Agent 仍以启动它的系统账户权限执行；用户隔离不等于操作系统或容器沙箱。
- 尚未引入组织、共享设备、管理员邀请/封禁、速率限制、完整审计和端到端密钥管理。
- 启用 GitHub 登录即允许有效 GitHub 账户在此实例注册个人账户；如需限制注册范围，必须先实现明确的准入策略。
## 验收建议

从两个不同 GitHub 账号分别登录：各自配对不同电脑，确认 Dashboard/API/MCP 不泄漏设备名称和 ID；让账号 A 显式指定 B 的设备 ID 读取文件，应返回 `DEVICE_NOT_FOUND`，不能触发 Agent 操作；让 A 撤销所有设备，不应影响 B。然后让两个账户批准相同 MCP 客户端注册记录，撤销 A 的批准后 B 仍应可用。验证 GitHub 回调一次性 state、错误浏览器 nonce、过期尝试和退出登录。

本地检查：

```powershell
pnpm typecheck
pnpm test:run
pnpm test:e2e
```

注意：首次启动会更新 SQLite schema。若要回退到旧版，必须使用升级前备份的数据库，不能仅回退代码。
