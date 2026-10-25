import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const install = resolve(process.argv[2] || "dist/agent-install-check");
const packageRoot = join(install, "node_modules", "open-desktop-remote-agent");
const require = createRequire(join(packageRoot, "package.json"));
const pkg = require("./package.json");
const release = JSON.parse(await readFile(new URL("../apps/agent/src/version.json", import.meta.url), "utf8"));
const manifest = JSON.parse(await readFile(new URL("../packages/tool-contracts/src/manifest.generated.json", import.meta.url), "utf8"));
const contracts = manifest.map(tool => ({
  name: tool.name, inputSchema: tool.inputSchema ?? null, outputSchema: tool.outputSchema ?? null,
})).sort((left, right) => left.name.localeCompare(right.name));
const catalogJson = JSON.stringify(contracts, (_key, value) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
    : value);
const expectedToolsHash = createHash("sha256").update(catalogJson).digest("hex");
assert.equal(pkg.name, "open-desktop-remote-agent");
assert.equal(pkg.version, release.version);
const { WebSocketServer } = require("ws");
const fixture = await mkdtemp(join(tmpdir(), "odr-packaged-runtime-"));
const home = join(fixture, "home");
const workspace = join(fixture, "workspace");
const forcedCleanup = join(fixture, "forced-cleanup.txt");
const deviceId = randomUUID();
const requestId = randomUUID();
const refreshCredential = "fixture-" + randomBytes(16).toString("hex");
const accessToken = "fixture-" + randomBytes(16).toString("hex");
const hello = Promise.withResolvers();
const ready = Promise.withResolvers();
const toolResult = Promise.withResolvers();
const executorSpawned = Promise.withResolvers();
const exit = Promise.withResolvers();
const failed = Promise.withResolvers();
const failures = [];
// All real waits below race this shared failure. Observe early failures too.
void failed.promise.catch(() => {});
const fail = (error) => {
  if (!failures.includes(error)) failures.push(error);
  failed.reject(error);
};
const spawned = new Set();
const closed = new Set();
const identities = new Map();
let isolatedKeyringReads = 0;
let refreshes = 0;
let agent;
let socket;
let stopping = false;

async function deadline(promise, label, ms = 30_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Packaged Agent ${label} timed out`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
const step = (promise, label) => deadline(Promise.race([promise, failed.promise]), label);
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

const execute = promisify(execFile);
async function inspectProcess(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const options = { encoding: "utf8", timeout: 5_000, maxBuffer: 16_384, windowsHide: true, env: { ...process.env, LC_ALL: "C" } };
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'; try{$p=[System.Diagnostics.Process]::GetProcessById(${pid})}catch [System.ArgumentException]{exit 0}; try{if(-not $p.HasExited){ $parent=(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').ParentProcessId; @{ parent=$parent; identity=$p.StartTime.ToUniversalTime().Ticks.ToString(); state='running' } | ConvertTo-Json -Compress }}finally{$p.Dispose()}`;
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], options);
    return stdout.trim() ? JSON.parse(stdout) : null;
  }
  let stdout;
  try {
    ({ stdout } = await execute("ps", ["-p", String(pid), "-o", "ppid=", "-o", "stat=", "-o", "lstart=", "-o", "args="], options));
  } catch (error) {
    if (error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim()) return null;
    throw error;
  }
  const [parent, state, ...rest] = stdout.trim().split(/\s+/);
  return { parent: Number(parent), state, identity: rest.slice(0, 5).join(" "), command: rest.slice(5).join(" ") };
}

