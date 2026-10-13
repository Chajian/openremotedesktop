import type { NativeCredentialBackend } from "./credential-store.js";

const SERVICE = "open-desktop-remote";
export class KeyringCredentialBackend implements NativeCredentialBackend {
  constructor(private readonly account = "device") {}
  private async entry() {
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry(SERVICE, this.account);
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
