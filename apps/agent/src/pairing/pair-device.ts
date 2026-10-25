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
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
};

export class PairingFailedError extends Error {
  constructor(public readonly status: PairingPollResponse["status"]) {
    super(`Device pairing failed with status: ${status}`);
    this.name = "PairingFailedError";
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });

async function waitForPoll(
  sleep: NonNullable<PairDeviceOptions["sleep"]>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return sleep(ms);
  signal.throwIfAborted();
  const stopped = Promise.withResolvers<never>();
  const abort = () => stopped.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    // The owned timer observes signal; legacy injected sleeps may ignore it.
    await Promise.race([sleep(ms, signal), stopped.promise]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function pairDevice(
  serverUrl: URL,
  io: PairingUi,
  options: PairDeviceOptions = {},
): Promise<DeviceCredential> {
  const { signal } = options;
  signal?.throwIfAborted();
  const client = options.client ?? new ServerClient(serverUrl);
  const sleep = options.sleep ?? defaultSleep;
  const created = await client.createPairing(signal);
  signal?.throwIfAborted();

  io.showVerification({
    verificationUri: created.verificationUri,
    userCode: created.userCode,
  });

  let interval = created.interval;
  for (;;) {
    signal?.throwIfAborted();
    const result = await client.pollPairing(created.deviceCode, signal);
    signal?.throwIfAborted();
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
    await waitForPoll(sleep, interval * 1000, signal);
  }
}

export async function ensureDeviceCredential(
  serverUrl: URL,
  store: CredentialStore,
  io: PairingUi,
  options: PairDeviceOptions = {},
): Promise<DeviceCredential> {
  options.signal?.throwIfAborted();
  const existing = await store.get();
  options.signal?.throwIfAborted();
  if (
    existing &&
    new URL(existing.serverUrl).toString() === serverUrl.toString()
  ) {
    return existing;
  }

  const credential = await pairDevice(serverUrl, io, options);
  options.signal?.throwIfAborted();
  await store.set(credential);
  return credential;
}
