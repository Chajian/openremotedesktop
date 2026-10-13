(() => {
  if (document.querySelector("[data-install-picker]") && !new URLSearchParams(location.search).has("os")) {
    const ua = navigator.userAgent.toLowerCase();
    const os = ua.includes("windows") ? "win" : ua.includes("mac") ? "mac" : "linux";
    location.replace("/dashboard/connect?os=" + os);
    return;
  }
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const text = document.getElementById(button.dataset.copy)?.textContent ?? "";
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "已复制 / Copied";
      } catch {
        button.textContent = "复制失败，请手动选中命令 / Select text to copy";
      }
    });
  });
  const card = document.querySelector("[data-device-id]");
  if (!card) return;
  const status = document.getElementById("device-status");
  const hint = document.getElementById("device-hint");
  const started = Date.now();
  const labels = {
    READY: "READY · 已连接，可远程操作",
    AUTHENTICATED: "正在启动工具…",
    CONNECTED: "正在连接…",
    REVOKED: "授权已撤销",
    OFFLINE: "等待 Agent 连接…"
  };
  async function poll() {
    try {
      const response = await fetch("/dashboard/devices/" + encodeURIComponent(card.dataset.deviceId) + "/status", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("Unable to read device status");
      const data = await response.json();
      status.textContent = labels[data.state] ?? (data.state === "EXECUTOR_STARTING" ? "正在启动工具…" : "正在连接…");
      if (data.state === "READY") hint.textContent = "可以在 ChatGPT 中使用这台设备了。";
      else if (data.state === "OFFLINE" && Date.now() - started > 45000)
        hint.textContent = "连接失败或尚未启动。检查终端中的错误信息，确认 Agent 在运行。";
      else hint.textContent = "自动检查设备状态中，无需刷新。";
    } catch {
      hint.textContent = "暂时无法获取设备状态。请检查网络或重新登录。";
    }
  }
  void poll();
  setInterval(poll, 2500);
})();
