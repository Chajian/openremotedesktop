import { createHash } from "node:crypto";
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
  serverUrl?: URL;
  legacyBackend?: NativeCredentialBackend;
  legacyFilePath?: string;
};

export function serverCredentialScope(serverUrl: URL): string {
  return createHash("sha256").update(serverUrl.origin).digest("hex").slice(0, 20);
}

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
  const scope = options.serverUrl ? serverCredentialScope(options.serverUrl) : undefined;
  const native = options.nativeBackend ?? new KeyringCredentialBackend(scope ? `device-${scope}` : "device");
  const file = new FileCredentialStore(options.filePath ?? defaultCredentialPath(scope));
  // Read the original unscoped identity only for this exact server. Never overwrite it.
  const legacy = scope ? createCredentialStore({
    ...(options.legacyBackend ? { nativeBackend: options.legacyBackend } : {}),
    ...(options.legacyFilePath ? { filePath: options.legacyFilePath } : {}),
  }) : null;
  const belongsHere = (value: DeviceCredential) =>
    !options.serverUrl || new URL(value.serverUrl).origin === options.serverUrl.origin;
  const store: CredentialStore = {
    async get() {
      let value: DeviceCredential | null = null;
      try {
        const raw = await native.get();
        if (raw !== null) value = parseCredential(raw);
      } catch {
        // Fall through to the user-profile fallback when Keychain/Keyring is unavailable.
      }
      value ??= await file.get();
      if (value) {
        if (!belongsHere(value)) throw new Error("Stored credential belongs to another server");
        return value;
      }
      if (legacy) {
        const original = await legacy.get();
        if (original && belongsHere(original)) {
          await store.set(original);
          return original;
        }
      }
      return null;
    },
    async set(value) {
      if (!belongsHere(value)) throw new Error("Refusing to replace another server's device identity");
      const raw = JSON.stringify(value);
      try {
        await native.set(raw);
        await file.clear();
      } catch {
        await file.set(value);
      }
    },
    async clear() {
      try { await native.clear(); } catch { /* Continue clearing scoped file. */ }
      await file.clear();
    },
  };
  return store;
}

export { credentialFileMode };
