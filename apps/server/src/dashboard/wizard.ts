import { escapeHtml } from "./templates.js";
import { installerInstructions, type InstallerOS } from "./installer.js";

export type AgentOs = InstallerOS | "linux";
export type WizardStep = 1 | 2 | 3;
export type WizardOptions = { os: AgentOs; step: WizardStep; baseUrl: URL; enabled: boolean; csrf: string; code?: string };
const colors = "--accent:#3355ff;--accent-bg:#eef1ff;--line:#e5e7ec;--gray:#667085;--text:#0e1116";
const css = [
":root{"+colors+"}*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--text);font:15px/1.6 'Segoe UI',-apple-system,'PingFang SC','Microsoft YaHei',system-ui,sans-serif}a{color:inherit;text-decoration:none}button,input{font:inherit}",
".wz{min-height:100vh;display:flex;flex-direction:column}.wz-top{height:68px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:15px;padding:0 28px;border-bottom:1px solid var(--line)}",
".brand{display:flex;align-items:center;gap:10px;font-weight:700;white-space:nowrap}.logo{width:32px;height:32px;border-radius:10px;background:linear-gradient(135deg,#647dff,#2442e0);color:#fff;display:grid;place-items:center}",
".steps{display:flex;gap:9px;align-items:center}.step{display:flex;align-items:center;gap:7px;font-size:13px;color:#848a98;white-space:nowrap}.step b{display:grid;place-items:center;width:26px;height:26px;border:1.5px solid #d7dbe2;border-radius:50%;font-size:12px}.step.active{color:#0e1116;font-weight:650}.step.active b{background:var(--accent);color:#fff;border-color:var(--accent)}.step.done b{background:#0e9454;color:#fff;border-color:#0e9454}.sep{width:23px;height:2px;background:var(--line)}",
".main{flex:1;width:100%;max-width:760px;margin:0 auto;padding:54px 28px 45px}h1{font-size:32px;line-height:1.2;letter-spacing:-.02em;margin:0}h3{font-size:17px;margin:4px 0 7px}p{color:#4a5161;margin:9px 0 15px}.right{justify-self:end}",
".btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 17px;border:1px solid transparent;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;background:#fff}.primary{background:var(--accent);color:#fff}.secondary{border-color:#d7dbe2}.muted{color:var(--gray)}.btn:hover{filter:brightness(.97)}",
".footer{position:sticky;bottom:0;border-top:1px solid var(--line);background:#fff;padding:15px 28px}.footer-inner{max-width:760px;margin:auto;display:flex;align-items:center;justify-content:space-between;gap:12px}",
".oss{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:30px 0}.os{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;border:1.5px solid var(--line);border-radius:18px;padding:24px 10px}.os.selected{border-color:var(--accent);box-shadow:0 0 0 4px var(--accent-bg)}.os:hover{border-color:#c7d0ff}.os-icon{width:54px;height:54px;background:var(--accent-bg);color:var(--accent);border-radius:16px;display:grid;place-items:center;font-size:28px}.os small{font-size:12px;color:#848a98}",
".note{padding:17px 19px;border:1px solid var(--line);border-radius:13px;background:#fafbfc;color:#4a5161;font-size:14px}.note ul{padding-left:20px;margin:8px 0 0}.note li{margin:3px 0}.substep{display:grid;grid-template-columns:32px minmax(0,1fr);gap:14px;margin-top:26px}.num{width:32px;height:32px;display:grid;place-items:center;border-radius:50%;background:var(--accent-bg);color:var(--accent);font-weight:700}",
".term{background:#0f1218;color:#e6e8ee;border-radius:14px;overflow:hidden;margin:14px 0}.termbar{background:#171b23;padding:8px 12px 8px 16px;color:#aab1bf;display:flex;justify-content:space-between;align-items:center}.termbar button{color:white;background:#343b49;border:0;border-radius:7px;padding:7px 12px;cursor:pointer}.term pre{font:13px/1.8 Consolas,ui-monospace,monospace;padding:14px 18px;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}",
".small{font-size:13px;color:#848a98}.link{color:var(--accent);font-weight:600}.field{margin:20px 0}.field label{display:block;font-size:14px;font-weight:600;margin-bottom:7px}.input{width:100%;padding:13px;border:1px solid #d7dbe2;border-radius:10px}.warn{background:#fff8ed;border:1px solid #f2d7a2;padding:15px;border-radius:12px;color:#855308;margin-top:20px;font-size:14px}",
".mobile-step{display:none}@media(max-width:750px){.steps{display:none}.mobile-step{display:block;justify-self:center;font-size:13px}.wz-top{grid-template-columns:auto 1fr auto;padding:0 15px}.main{padding:30px 17px}.footer{padding:12px 15px}h1{font-size:25px}.oss{gap:9px}.os{padding:17px 6px}.os-icon{width:45px;height:45px}}@media(max-width:430px){.brand .text{display:none}.os small{font-size:11px}.btn{padding:9px 12px}}",
].join("");
function href(step: number, os: AgentOs) { return "/dashboard/connect?step=" + step + "&os=" + os; }
function windowShell(os: AgentOs) { return os === "win" ? "PowerShell" : "终端（Terminal）"; }


