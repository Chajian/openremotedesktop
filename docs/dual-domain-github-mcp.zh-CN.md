# 双域名 GitHub 登录与 MCP 兼容上线

## 目标

保留一套 ODR Server、SQLite 数据库、GitHub OAuth App、OAuth Issuer。
旧域名 `https://www.xiaofenmao.xyz` 已在使用，不修改已存储的 OAuth 令牌和设备凭据。
新域名 `https://openremotedesktop.com` 允许 GitHub 登录和新的 MCP 授权。

## 线上环境配置

复用 VPS 原有 `docker-compose.vps.yml`，不要用仓库的默认 Caddy Compose 替换 Nginx。
在 **Server 容器** 环境变量中保留：

```dotenv
ODR_PUBLIC_BASE_URL=https://www.xiaofenmao.xyz
ODR_ADDITIONAL_PUBLIC_BASE_URLS=https://openremotedesktop.com
```

若使用 Compose 环境变量映射，需要确认第二项真正传入 `odr-server`。
不得仅修改 Windows 本地 `.env` 就认为 VPS 已生效。不要输出 GitHub 凭据。
## GitHub OAuth App 回调配置

在 GitHub Developer settings → OAuth Apps → 对应应用中保留旧回调，
并新增第二个回调（均使用精确匹配，不使用 wildcard）：

- `https://www.xiaofenmao.xyz/auth/github/callback`
- `https://openremotedesktop.com/auth/github/callback`

同一 GitHub Client ID / Client Secret 对应同一账号数据库。
GitHub 登录入口根据受信任的 Host 选择回调 URL；未经配置的 Host 不生效。
两域名浏览器 Cookie 自然隔离，新域名首次登录需要重新建立浏览器会话。

## MCP OAuth 模型

**OAuth 授权服务器 Issuer 永远保持旧地址**：
`https://www.xiaofenmao.xyz/`。

MCP 资源地址与访问域名匹配：
- 旧域名：`https://www.xiaofenmao.xyz/mcp`
- 新域名：`https://openremotedesktop.com/mcp`

新 MCP 的受保护资源元数据发布新 `resource`、旧 `authorization_servers`。
同一 OAuth 授权服务器允许发行两种资源受众的令牌，
但令牌必须匹配其访问的 MCP URL，不能跨域复用。
## 生产版本基线门禁（重要）

新干净仓库 `master` 与旧开发工作区（以及线上 Dashboard）存在源文件差异。
**不能只因为本分支的测试通过，就直接从新仓库重建整个 Server 并覆盖现有 VPS 容器**，这可能造成已上线 UI 或安装体验回退。

部署之前必须从 VPS 核实真实运行的镜像、源码版本及已发布 UI，先完成生产基线对齐。
优先把本次最小认证补丁移植到**当前生产实际源码基线**，独立构建、比较并验证 UI 路由，再替换 `odr-server`。
如生产代码与新仓库的修复分支尚未对齐，停止发布并说明差异；不要把未经评估的历史功能回退纳入域名迁移。

## 上线顺序和回滚

1. 先确认 GitHub OAuth App **两个回调均已注册**，保留原回调。
2. 保存现有 VPS Compose、Server 镜像 ID 和线上 SQLite 一致性备份。
3. 仅修改 VPS Server 的可选追加域名变量，构建经过测试的新 Server 镜像。
4. 仅更新 `odr-server`（不要重建 Nginx、删除数据库卷或修改 Nginx 规则）。
5. 检查旧、新域名 `/healthz`、`/readyz`、`/dashboard/login`。
6. 分别请求两域名 `/auth/github`，确认 `redirect_uri` 对应各自回调。
7. 验证新 `/mcp` 401 Bearer 挑战的元数据 URL 为新域名，
   其 `resource` 是新 MCP URL，Issuer 是旧域名。
8. 使用单独测试 OAuth 客户端完成新域名 PKCE 授权、令牌交换和 MCP 调用。
   再验证旧 ChatGPT MCP 授权、Windows/macOS Agent 长连接保持在线。
9. 如失败，仅恢复原 Server 镜像和容器环境变量，旧 OAuth Issuer 和 DB 不变；
   继续保留已运行的第二阶段 Nginx/TLS 新域名配置。

**不可声称线上 GitHub 完整登录和真实 ChatGPT MCP 验收通过，除非真实走完流程。**
Cloudflare 的 Full (strict) 需独立在控制台确认。
