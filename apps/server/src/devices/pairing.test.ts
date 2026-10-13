import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDatabase } from "../db/database.js";
import { DeviceRepository } from "./device-repository.js";
import {
  PairingAlreadyApprovedError,
  PairingService,
} from "./pairing-service.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function fixture(nowValue = 1_000_000) {
  const dir = mkdtempSync(join(tmpdir(), "odr-pairing-"));
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
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    db,
    devices,
    pairings,
    advance(ms: number) {
      now += ms;
    },
  };
}

async function appFixture() {
  const dir = mkdtempSync(join(tmpdir(), "odr-pairing-app-"));
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
  return {
    app,
    db,
    cookie: String(login.headers["set-cookie"]).split(";")[0]!,
  };
}

describe("pairing service", () => {
  it("creates a high-entropy device code and short human-readable user code", () => {
    const { pairings } = fixture();
    const created = pairings.createPairing();

    expect(created.deviceCode.length).toBeGreaterThanOrEqual(40);
    expect(created.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(created.verificationUri).toBe(
      "https://remote.example.com/device",
    );
    expect(created.expiresIn).toBe(600);
    expect(created.interval).toBe(5);
  });

  it("reports pending before approval and expired after ten minutes", () => {
    const { pairings, advance } = fixture();
    const created = pairings.createPairing();

    expect(pairings.pollPairing(created.deviceCode)).toEqual({
      status: "pending",
      interval: 5,
    });

    advance(600_001);
    expect(pairings.pollPairing(created.deviceCode)).toEqual({
      status: "expired",
    });
  });

  it("approval creates an immutable device id and cannot be repeated", () => {
    const { pairings, devices } = fixture();
    const created = pairings.createPairing();

    const device = pairings.approvePairing(created.userCode, "Game PC", "test-owner");
    expect(device.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(devices.findById(device.id)?.name).toBe("Game PC");

    expect(() =>
      pairings.approvePairing(created.userCode, "Other name", "test-owner"),
    ).toThrow(PairingAlreadyApprovedError);
    expect(devices.findById(device.id)?.id).toBe(device.id);
  });

  it("returns the long-lived credential once and persists only its verifier", () => {
    const { pairings, db } = fixture();
    const created = pairings.createPairing();
    const device = pairings.approvePairing(created.userCode, "Game PC", "test-owner");

    const approved = pairings.pollPairing(created.deviceCode);
    expect(approved.status).toBe("approved");
    if (approved.status !== "approved") throw new Error("expected approved");
    expect(approved.deviceId).toBe(device.id);
    expect(approved.refreshCredential.length).toBeGreaterThanOrEqual(40);

    const row = db
      .prepare(
        "SELECT refresh_hash AS refreshHash FROM device_credentials WHERE device_id = ?",
      )
      .get(device.id) as { refreshHash: string };
    expect(row.refreshHash).toBe(
      createHash("sha256")
        .update(approved.refreshCredential)
        .digest("hex"),
    );
    expect(row.refreshHash).not.toBe(approved.refreshCredential);

    expect(pairings.pollPairing(created.deviceCode)).toEqual({
      status: "credential_already_issued",
      deviceId: device.id,
    });
  });
});

describe("pairing HTTP flow", () => {
  it("allows anonymous creation/poll but requires Owner session for approval", async () => {
    const { app } = await appFixture();

    const created = await app.inject({
      method: "POST",
      url: "/api/device-pairings",
    });
    expect(created.statusCode).toBe(201);
    const pairing = created.json();

    const pending = await app.inject({
      method: "GET",
      url: `/api/device-pairings/poll?device_code=${encodeURIComponent(
        pairing.deviceCode,
      )}`,
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().status).toBe("pending");

    const unauthenticated = await app.inject({
      method: "POST",
      url: `/api/device-pairings/${pairing.userCode}/approve`,
      payload: { friendlyName: "Game PC" },
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("lets the Owner approve and the Agent poll its credential", async () => {
    const { app, cookie } = await appFixture();
    const created = await app.inject({
      method: "POST",
      url: "/api/device-pairings",
    });
    const pairing = created.json();

    const approved = await app.inject({
      method: "POST",
      url: `/api/device-pairings/${pairing.userCode}/approve`,
      headers: { cookie },
      payload: { friendlyName: "Game PC" },
    });
    expect(approved.statusCode).toBe(200);
    const deviceId = approved.json().deviceId;

    const poll = await app.inject({
      method: "GET",
      url: `/api/device-pairings/poll?device_code=${encodeURIComponent(
        pairing.deviceCode,
      )}`,
    });
    expect(poll.statusCode).toBe(200);
    expect(poll.json()).toMatchObject({
      status: "approved",
      deviceId,
    });
    expect(poll.json().refreshCredential).toBeTypeOf("string");
  });
});
