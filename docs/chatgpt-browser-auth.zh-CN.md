# ChatGPT 浏览器授权与本机测试链路

## 本次修复

OAuth 未登录请求现在跳转到实际存在的 `/dashboard/login`，完整保留原始授权请求。
登录表单仅接受允许的站内回跳地址，并使用登录随机数与 CSRF 校验。
已登录用户必须在确认页核对客户端 ID、回调地址与权限，再明确允许或拒绝。
确认表单的 CSRF 绑定当前会话和原始授权请求，防止请求参数被替换。
确认页的 Content Security Policy 仅允许站内表单和已验证客户端的回调来源。
登录与授权页面不缓存、不发送 Referer，并禁止被其他网站嵌入。

## 验证边界

新增回归测试覆盖登录回跳、CSRF、外站跳转拒绝、授权参数替换、拒绝授权、PKCE 令牌交换及刷新令牌。
原有 OAuth 与端到端测试已改为主动提交确认页，不再依赖静默授权。
本机公网测试通过 HTTP 登录与确认表单获取令牌，不直接往数据库写入访问令牌。
这仍不等于当前 ChatGPT 账号已经完成插件安装；最后的账号界面授权必须单独确认。

## 当前电脑的保留测试环境

运行数据与操作脚本在 `.superpowers/local-link/`，被 Git 忽略，目录权限限制为当前 Windows 用户与 SYSTEM。
`state.json` 记录当前公网 URL、服务状态和进程号，不包含密码。
`acceptance.json` 记录最后一次公网验证结果，明确区分 HTTP 验证和 ChatGPT UI 接入。
`owner-password.txt` 保存该测试环境单独生成的 Owner 密码，请勿发送到聊天或提交 Git。
Agent 使用独立的系统凭据项；不可用时才退回该受限目录中的凭据文件。

在 Windows 中双击 `start.cmd` 可启动链路；双击 `stop.cmd` 会请求停止本次 ODR 服务及其隧道，不停止 T3 原有连接。
已运行时不要重复启动。启动脚本先检查端口、在本地完成 Owner 初始化，再建立公网入口，避免公开空白管理账户。
测试入口复用 T3 自带的 cloudflared 程序，但创建的是独立 Quick Tunnel，不使用或修改 T3 的账号凭据。

电脑睡眠、退出进程或重启会使此测试入口不可用。重新创建 Quick Tunnel 后 URL 会变化，需要更新 ChatGPT 中的连接。
Quick Tunnel 仅用于测试，不能视为固定域名或生产服务。Cloudflare 明确不保证其可用性，也不支持 SSE；必须以当前客户端的实际调用结果为准。

## 在 ChatGPT 中添加

以当前界面为准：开启开发者模式后，在 Plugins 的加号入口添加自定义 MCP；旧版界面可能显示 Apps / Create。
连接 URL 使用 `state.json` 中的 `mcpUrl`，认证选择 OAuth。
完成 Owner 登录后核对授权页显示的客户端回调地址，只批准自己刚刚在 ChatGPT 发起的连接。
工具扫描成功后，在新聊天的工具选择菜单中选中 Open Desktop Remote。
首次只调用 `list_devices` 和读取测试文件，不对真实工作文件做写入操作。
是否能在普通 Chat、Work 或特定工作区使用，还需按账号实际提供的入口验收。

## 参考

- OpenAI 接入说明：https://developers.openai.com/plugins/deploy/connect-chatgpt
- OpenAI MCP 应用帮助：https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- Cloudflare Quick Tunnel 限制：https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/


## 追加：创建 MCP 连接时显示 denied access

已复现并修复的兼容性问题：

- DCR 不应仅因请求携带 client_name、client_uri 等标准可选描述字段就返回 400。未使用的描述字段和扩展字段现在会被丢弃，不持久化，也不会被当作客户端身份或凭证。
- 注册仅申请 authorization_code 的客户端也是有效输入。省略 grant_types 时默认 authorization_code；仅在显式请求 refresh_token 时注册刷新能力。
- 首次未携带 Authorization 的请求返回标准 Bearer 授权发现挑战，不再标为 invalid_token；已提供但无效的令牌仍被拒绝。
- 根路径与 /mcp 专用路径均提供资源发现文档，文档的规范资源标识始终为 /mcp，没有放宽 audience 校验。

诊断开关：ODR_AUTH_DIAGNOSTICS=true。默认关闭。开启后仅输出允许列表中的路由模板、方法、HTTP 状态、标准错误码及是否带 Authorization，不输出其值、Cookie、查询参数、工具参数或响应正文。

操作界面要选择公网 URL 连接和 OAuth。当前实现使用 DCR 公共客户端，因此无需人工填写客户端 ID 或 Secret；这与把整体认证改为 None 是不同的概念。
Cloudflare Quick Tunnel 不是 OpenAI Secure MCP Tunnel 的 tunnel_id，不应填写到平台的 Tunnel ID 输入框。

验证仍须区分：独立 MCP 测试客户端通过公网授权成功，不代表 ChatGPT 产品界面已经完成连接。诊断记录可用于下一次实际尝试定位失败步骤。

协议参考：
- https://www.rfc-editor.org/rfc/rfc7591 （动态客户端注册）
- https://www.rfc-editor.org/rfc/rfc6750#section-3.1 （首次未认证请求的挑战）
- https://developers.openai.com/plugins/build/auth
