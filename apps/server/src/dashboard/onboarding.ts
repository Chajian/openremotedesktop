import type { Device } from "../devices/device-repository.js";
import { escapeHtml } from "./templates.js";

const styles = [
  "body{font-family:system-ui,-apple-system,sans-serif;max-width:850px;margin:40px auto;padding:0 20px;color:#172333;background:#fafcfe;line-height:1.6}",
  "a{color:#0757ae}nav{display:flex;gap:24px;margin-bottom:32px}.card{background:white;border:1px solid #dce5ee;border-radius:14px;padding:24px;margin:20px 0}",
  ".btn,button{background:#1658b5;color:white;border:0;border-radius:7px;padding:10px 18px;cursor:pointer;font-size:15px}.btn{display:inline-block;text-decoration:none}",
  ".tabs{display:flex;gap:10px;flex-wrap:wrap}.tabs a{padding:9px 18px;border:1px solid #bcd0e4;border-radius:8px;text-decoration:none}.tabs .active{background:#e6f1ff;font-weight:700}",
  "pre,code{overflow-wrap:anywhere;white-space:pre-wrap;background:#f1f5f8;padding:12px;border-radius:8px}input{padding:10px;max-width:100%;font-size:17px;border:1px solid #a9b9ca;border-radius:8px}",
  "label{display:block;font-weight:600;margin:14px 0 5px}.note{font-size:14px;color:#485969}.warning{border-left:4px solid #dd8a1c;padding-left:15px}",
  "@media(max-width:600px){body{margin:20px auto}.card{padding:16px}}",
].join("");
function page(title: string, body: string, script = false): string {
  return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    + "<title>" + escapeHtml(title) + " · Open Desktop Remote</title><style>" + styles + "</style></head><body>"
    + "<nav><a href=\"/dashboard\">设备 Devices</a><a href=\"/dashboard/connect\">添加设备 Add device</a></nav>"
    + "<main><h1>" + escapeHtml(title) + "</h1>" + body + "</main>"
    + (script ? "<script src=\"/dashboard/onboarding.js\" defer></script>" : "") + "</body></html>";
}

export function renderPairingPage(code: string, csrf: string): string {
  return page("批准设备配对 · Approve device",
    "<p>仅批准你亲自正在安装的电脑。此授权可允许远程读取本机文件和执行终端命令。</p>"
    + "<form class=\"card\" method=\"post\" action=\"/dashboard/pairings/approve\">"
    + "<input type=\"hidden\" name=\"csrf\" value=\"" + escapeHtml(csrf) + "\">"
    + "<label for=\"pairing-code\">一次性配对码 (10 分钟有效)</label>"
    + "<input id=\"pairing-code\" name=\"userCode\" value=\"" + escapeHtml(code) + "\" placeholder=\"XXXX-XXXX\" pattern=\"[A-Za-z2-9]{4}-?[A-Za-z2-9]{4}\" maxlength=\"9\" required autocomplete=\"one-time-code\">"
    + "<label for=\"device-name\">设备名称</label><input id=\"device-name\" name=\"friendlyName\" maxlength=\"80\" placeholder=\"我的电脑\">"
    + "<p class=\"warning\">批准后，这台电脑上的 Agent 才能访问其本地文件和运行命令。请不要批准陌生设备。</p>"
    + "<button type=\"submit\">确认批准 / Approve this device</button></form>");
}

export function deviceUiStatus(state: string): string {
  if (state === "READY") return "READY · 已连接，可远程操作";
  if (state === "AUTHENTICATED" || state === "EXECUTOR_STARTING") return "正在启动工具…";
  if (state === "CONNECTED") return "正在连接…";
  if (state === "REVOKED") return "授权已撤销";
  return "等待 Agent 连接…（请确认安装终端仍在运行）";
}

export function renderDevicePage(device: Device, state: string): string {
  return page("设备详情 · " + device.name,
    "<div class=\"card\" data-device-id=\"" + escapeHtml(device.id) + "\">"
    + "<h2 id=\"device-status\">" + escapeHtml(deviceUiStatus(state)) + "</h2>"
    + "<p class=\"note\" id=\"device-hint\">状态将自动更新，无需手动刷新。</p>"
    + "<p>设备：" + escapeHtml(device.name) + "</p><p>系统：" + escapeHtml(device.platform ?? "待检测") + "</p>"
    + "<p>Agent：" + escapeHtml(device.agentVersion ?? "待连接") + "</p>"
    + "<p class=\"note\">关闭运行 Agent 的终端会导致设备离线。配对凭据不会公开展示。</p></div>", true);
}
