import { createHash } from "node:crypto";
import {
  DesktopCommanderClient, DESKTOP_COMMANDER_VERSION, DESKTOP_COMMANDER_TOOL_MANIFEST,
  assertDesktopCommanderCatalog, canonicalToolCatalog,
} from "@open-desktop-remote/desktop-commander-adapter";
import agentRelease from "./version.json" with { type: "json" };
import {
  createCredentialStore,
  type CredentialStore,
  type DeviceCredential,
} from "./credentials/credential-store.js";
import { ExecutorManager } from "./executor/executor-manager.js";
import {
  ensureDeviceCredential,
  type PairingUi,
} from "./pairing/pair-device.js";
import { RelayClient, type RelayRuntimeIdentity } from "./relay/relay-client.js";
import { openVerificationLink, verificationLink } from "./pairing/browser.js";

type RelayRunner = {
  run(signal: AbortSignal): Promise<void>;
};

export const AGENT_RUNTIME_IDENTITY: RelayRuntimeIdentity = Object.freeze({
  agentVersion: agentRelease.version,
  desktopCommanderVersion: DESKTOP_COMMANDER_VERSION,
  platform: process.platform === "win32" || process.platform === "darwin" ? process.platform : "linux",
  toolsHash: createHash("sha256").update(canonicalToolCatalog(DESKTOP_COMMANDER_TOOL_MANIFEST)).digest("hex"),
});

export type AgentConnectOptions = {
  store?: CredentialStore;
  io?: PairingUi;
  ensureCredential?: typeof ensureDeviceCredential;
  createExecutor?: () => ExecutorManager;
  createRelay?: (
    credential: DeviceCredential,
    executor: ExecutorManager,
  ) => RelayRunner;
};

function defaultPairingUi(serverUrl: URL): PairingUi {
  return {
    showVerification({ verificationUri, userCode }) {
      const link = verificationLink(serverUrl, verificationUri, userCode);
      console.log(`Approve this computer at ${link} (code ${userCode}).`);
      console.log("Access to local files and terminal commands requires your explicit approval.");
      openVerificationLink(link);
    },
  };
}

export async function runAgentConnect(
  serverUrl: URL,
  signal: AbortSignal,
  options: AgentConnectOptions = {},
): Promise<void> {
  if (signal.aborted) return;
  const store = options.store ?? createCredentialStore({ serverUrl });
  const io = options.io ?? defaultPairingUi(serverUrl);
  const ensureCredential =
    options.ensureCredential ?? ensureDeviceCredential;
  const credential = await ensureCredential(serverUrl, store, io);
  if (signal.aborted) return;
  const executor =
    options.createExecutor?.() ??
    new ExecutorManager({
      validateTools: assertDesktopCommanderCatalog,
      startClient: (onCreated, startupSignal) => DesktopCommanderClient.start({
        onCreated,
        signal: startupSignal,
        clientInfo: { name: "open-desktop-remote-agent", version: agentRelease.version },
      }),
    });
  // Stop must reach an owned executor even while Relay is waiting for its
  // initialization. Abort and final unwinding share one observed close result.
  let shutdown: Promise<void> | undefined;
  const shutdownOnce = () => shutdown ??= Promise.resolve().then(() => executor.close());
  const stop = () => {
    // Observe the rejection now; finally below still awaits the original result.
    void shutdownOnce().catch(() => undefined);
  };
  signal.addEventListener("abort", stop, { once: true });
  let failed = false;
  let failure: unknown;
  try {
    if (signal.aborted) { stop(); return; }
    const relay =
      options.createRelay?.(credential, executor) ??
      new RelayClient({ credential, executor, identity: AGENT_RUNTIME_IDENTITY });
    await relay.run(signal);
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    signal.removeEventListener("abort", stop);
    try {
      await shutdownOnce();
    } catch (shutdownError) {
      if (failed) throw new AggregateError([failure, shutdownError], "Agent failed and executor shutdown could not be confirmed");
      throw shutdownError;
    }
  }
}
