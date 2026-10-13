import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DeviceCredential } from "./credential-store.js";

export function credentialFileMode(
  platform: NodeJS.Platform,
): number | undefined {
  return platform === "win32" ? undefined : 0o600;
}

export class FileCredentialStore {
  constructor(
    private readonly path: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async get(): Promise<DeviceCredential | null> {
    try {
      const raw = await readFile(this.path, "utf8");
      return JSON.parse(raw) as DeviceCredential;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async set(value: DeviceCredential): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const mode = credentialFileMode(this.platform);
    await writeFile(
      this.path,
      JSON.stringify(value),
      mode === undefined ? { encoding: "utf8" } : { encoding: "utf8", mode },
    );
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
