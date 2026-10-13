import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCredentialStore,
  credentialFileMode,
  type DeviceCredential,
  type NativeCredentialBackend,
} from "./credential-store.js";

const tempDirs: string[] = [];
const credential: DeviceCredential = {
  serverUrl: "https://remote.example.com",
  deviceId: "6d1cf056-7fc5-49d4-8930-f989aafd957b",
  refreshCredential: "super-secret-refresh-credential",
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "odr-agent-credentials-"));
  tempDirs.push(dir);
  return join(dir, "nested", "device.json");
}

function fakeNative(): NativeCredentialBackend & {
  values: string[];
  clears: number;
} {
  const values: string[] = [];
  return {
    values,
    clears: 0,
    async get() {
      return values.at(-1) ?? null;
    },
    async set(value) {
      values.push(value);
    },
    async clear() {
      this.clears += 1;
      values.length = 0;
    },
  };
}

describe("credential storage", () => {
  it("prefers the native credential backend", async () => {
    const native = fakeNative();
    const filePath = tempFile();
    const store = createCredentialStore({ nativeBackend: native, filePath });

    await store.set(credential);
    expect(await store.get()).toEqual(credential);
    expect(native.values).toHaveLength(1);
    expect(() => statSync(filePath)).toThrow();
  });

  it("falls back to a user-scoped file when native storage fails", async () => {
    const filePath = tempFile();
    const native: NativeCredentialBackend = {
      async get() { throw new Error("keyring unavailable"); },
      async set() { throw new Error("keyring unavailable"); },
      async clear() { throw new Error("keyring unavailable"); },
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = createCredentialStore({ nativeBackend: native, filePath });

    await store.set(credential);
    expect(await store.get()).toEqual(credential);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual(credential);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("uses POSIX 0600 for fallback credential files", () => {
    expect(credentialFileMode("linux")).toBe(0o600);
    expect(credentialFileMode("darwin")).toBe(0o600);
    expect(credentialFileMode("win32")).toBeUndefined();
  });

  it("clear removes both native and fallback copies", async () => {
    const native = fakeNative();
    const filePath = tempFile();
    const store = createCredentialStore({ nativeBackend: native, filePath });
    await store.set(credential);

    const fallback = createCredentialStore({
      nativeBackend: {
        async get() { throw new Error("offline"); },
        async set() { throw new Error("offline"); },
        async clear() { throw new Error("offline"); },
      },
      filePath,
    });
    await fallback.set(credential);

    await store.clear();
    expect(native.clears).toBe(1);
    expect(await store.get()).toBeNull();
    expect(() => statSync(filePath)).toThrow();
  });
});
