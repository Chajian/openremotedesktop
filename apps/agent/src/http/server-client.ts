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
