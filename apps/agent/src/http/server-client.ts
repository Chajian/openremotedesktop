export type SupportPreviewResponse = {
  label: string; inviteExpiresAt: number; access: "full";
};
export type SupportJoinResponse = {
  deviceId: string; refreshCredential: string; sessionId: string;
};
export type SupportStatusResponse =
  | {state:"active"}
  | {state:"ended";reason:"owner"|"customer"};

export type PairingCreateResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export type PairingPollResponse =
  | { status: "pending"; interval: number }
  | { status: "expired" }
  | { status: "invalid" }
  | { status: "credential_already_issued"; deviceId: string }
  | {
      status: "approved";
      deviceId: string;
      refreshCredential: string;
    };

export type DeviceAccessResponse = {
  accessToken: string;
  expiresAt: number;
  deviceId: string;
};

export class ServerRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`Server request failed with status ${status}`);
    this.name = "ServerRequestError";
  }
}

// These errors deliberately retain no response body or parser/transport cause.
export class ServerResponseError extends Error {
  constructor() {
    super("Server returned an invalid response.");
    this.name = "ServerResponseError";
  }
}

export class ServerTransportError extends Error {
  constructor() {
    super("Server request transport failed.");
    this.name = "ServerTransportError";
  }
}

export class ServerClient {
  constructor(
    private readonly baseUrl: URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async supportPreview(invite: string, signal?: AbortSignal): Promise<SupportPreviewResponse> {
    const result = await this.request<unknown>(`/api/support/invite/${encodeURIComponent(invite)}`,
      {method:"GET"}, signal);
    if (!result || typeof result !== "object" || !("label" in result) ||
        typeof result.label !== "string" || !("inviteExpiresAt" in result) ||
        typeof result.inviteExpiresAt !== "number" || !Number.isFinite(result.inviteExpiresAt) ||
        !("access" in result) || result.access !== "full") throw new ServerResponseError();
    return result as SupportPreviewResponse;
  }

  async joinSupport(invite: string, deviceName: string, platform: string,
    signal?: AbortSignal): Promise<SupportJoinResponse> {
    const result = await this.request<unknown>("/api/support/join", {
      method: "POST", headers: {"content-type":"application/json"},
      body: JSON.stringify({invite, deviceName, platform}),
    }, signal);
    if (!result || typeof result !== "object" || !("deviceId" in result) ||
        typeof result.deviceId !== "string" || !result.deviceId ||
        !("refreshCredential" in result) || typeof result.refreshCredential !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(result.refreshCredential) ||
        !("sessionId" in result) || typeof result.sessionId !== "string" ||
        !result.sessionId) throw new ServerResponseError();
    return result as SupportJoinResponse;
  }

  /** Status uses the original refresh secret solely as evidence, not authority. */
  async supportStatus(refreshCredential: string,
    signal: AbortSignal = AbortSignal.timeout(5_000)): Promise<SupportStatusResponse> {
    const status = await this.request<unknown>("/api/support/status", {
      method: "POST", headers: {"content-type":"application/json"},
      body: JSON.stringify({refreshCredential}),
    }, signal);
    if (!status || typeof status !== "object" || !("state" in status))
      throw new ServerResponseError();
    if (status.state === "active") return {state:"active"};
    if (status.state === "ended" && "reason" in status &&
        (status.reason === "owner" || status.reason === "customer"))
      return {state:"ended",reason:status.reason};
    throw new ServerResponseError();
  }

  async stopSupport(refreshCredential: string, signal: AbortSignal = AbortSignal.timeout(5_000)): Promise<void> {
    await this.request<unknown>("/api/support/stop", {
      method: "POST", headers: {"content-type":"application/json"},
      body: JSON.stringify({refreshCredential}),
    }, signal);
  }

  async createPairing(signal?: AbortSignal): Promise<PairingCreateResponse> {
    return this.request<PairingCreateResponse>("/api/device-pairings", {
      method: "POST",
    }, signal);
  }

  async pollPairing(deviceCode: string, signal?: AbortSignal): Promise<PairingPollResponse> {
    const path = `/api/device-pairings/poll?device_code=${encodeURIComponent(
      deviceCode,
    )}`;
    return this.request<PairingPollResponse>(path, { method: "GET" }, signal);
  }

  async refreshDeviceAccess(
    refreshCredential: string,
    signal?: AbortSignal,
  ): Promise<DeviceAccessResponse> {
    const token = await this.request<unknown>("/api/device-auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshCredential }),
    }, signal);
    if (
      typeof token !== "object" || token === null ||
      !("accessToken" in token) || typeof token.accessToken !== "string" || !token.accessToken ||
      !("expiresAt" in token) || typeof token.expiresAt !== "number" || !Number.isFinite(token.expiresAt) ||
      !("deviceId" in token) || typeof token.deviceId !== "string" || !token.deviceId
    ) {
      throw new ServerResponseError();
    }
    return token as DeviceAccessResponse;
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const url = new URL(path, this.baseUrl);
    let response: Response;
    let text: string;
    try {
      // Only fetch and body I/O classify native TypeErrors as transport failures.
      response = await this.fetchImpl(url, {
        ...init, ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
      text = await response.text();
    } catch (error) {
      // Native response-body cancellation can use a different AbortError object.
      // Normalize only cancellation; a later stop must not hide an unrelated error.
      if (signal?.aborted && (error === signal.reason ||
        (error instanceof Error && error.name === "AbortError"))) throw signal.reason;
      if (error instanceof TypeError) throw new ServerTransportError();
      throw error;
    }
    signal?.throwIfAborted();
    let body: unknown = text || null;
    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      try {
        body = JSON.parse(text);
      } catch {
        // An unreadable error body must not hide an explicit HTTP rejection.
        if (response.ok) throw new ServerResponseError();
        body = null;
      }
    }
    if (!response.ok) throw new ServerRequestError(response.status, body);
    return body as T;
  }
}
