import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/database.js";
import { DeviceAuthService } from "./device-auth.js";
import { DeviceRepository } from "./device-repository.js";
import { PairingService } from "./pairing-service.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function fixture(nowValue = 2_000_000) {
  const dir = mkdtempSync(join(tmpdir(), "odr-device-management-"));
  const databasePath = join(dir, "server.sqlite");
  const db = createDatabase(databasePath);
  let now = nowValue;
  db.prepare("INSERT INTO owner (id,password_hash,created_at) VALUES ('test-owner','disabled',0)").run();
  const devices = new DeviceRepository(db);
  const pairings = new PairingService(
    db,
    devices,
    new URL("https://remote.example.com"),
    { now: () => now },
  );
  const auth = new DeviceAuthService(db, devices, { now: () => now });

  const pairing = pairings.createPairing();
  const device = pairings.approvePairing(pairing.userCode, "Game PC", "test-owner");
  const poll = pairings.pollPairing(pairing.deviceCode);
  if (poll.status !== "approved") throw new Error("expected pairing approval");

  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    db,
    devices,
    auth,
    device,
    refreshCredential: poll.refreshCredential,
    advance(ms: number) {
      now += ms;
    },
  };
}

async function appFixture() {
  const dir = mkdtempSync(join(tmpdir(), "odr-device-management-app-"));
  const databasePath = join(dir, "server.sqlite");
  const db = createDatabase(databasePath);
  const app = buildApp({
    db,
    config: {
      databasePath,
      publicBaseUrl: new URL("https://remote.example.com"),
      environment: "test",
    },
  });
  cleanups.push(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  await app.inject({
    method: "POST",
    url: "/api/bootstrap",
    payload: { password: "correct-password" },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { password: "correct-password" },
  });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;

  async function pair(name: string) {
    const created = await app.inject({
      method: "POST",
      url: "/api/device-pairings",
    });
    const pairing = created.json();
    const approved = await app.inject({
      method: "POST",
      url: `/api/device-pairings/${pairing.userCode}/approve`,
      headers: { cookie },
      payload: { friendlyName: name },
    });
    const poll = await app.inject({
      method: "GET",
      url: `/api/device-pairings/poll?device_code=${encodeURIComponent(
        pairing.deviceCode,
      )}`,
    });
    return {
      deviceId: approved.json().deviceId as string,
      refreshCredential: poll.json().refreshCredential as string,
    };
  }

  return { app, db, cookie, pair };
}

describe("device auth", () => {
  it("issues a short-lived opaque access token for a valid refresh credential", () => {
    const { auth, db, device, refreshCredential } = fixture();

    const issued = auth.refreshDeviceAccess(refreshCredential);
    expect(issued.deviceId).toBe(device.id);
    expect(issued.accessToken.length).toBeGreaterThanOrEqual(40);
    expect(issued.expiresAt).toBe(2_000_000 + 15 * 60 * 1000);
    expect(auth.verifyDeviceAccess(issued.accessToken)).toEqual({
      deviceId: device.id,
    });

    const row = db
      .prepare(
        "SELECT token_hash AS tokenHash FROM device_access_tokens WHERE device_id = ?",
      )
      .get(device.id) as { tokenHash: string };
    expect(row.tokenHash).toBe(
      createHash("sha256").update(issued.accessToken).digest("hex"),
    );
    expect(row.tokenHash).not.toBe(issued.accessToken);
  });

  it("rejects invalid refresh credentials and expired access tokens", () => {
    const { auth, refreshCredential, advance } = fixture();

    expect(() => auth.refreshDeviceAccess("invalid")).toThrow();
    const issued = auth.refreshDeviceAccess(refreshCredential);
    advance(15 * 60 * 1000 + 1);
    expect(() => auth.verifyDeviceAccess(issued.accessToken)).toThrow();
  });

  it("re-checks device revocation for both refresh and access tokens", () => {
    const { auth, devices, device, refreshCredential } = fixture();
    const issued = auth.refreshDeviceAccess(refreshCredential);

    devices.revokeDevice(device.id);

    expect(() => auth.refreshDeviceAccess(refreshCredential)).toThrow();
    expect(() => auth.verifyDeviceAccess(issued.accessToken)).toThrow();
  });
});

describe("device repository", () => {
  it("renames without changing device id and keeps revoked devices visible", () => {
    const { devices, device } = fixture();

    const renamed = devices.renameDevice(device.id, "Renamed PC");
    expect(renamed.id).toBe(device.id);
    expect(renamed.name).toBe("Renamed PC");

    const revoked = devices.revokeDevice(device.id);
    expect(revoked.id).toBe(device.id);
    expect(revoked.revokedAt).toBeTypeOf("number");
    expect(devices.listDevices().map((item) => item.id)).toContain(device.id);
  });
});

describe("device management HTTP routes", () => {
  it("requires Owner session and supports list, rename and revoke", async () => {
    const { app, cookie, pair } = await appFixture();
    const paired = await pair("Game PC");

    expect((await app.inject({ method: "GET", url: "/api/devices" })).statusCode)
      .toBe(401);

    const list = await app.inject({
      method: "GET",
      url: "/api/devices",
      headers: { cookie },
    });
    expect(list.json()).toMatchObject([{ id: paired.deviceId, name: "Game PC" }]);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/devices/${paired.deviceId}`,
      headers: { cookie },
      payload: { name: "Renamed PC" },
    });
    expect(renamed.json()).toMatchObject({
      id: paired.deviceId,
      name: "Renamed PC",
    });

    const revoked = await app.inject({
      method: "POST",
      url: `/api/devices/${paired.deviceId}/revoke`,
      headers: { cookie },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().revokedAt).toBeTypeOf("number");
  });

  it("refreshes agent access anonymously and revoke-all invalidates every device", async () => {
    const { app, cookie, pair } = await appFixture();
    const first = await pair("One");
    const second = await pair("Two");

    const token = await app.inject({
      method: "POST",
      url: "/api/device-auth/refresh",
      payload: { refreshCredential: first.refreshCredential },
    });
    expect(token.statusCode).toBe(200);
    expect(token.json()).toMatchObject({ deviceId: first.deviceId });
    expect(token.json().accessToken).toBeTypeOf("string");

    const revokeAll = await app.inject({
      method: "POST",
      url: "/api/devices/revoke-all",
      headers: { cookie },
    });
    expect(revokeAll.statusCode).toBe(200);

    for (const credential of [first.refreshCredential, second.refreshCredential]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/device-auth/refresh",
        payload: { refreshCredential: credential },
      });
      expect(response.statusCode).toBe(401);
    }
  });
});
