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
    return this.request<DeviceAccessResponse>("/api/device-auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshCredential }),
    }, signal);
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    try {
      // The same signal owns fetch and consumption of its response body.
      const response = await this.fetchImpl(new URL(path, this.baseUrl), {
        ...init, ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
      let body: unknown = null;
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        body = await response.json();
      } else {
        const text = await response.text();
        body = text || null;
      }
      signal?.throwIfAborted();
      if (!response.ok) throw new ServerRequestError(response.status, body);
      return body as T;
    } catch (error) {
      // Native response-body cancellation can use a different AbortError object.
      // Normalize only cancellation; a later stop must not hide an unrelated error.
      if (signal?.aborted && (error === signal.reason ||
        (error instanceof Error && error.name === "AbortError"))) throw signal.reason;
      throw error;
    }
  }
}
