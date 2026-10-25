import type { DeviceCredential } from "../credentials/credential-store.js";
import {
  ServerClient,
  ServerRequestError,
  ServerResponseError,
  type DeviceAccessResponse,
} from "../http/server-client.js";

export class DeviceCredentialRejectedError extends Error {
  constructor() {
    super("Device credential was rejected. Pair this device again.");
    this.name = "DeviceCredentialRejectedError";
  }
}

export async function refreshRelayToken(
  credential: DeviceCredential,
  client = new ServerClient(new URL(credential.serverUrl)),
  signal?: AbortSignal,
): Promise<DeviceAccessResponse> {
  signal?.throwIfAborted();
  try {
    const token = await client.refreshDeviceAccess(
      credential.refreshCredential,
      signal,
    );
    signal?.throwIfAborted();
    if (token.deviceId !== credential.deviceId) {
      throw new ServerResponseError();
    }
    return token;
  } catch (error) {
    if (signal?.aborted && error === signal.reason) throw error;
    if (
      error instanceof ServerRequestError &&
      (error.status === 401 || error.status === 403)
    ) {
      throw new DeviceCredentialRejectedError();
    }
    throw error;
  }
}
