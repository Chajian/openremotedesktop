import { homedir } from "node:os";
import { join } from "node:path";

export function defaultCredentialPath(): string {
  return join(homedir(), ".open-desktop-remote", "device.json");
}
