import type { NativeCredentialBackend } from "./credential-store.js";

const SERVICE = "open-desktop-remote";
const ACCOUNT = "device";

export class KeyringCredentialBackend implements NativeCredentialBackend {
  private async entry() {
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry(SERVICE, ACCOUNT);
  }

  async get(): Promise<string | null> {
    const entry = await this.entry();
    try {
      return entry.getPassword();
    } catch {
      return null;
    }
  }

  async set(value: string): Promise<void> {
    const entry = await this.entry();
    entry.setPassword(value);
  }

  async clear(): Promise<void> {
    const entry = await this.entry();
    try {
      entry.deletePassword();
    } catch {
      // Missing keyring entries are already clear.
    }
  }
}
