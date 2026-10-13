import { DesktopCommanderClient } from "@open-desktop-remote/desktop-commander-adapter";
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
import { RelayClient } from "./relay/relay-client.js";

type RelayRunner = {
  run(signal: AbortSignal): Promise<void>;
};

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

function defaultPairingUi(): PairingUi {
  return {
    showVerification({ verificationUri, userCode }) {
      console.log(`Open ${verificationUri} and approve code ${userCode}`);
    },
  };
}

export async function runAgentConnect(
  serverUrl: URL,
  signal: AbortSignal,
  options: AgentConnectOptions = {},
): Promise<void> {
  const store = options.store ?? createCredentialStore();
  const io = options.io ?? defaultPairingUi();
  const ensureCredential =
    options.ensureCredential ?? ensureDeviceCredential;
  const credential = await ensureCredential(serverUrl, store, io);
  const executor =
    options.createExecutor?.() ??
    new ExecutorManager({
      startClient: () => DesktopCommanderClient.start(),
    });
  const relay =
    options.createRelay?.(credential, executor) ??
    new RelayClient({ credential, executor });

  try {
    await relay.run(signal);
  } finally {
    await executor.close();
  }
}