async function terminateFixtureExecutor(pid, original) {
  const current = await inspectProcess(pid);
  // A vanished or replaced PID is not the process this fixture owns.
  if (!current || current.identity !== original.identity || current.state.startsWith("Z")) return;
  if (process.platform === "win32") {
    assert.match(original.identity, /^\d+$/);
    // Hold a Windows process handle and compare its creation time before kill.
    const script = `$ErrorActionPreference='Stop'; try{$p=[System.Diagnostics.Process]::GetProcessById(${pid})}catch [System.ArgumentException]{exit 0}; try{$null=$p.Handle; if($p.StartTime.ToUniversalTime().Ticks.ToString() -ne '${original.identity}'){throw 'Fixture process identity changed'}; $p.Kill(); if(-not $p.WaitForExit(5000)){throw 'Fixture executor did not exit'}}finally{$p.Dispose()}`;
    await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 7_000, windowsHide: true });
  } else {
    assert.equal(current.command, original.command, "Refusing to signal a changed fixture process");
    try { process.kill(pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  const until = performance.now() + 5_000;
  while (performance.now() < until) {
    const state = await inspectProcess(pid);
    if (!state || state.identity !== original.identity || state.state.startsWith("Z")) return;
    await delay(25);
  }
  throw new Error("Recorded fixture executor exit could not be confirmed");
}

const server = createServer((request, response) => {
  void (async () => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/device-auth/refresh", "The smoke must never pair a real account");
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      assert.ok(body.length < 4096, "Unexpected credential request size");
    }
    assert.deepEqual(JSON.parse(body), { refreshCredential });
    refreshes++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ deviceId, accessToken, expiresAt: Date.now() + 60_000 }));
  })().catch(error => { response.destroy(); fail(error); });
});
server.on("error", fail);
const websocket = new WebSocketServer({ noServer: true });
websocket.on("error", fail);
server.on("upgrade", (request, stream, head) => {
  try {
    assert.equal(request.url, "/relay");
    assert.equal(request.headers.authorization, `Bearer ${accessToken}`);
    websocket.handleUpgrade(request, stream, head, connected => websocket.emit("connection", connected));
  } catch (error) { stream.destroy(); fail(error); }
});
websocket.on("connection", connected => {
  if (socket) { connected.terminate(); fail(new Error("Unexpected Agent reconnect during smoke")); return; }
  socket = connected;
  connected.on("error", fail);
  connected.on("message", raw => {
    try {
      const message = JSON.parse(raw.toString());
      assert.equal(message.protocolVersion, 1);
      assert.equal(message.deviceId, deviceId);
      if (message.type === "agent.hello") hello.resolve(message);
      else if (message.type === "agent.ready") ready.resolve(message);
      else if (message.type === "tool.result" || message.type === "tool.error") toolResult.resolve(message);
      else if (message.type === "agent.executor_status") {
        assert.equal(message.state, "EXECUTOR_STARTING");
      } else assert.equal(message.type, "heartbeat");
    } catch (error) { fail(error); }
  });
});