export function renderConnectPage(input: WizardOptions): string {
  const { os, step, enabled, baseUrl, csrf } = input;
  const steps = ["选择系统", "运行命令", "输入配对码", "完成"];
  const top = '<header class="wz-top"><a class="brand" href="/dashboard"><span class="logo">▣</span><span class="text">添加设备</span></a>'
    + '<div class="steps">' + steps.map((label, i) =>
      (i ? '<span class="sep"></span>' : '') + '<span class="step ' + (i + 1 === step ? 'active' : i + 1 < step ? 'done' : '') + '"><b>'
      + (i + 1 < step ? '✓' : i + 1) + '</b>' + label + '</span>').join('') + '</div>'
    + '<span class="mobile-step">步骤 ' + step + ' / 4</span><a class="btn muted right" href="/dashboard">退出 ×</a></header>';
  let body = "";
  let forward = "";
  if (step === 1) {
    body = '<h1>选择你的电脑系统</h1><p>选择需要连接的电脑操作系统，然后按照提示安装 Agent。</p>'
      + '<div class="oss" data-install-picker>'
      + ([
        ["win", "⊞", "Windows", "Windows 10 / 11"],
        ["mac", "●", "macOS", "Intel / Apple Silicon"],
        ["linux", "🐧", "Linux", "高级安装"],
      ] as const).map(([key, icon, label, detail]) =>
        '<a class="os ' + (os === key ? 'selected' : '') + '" href="' + href(2, key) + '"><span class="os-icon">'
        + icon + '</span><strong>' + label + '</strong><small>' + detail + '</small></a>').join('') + '</div>'
      + '<div class="note"><b>无需事先安装开发工具</b><ul>'
      + '<li>Windows/macOS 无需 Git、Node.js、pnpm 或 Homebrew。</li>'
      + '<li>不会修改全局 PATH，也无需管理员权限。</li>'
      + '<li>电脑需要连接互联网。</li></ul></div>';
    forward = '<a class="btn primary" href="' + href(2, os) + '">下一步 →</a>';
  } else if (step === 2) {
    const name = os === "win" ? "Windows" : os === "mac" ? "macOS" : "Linux";
    body = '<h1>在 ' + name + ' 安装 Agent</h1><p>复制一条命令即可开始安装并连接设备。</p>';
    if (os === "linux") {
      body += '<div class="note">Linux 暂时保持高级安装方式。请参阅 '
        + '<a class="link" href="https://github.com/Chajian/openremotedesktop/blob/master/docs/agent.md">Agent 文档</a>。</div>';
      forward = '<a class="btn secondary" href="' + href(1, os) + '">返回选择系统</a>';
    } else if (!enabled) {
      body += '<div class="warn"><b>一键安装尚未启用</b><div>必须先通过审核并发布新版 Agent，确认可用后才会开放此入口。</div></div>';
      forward = '<a class="btn secondary" href="' + href(1, os) + '">返回选择系统</a>';
    } else {
      const install = installerInstructions(os, baseUrl);
      body += '<div class="substep"><span class="num">1</span><div><h3>打开 ' + windowShell(os) + '</h3><p>'
        + (os === "win" ? '从开始菜单搜索并打开 PowerShell。' : '打开 macOS 上的终端应用。') + '</p></div></div>'
        + '<div class="substep"><span class="num">2</span><div><h3>复制并运行这条命令</h3>'
        + '<p>自动安装环境、Agent，并启动设备配对。</p>'
        + '<div class="term"><div class="termbar"><span>' + windowShell(os) + '</span>'
        + '<button type="button" data-copy="install-command">复制命令</button></div>'
        + '<pre id="install-command">' + escapeHtml(install.command) + '</pre></div>'
        + '<p class="small">Agent ' + install.version + ' · 已校验安装脚本 SHA-256，不会修改全局 PATH。</p>'
        + '<details><summary class="link">查看完整脚本和 SHA-256</summary>'
        + '<p><a class="link" target="_blank" rel="noreferrer noopener" href="' + escapeHtml(install.url) + '">查看 / 下载脚本</a></p>'
        + '<p class="small" style="overflow-wrap:anywhere">SHA-256：' + install.sha256 + '</p></details></div></div>'
        + '<div class="substep"><span class="num">3</span><div><h3>安装完成后批准设备</h3>'
        + '<div class="note">Agent 将尝试自动打开配对网页并预填一次性代码。你需要亲自确认并批准。'
        + '如果浏览器未打开，可继续下一步手动输入。</div></div></div>';
      forward = '<a class="btn primary" href="' + href(3, os) + '">已运行命令，下一步 →</a>';
    }
  } else {
    const code = input.code && /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(input.code) ? input.code : "";
    body = '<h1>输入配对码</h1><p>如果安装程序已自动打开设备批准页面，可以直接在那里操作。这是手动配对的备用入口。</p>'
      + '<form id="pairing-form" action="/dashboard/pairings/approve" method="post">'
      + '<input type="hidden" name="csrf" value="' + escapeHtml(csrf) + '">'
      + '<div class="field"><label for="user-code">配对码（10 分钟有效）</label>'
      + '<input class="input" id="user-code" name="userCode" placeholder="XXXX-XXXX" maxlength="9" '
      + 'autocomplete="one-time-code" value="' + escapeHtml(code) + '" required></div>'
      + '<div class="field"><label for="friendly-name">设备名称</label>'
      + '<input class="input" id="friendly-name" name="friendlyName" maxlength="80" placeholder="例如：我的工作电脑"></div>'
      + '<div class="warn"><b>明确授权</b><div>批准后，这台设备可通过授权的远程客户端访问本机文件并执行终端命令。'
      + '请确认它是你本人正在安装的电脑。</div></div></form>';
    forward = '<button type="submit" form="pairing-form" class="btn primary">确认批准这台设备 →</button>';
  }
  const back = step === 1 ? '<a class="btn muted" href="/dashboard">取消</a>'
    : '<a class="btn muted" href="' + href(step === 2 ? 1 : 2, os) + '">← 上一步</a>';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>添加设备 · Open Desktop Remote</title><style>' + css + '</style></head>'
    + '<body><div class="wz" data-step="' + step + '" data-os="' + os + '">' + top
    + '<main class="main">' + body + '</main><footer class="footer"><div class="footer-inner">'
    + back + forward + '</div></footer></div>'
    + '<script src="/dashboard/onboarding.js" defer></script></body></html>';
}
