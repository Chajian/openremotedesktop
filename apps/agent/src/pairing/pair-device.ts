import type {
  CredentialStore,
  DeviceCredential,
} from "../credentials/credential-store.js";
import {
  ServerClient,
  type PairingPollResponse,
} from "../http/server-client.js";

export type PairingUi = {
  showVerification(input: {
    verificationUri: string;
    userCode: string;
  }): void;
};

export type PairDeviceOptions = {
  client?: ServerClient;
  sleep?: (ms: number) => Promise<void>;
};

export class PairingFailedError extends Error {
  constructor(public readonly status: PairingPollResponse["status"]) {
    super(`Device pairing failed with status: ${status}`);
    this.name = "PairingFailedError";
  }
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function pairDevice(
  serverUrl: URL,
  io: PairingUi,
  options: PairDeviceOptions = {},
): Promise<DeviceCredential> {
  const client = options.client ?? new ServerClient(serverUrl);
  const sleep = options.sleep ?? defaultSleep;
  const created = await client.createPairing();

  io.showVerification({
    verificationUri: created.verificationUri,
    userCode: created.userCode,
  });

  let interval = created.interval;
  for (;;) {
    const result = await client.pollPairing(created.deviceCode);
    if (result.status === "approved") {
      return {
        serverUrl: serverUrl.toString(),
        deviceId: result.deviceId,
        refreshCredential: result.refreshCredential,
      };
    }
    if (result.status !== "pending") {
      throw new PairingFailedError(result.status);
    }
    interval = result.interval;
    await sleep(interval * 1000);
  }
}

export async function ensureDeviceCredential(
  serverUrl: URL,
  store: CredentialStore,
  io: PairingUi,
  options: PairDeviceOptions = {},
): Promise<DeviceCredential> {
  const existing = await store.get();
  if (
    existing &&
    new URL(existing.serverUrl).toString() === serverUrl.toString()
  ) {
    return existing;
  }

  const credential = await pairDevice(serverUrl, io, options);
  await store.set(credential);
  return credential;
}
