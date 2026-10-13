import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore, serverCredentialScope, type NativeCredentialBackend } from "./credential-store.js";

const temp: string[] = [];
afterEach(async () => { for (const path of temp.splice(0)) await rm(path, { recursive: true, force: true }); });
function location(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "odr-scope-"));
  temp.push(dir);
  return join(dir, name);
}
function native(): NativeCredentialBackend {
  let value: string | null = null;
  return {
    get: async () => value,
    set: async (next) => { value = next; },
    clear: async () => { value = null; },
  };
}

describe("per-server device identity", () => {
  const a = new URL("https://alpha.example/");
  const b = new URL("https://beta.example/");
  const identity = (serverUrl: URL, deviceId: string) => ({
    serverUrl: serverUrl.toString(), deviceId, refreshCredential: "private-token-" + deviceId,
  });
  it("migrates the matching legacy identity without deleting the old entry or polluting another server", async () => {
    const original = identity(a, "existing-id");
    const legacyNative = native();
    const legacyFile = location("old.json");
    const legacy = createCredentialStore({ nativeBackend: legacyNative, filePath: legacyFile });
    await legacy.set(original);
    const scopedA = createCredentialStore({
      serverUrl: a, nativeBackend: native(), filePath: location("alpha.json"),
      legacyBackend: legacyNative, legacyFilePath: legacyFile,
    });
    const scopedB = createCredentialStore({
      serverUrl: b, nativeBackend: native(), filePath: location("beta.json"),
      legacyBackend: legacyNative, legacyFilePath: legacyFile,
    });
    expect(await scopedA.get()).toEqual(original);
    expect(await scopedB.get()).toBeNull();
    await scopedB.set(identity(b, "other-id"));
    expect((await scopedA.get())?.deviceId).toBe("existing-id");
    expect((await legacy.get())?.deviceId).toBe("existing-id");
    await expect(scopedB.set(original)).rejects.toThrow(/another server/);
  });
  it("generates deterministic and distinct server scopes", () => {
    expect(serverCredentialScope(new URL("https://alpha.example/"))).toBe(serverCredentialScope(a));
    expect(serverCredentialScope(a)).not.toBe(serverCredentialScope(b));
    expect(serverCredentialScope(a)).toMatch(/^[0-9a-f]{20}$/);
  });
});
