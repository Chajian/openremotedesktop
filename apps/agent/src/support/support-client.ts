import { hostname } from "node:os";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { CredentialStore } from "../credentials/credential-store.js";
import { ServerClient, ServerRequestError, type SupportPreviewResponse } from "../http/server-client.js";
import { runAgentConnect } from "../runtime.js";

export class SupportConsentDeniedError extends Error {}
type SupportApi = Pick<ServerClient, "supportPreview" | "joinSupport" | "stopSupport">;
type RunAgent = typeof runAgentConnect;
export type SupportConnectOptions = {
  client?: SupportApi;
  consent?: (preview: SupportPreviewResponse, signal: AbortSignal) => Promise<boolean>;
  runAgent?: RunAgent;
  deviceName?: string;
  platform?: string;
};

/** Customer approval is never implied by possessing or opening the invite URL. */
async function consoleConsent(preview: SupportPreviewResponse, signal: AbortSignal): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  console.log("OpenRemote temporary support: " + preview.label);
  console.log("Approved AI clients for this support account can read and modify files,");
  console.log("run terminal commands and start programs as the current OS user.");
  console.log("Press Ctrl+C any time to stop sharing. Continue only if you trust the requester.");
  const rl = createInterface({input: stdin, output: stdout});
  try {
    const response = await rl.question("Type YES to allow full remote support: ", {signal});
    return response.trim() === "YES";
  } finally { rl.close(); }
}

/** Support credentials must never be saved to the customer's permanent identity store. */
const noPersistentCredentials: CredentialStore = {
  async get() { throw new Error("Support mode cannot read stored identities"); },
  async set() { throw new Error("Support mode cannot persist credentials"); },
  async clear() { throw new Error("Support mode cannot modify stored identities"); },
};
export async function runSupportConnect(
  serverUrl: URL, invite: string, signal: AbortSignal,
  options: SupportConnectOptions = {},
): Promise<void> {
  signal.throwIfAborted();
  const client = options.client ?? new ServerClient(serverUrl);
  const preview = await client.supportPreview(invite, signal);
  signal.throwIfAborted();
  if (!await (options.consent ?? consoleConsent)(preview, signal)) {
    throw new SupportConsentDeniedError("Customer declined temporary support");
  }
  signal.throwIfAborted();
  const joined = await client.joinSupport(
    invite, options.deviceName ?? hostname(), options.platform ?? process.platform, signal,
  );
  const credential = {
    serverUrl: serverUrl.toString(), deviceId: joined.deviceId,
    refreshCredential: joined.refreshCredential,
  };
  let runtimeError: unknown;
  try {
    console.log("Support authorized. Connecting to Relay; press Ctrl+C to end sharing.");
    await (options.runAgent ?? runAgentConnect)(serverUrl, signal, {
      store: noPersistentCredentials,
      ensureCredential: async () => credential,
    });
  } catch (error) { runtimeError = error; }

  // Only the customer (Ctrl+C) or the support owner may end the session.
  // A transient or fatal Agent failure leaves the session offline for manual review.
  if (!signal.aborted) {
    if (runtimeError) throw runtimeError;
    return;
  }
  let stopError: unknown;
  try {
    // The Relay was cancelled; perform a bounded, independent revoke request.
    await client.stopSupport(joined.refreshCredential);
  } catch (error) {
    if (!(error instanceof ServerRequestError && error.status === 404)) stopError = error;
  }
  if (runtimeError && stopError) throw new AggregateError(
    [runtimeError, stopError], "Support runtime and revoke both failed");
  if (runtimeError) throw runtimeError;
  if (stopError) throw stopError;
}
