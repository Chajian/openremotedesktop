import { homedir } from "node:os";
import { join } from "node:path";

export function defaultCredentialPath(scope?: string): string {
  return join(homedir(), ".open-desktop-remote", scope ? `device-${scope}.json` : "device.json");
}