try {
  assert.ok((await inspectProcess(process.pid))?.identity, "Fixture process identity inspection must be available");
  await mkdir(workspace);
  await mkdir(join(home, ".open-desktop-remote"), { recursive: true });
  await mkdir(join(home, ".claude-server-commander"), { recursive: true });
  await writeFile(join(home, ".claude-server-commander", "config.json"), JSON.stringify({
    allowedDirectories: [workspace], telemetryEnabled: false,
    welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false,
  }));
  await step(new Promise(resolve => server.listen(0, "127.0.0.1", resolve)), "loopback listen");
  const serverUrl = `http://127.0.0.1:${server.address().port}/`;
  const scope = createHash("sha256").update(new URL(serverUrl).origin).digest("hex").slice(0, 20);
  const credential = { serverUrl, deviceId, refreshCredential };
  const credentialPath = join(home, ".open-desktop-remote", `device-${scope}.json`);
  await writeFile(credentialPath, JSON.stringify(credential), { mode: 0o600 });
  const environment = { ...process.env, HOME: home, USERPROFILE: home, NODE_USE_ENV_PROXY: "0",
    ODR_SMOKE_FORCED_CLEANUP: forcedCleanup };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  agent = fork(join(packageRoot, "dist", "cli.mjs"), ["agent", "connect", "--server", serverUrl], {
    cwd: workspace, env: environment,
    execArgv: ["--import", new URL("./fixtures/packaged-agent-preload.mjs", import.meta.url).href],
    stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
  });
  // Do not print upstream diagnostics or the synthetic credential to CI logs.
  agent.stdout.resume();
  agent.stderr.resume();
  agent.on("error", fail);
  agent.on("message", message => {
    if (message?.type === "fixture.keyring-isolated") isolatedKeyringReads++;
    else if (message?.type === "fixture.executor-spawn") {
      spawned.add(message.pid);
      const identity = inspectProcess(message.pid).then(info => {
        assert.equal(info?.parent, agent.pid, "Executor must initially belong to this fixture's Agent");
        return info;
      });
      identities.set(message.pid, identity);
      void identity.catch(fail);
      executorSpawned.resolve(message.pid);
    } else if (message?.type === "fixture.executor-close") closed.add(message.pid);
  });
  agent.once("close", (code, signal) => {
    exit.resolve({ code, signal });
    if (!stopping) fail(new Error(`Packaged Agent exited before shutdown (code=${code}, signal=${signal})`));
  });

  const greeting = await step(hello.promise, "hello");
  assert.equal(greeting.agentVersion, pkg.version);
  assert.equal(greeting.desktopCommanderVersion, pkg.dependencies["@wonderwhy-er/desktop-commander"]);
  assert.equal(greeting.platform, process.platform);
  assert.ok(greeting.capabilities.includes("desktop-commander"));
  const readiness = await step(ready.promise, "READY");
  assert.equal(readiness.desktopCommanderVersion, greeting.desktopCommanderVersion);
  assert.equal(readiness.toolsHash, expectedToolsHash, "Installed Agent catalog differs from the source contract");
  const executorPid = await step(executorSpawned.promise, "executor spawn");
  await step(identities.get(executorPid), "executor identity");
  assert.equal(spawned.size, 1);
  assert.equal(isolatedKeyringReads, 1, "The real system keyring must be intercepted");
  assert.equal(refreshes, 1);
  assert.ok(processAlive(executorPid));
  socket.send(JSON.stringify({ type: "tool.call", protocolVersion: 1,
    deviceId, requestId, toolName: "get_config", arguments: {} }));
  const result = await step(toolResult.promise, "tool call");
  assert.equal(result.type, "tool.result");
  assert.equal(result.requestId, requestId);
  assert.notEqual(result.result.isError, true);
  const text = result.result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  assert.ok(text.includes(workspace.replaceAll("\\", "\\\\")), "Executor must read only the fixture config");
  assert.ok(text.includes('"telemetryEnabled": false'));

  stopping = true;
  if (process.platform === "win32") agent.send({ type: "fixture.stop" });
  else assert.equal(agent.kill("SIGTERM"), true);
  assert.deepEqual(await step(exit.promise, "graceful shutdown"), { code: 0, signal: null });
  assert.deepEqual(closed, spawned, "Agent must physically close every owned executor before exit");
  assert.equal(processAlive(executorPid), false);
  await assert.rejects(access(forcedCleanup), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(credentialPath, "utf8")), credential);
} catch (error) {
  if (!failures.includes(error)) failures.push(error);
} finally {
  const cleanupErrors = [];
  stopping = true;
  if (agent && agent.exitCode === null && agent.signalCode === null) {
    try {
      agent.send({ type: "fixture.cleanup" });
      await deadline(exit.promise, "failed-fixture cleanup", 10_000);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  // An unresponsive or abruptly exited Agent may bypass the preload cleanup.
  // Retire only its identified direct executors before the actual Agent handle.
  for (const [pid, identity] of identities) {
    if (closed.has(pid)) continue;
    try { await terminateFixtureExecutor(pid, await identity); }
    catch (executorError) { cleanupErrors.push(executorError); }
  }
  if (agent && agent.exitCode === null && agent.signalCode === null) {
    agent.kill("SIGKILL");
    try { await deadline(exit.promise, "forced fixture exit", 5_000); }
    catch (forcedError) { cleanupErrors.push(forcedError); }
  }
  for (const client of websocket.clients) client.terminate();
  try { await deadline(new Promise((resolve, reject) => websocket.close(error => error ? reject(error) : resolve())), "loopback websocket cleanup", 5_000); }
  catch (error) { cleanupErrors.push(error); }
  server.closeAllConnections();
  if (server.listening) {
    try { await deadline(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), "loopback HTTP cleanup", 5_000); }
    catch (error) { cleanupErrors.push(error); }
  }
  try { await rm(fixture, { recursive: true, force: true }); }
  catch (error) { cleanupErrors.push(error); }
  failures.push(...cleanupErrors);
}
if (failures.length === 1) throw failures[0];
if (failures.length > 1) throw new AggregateError(failures, "Packaged Agent verification and cleanup failed");
console.log(`Installed Agent ${pkg.version}: real CLI hello, READY, get_config and owned subprocess shutdown passed (${process.platform}).`);
