import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const serverDir = join(root, "apps", "server");
const children: Array<{ process: ChildProcess; dataDir: string }> = [];

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No available port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

afterEach(async () => {
  for (const { process: child, dataDir } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});

async function bootEntrypoint(withGithub: boolean) {
  const port = await availablePort();
  const dataDir = mkdtempSync(join(tmpdir(), "odr-main-e2e-"));
  const base = `http://127.0.0.1:${port}`;
  const inherited = { ...process.env };
  for (const name of Object.keys(inherited)) {
    if (name.startsWith("ODR_GITHUB_")) delete inherited[name];
  }
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: serverDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...inherited,
      NODE_ENV: "production",
      ODR_HOST: "127.0.0.1",
      ODR_PORT: String(port),
      ODR_DATABASE_PATH: join(dataDir, "server.sqlite"),
      ODR_PUBLIC_BASE_URL: `https://127.0.0.1:${port}`,
      ODR_AUTH_DIAGNOSTICS: "false",
      ODR_GITHUB_CLIENT_ID: withGithub ? "e2e-github-client" : "",
      ODR_GITHUB_CLIENT_SECRET: withGithub ? "e2e-github-secret" : "",
    },
  });
  children.push({ process: child, dataDir });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Server exited before becoming ready");
    try {
      const health = await fetch(base + "/readyz", { signal: AbortSignal.timeout(700) });
      if (health.status === 200) return base;
    } catch {
      // Wait for the real main.ts process to open its loopback socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Server entrypoint failed to become ready");
}

describe("real production main.ts configuration forwarding", () => {
  it("enables GitHub login when both OAuth environment values are supplied", async () => {
    const base = await bootEntrypoint(true);
    const res = await fetch(base + "/auth/github", { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("e2e-github-client");
    expect(location.searchParams.get("redirect_uri")).toBe(
      new URL("/auth/github/callback", base.replace("http://", "https://")).toString(),
    );
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    const login = await fetch(base + "/dashboard/login");
    expect(await login.text()).toContain("Sign in with GitHub");
  });

  it("preserves legacy Owner-only mode when GitHub is not configured", async () => {
    const base = await bootEntrypoint(false);
    expect((await fetch(base + "/auth/github")).status).toBe(404);
    const login = await fetch(base + "/dashboard/login");
    expect(login.status).toBe(200);
    expect(await login.text()).not.toContain("Sign in with GitHub");
  });
});
