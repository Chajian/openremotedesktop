import { defaultCredentialPath } from "../config.js";
import { FileCredentialStore, credentialFileMode } from "./file-store.js";
import { KeyringCredentialBackend } from "./keyring-store.js";

export type DeviceCredential = {
  serverUrl: string;
  deviceId: string;
  refreshCredential: string;
};

export interface CredentialStore {
  get(): Promise<DeviceCredential | null>;
  set(value: DeviceCredential): Promise<void>;
  clear(): Promise<void>;
}

export interface NativeCredentialBackend {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}

export type CredentialStoreOptions = {
  nativeBackend?: NativeCredentialBackend;
  filePath?: string;
};

function parseCredential(raw: string): DeviceCredential {
  const value = JSON.parse(raw) as Partial<DeviceCredential>;
  if (
    typeof value.serverUrl !== "string" ||
    typeof value.deviceId !== "string" ||
    typeof value.refreshCredential !== "string"
  ) {
    throw new TypeError("Invalid stored device credential");
  }
  return value as DeviceCredential;
}

export function createCredentialStore(
  options: CredentialStoreOptions = {},
): CredentialStore {
  const native = options.nativeBackend ?? new KeyringCredentialBackend();
  const file = new FileCredentialStore(
    options.filePath ?? defaultCredentialPath(),
  );

  return {
    async get() {
      try {
        const raw = await native.get();
        if (raw !== null) return parseCredential(raw);
      } catch {
        // Fall through to the weaker user-profile file backend.
      }
      return file.get();
    },

    async set(value) {
      const raw = JSON.stringify(value);
      try {
        await native.set(raw);
        await file.clear();
        return;
      } catch {
        await file.set(value);
      }
    },

    async clear() {
      try {
        await native.clear();
      } catch {
        // Continue clearing fallback even if native storage is unavailable.
      }
      await file.clear();
    },
  };
}

export { credentialFileMode };
