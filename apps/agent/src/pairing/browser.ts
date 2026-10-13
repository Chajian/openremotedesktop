import { spawn } from "node:child_process";

const CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

/** Only the one-time user code is put in the URL; never the device code or credential. */
export function verificationLink(serverUrl: URL, verificationUri: string, userCode: string): string {
  if (!CODE.test(userCode)) throw new Error("Invalid pairing code");
  const provided = new URL(verificationUri);
  if (provided.origin !== serverUrl.origin || provided.pathname !== "/device") {
    throw new Error("Untrusted pairing verification URL");
  }
  const url = new URL("/device", serverUrl);
  url.searchParams.set("code", userCode);
  return url.toString();
}

export function openVerificationLink(url: string, platform = process.platform): void {
  const command = platform === "win32" ? "rundll32.exe" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => { /* Manual URL remains visible in the terminal. */ });
    child.unref();
  } catch {
    // Browser launch is best effort: the user can follow the printed link.
  }
}
