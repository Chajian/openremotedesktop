import { describe, expect, it, vi } from "vitest";
import type {
  CredentialStore,
  DeviceCredential,
} from "../credentials/credential-store.js";
import { DeviceCredentialRejectedError, refreshRelayToken } from "../auth/device-token.js";
import { ServerClient } from "../http/server-client.js";
import {
  ensureDeviceCredential,
  pairDevice,
  PairingFailedError,
} from "./pair-device.js";

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function memoryStore(initial: DeviceCredential | null = null): CredentialStore & {
  sets: DeviceCredential[];
  clears: number;
} {
  let value = initial;
  const sets: DeviceCredential[] = [];
  return {
    sets,
    clears: 0,
    async get() { return value; },
    async set(next) { value = next; sets.push(next); },
    async clear() { value = null; this.clears += 1; },
  };
}

describe("agent pairing client", () => {
  it("starts pairing, displays verification data, waits server interval and stores once", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(201, {
        deviceCode: "device-code",
        userCode: "ABCD-2345",
        verificationUri: "https://remote.example.com/device",
        expiresIn: 600,
        interval: 5,
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        status: "pending",
        interval: 5,
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        status: "approved",
        deviceId: "6d1cf056-7fc5-49d4-8930-f989aafd957b",
        refreshCredential: "refresh-secret",
      }));
    const client = new ServerClient(
      new URL("https://remote.example.com"),
      fetchMock,
    );
    const shown = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const store = memoryStore();

    const credential = await ensureDeviceCredential(
      new URL("https://remote.example.com"),
      store,
      { showVerification: shown },
      { client, sleep },
    );

    expect(shown).toHaveBeenCalledWith({
      verificationUri: "https://remote.example.com/device",
      userCode: "ABCD-2345",
    });
    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(store.sets).toEqual([credential]);
    expect(credential).toEqual({
      serverUrl: "https://remote.example.com/",
      deviceId: "6d1cf056-7fc5-49d4-8930-f989aafd957b",
      refreshCredential: "refresh-secret",
    });
  });

  it("uses an existing credential for the same server without pairing", async () => {
    const existing: DeviceCredential = {
      serverUrl: "https://remote.example.com/",
      deviceId: "6d1cf056-7fc5-49d4-8930-f989aafd957b",
      refreshCredential: "refresh-secret",
    };
    const store = memoryStore(existing);
    const fetchMock = vi.fn();
    const client = new ServerClient(
      new URL("https://remote.example.com"),
      fetchMock,
    );

    expect(
      await ensureDeviceCredential(
        new URL("https://remote.example.com"),
        store,
        { showVerification: vi.fn() },
        { client, sleep: vi.fn() },
      ),
    ).toEqual(existing);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.sets).toHaveLength(0);
  });

  it("returns actionable errors for expired or already-issued pairing", async () => {
    for (const status of ["expired", "credential_already_issued"] as const) {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse(201, {
          deviceCode: "device-code",
          userCode: "ABCD-2345",
          verificationUri: "https://remote.example.com/device",
          expiresIn: 600,
          interval: 5,
        }))
        .mockResolvedValueOnce(jsonResponse(200, {
          status,
          deviceId: "6d1cf056-7fc5-49d4-8930-f989aafd957b",
        }));
      const client = new ServerClient(
        new URL("https://remote.example.com"),
        fetchMock,
      );

      await expect(
        pairDevice(
          new URL("https://remote.example.com"),
          { showVerification: vi.fn() },
          { client, sleep: vi.fn() },
        ),
      ).rejects.toBeInstanceOf(PairingFailedError);
    }
  });

  it("refreshes relay access and surfaces revoked credentials without retry loops", async () => {
    const credential: DeviceCredential = {
      serverUrl: "https://remote.example.com/",
      deviceId: "6d1cf056-7fc5-49d4-8930-f989aafd957b",
      refreshCredential: "refresh-secret",
    };
    const successClient = new ServerClient(
      new URL(credential.serverUrl),
      vi.fn().mockResolvedValue(jsonResponse(200, {
        accessToken: "opaque-access",
        expiresAt: 123456,
        deviceId: credential.deviceId,
      })),
    );
    expect(await refreshRelayToken(credential, successClient)).toEqual({
      accessToken: "opaque-access",
      expiresAt: 123456,
      deviceId: credential.deviceId,
    });

    const rejectedClient = new ServerClient(
      new URL(credential.serverUrl),
      vi.fn().mockResolvedValue(jsonResponse(401, {
        error: "INVALID_DEVICE_CREDENTIAL",
      })),
    );
    await expect(
      refreshRelayToken(credential, rejectedClient),
    ).rejects.toBeInstanceOf(DeviceCredentialRejectedError);
  });
});
