import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../db/database.js";
import { DeviceAuthService } from "../devices/device-auth.js";
import { DeviceRepository } from "../devices/device-repository.js";
import { PairingService } from "../devices/pairing-service.js";
import { ConnectionRegistry } from "./connection-registry.js";
import {
  authenticateRelayToken,
  handleRelayPayload,
} from "./relay-route.js";
import { RequestBroker } from "./request-broker.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

class FakeSocket {
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  terminated = false;
  send(data: string) { this.sent.push(data); }
  close(code?: number, reason?: string) {
    const call: { code?: number; reason?: string } = {};
    if (code !== undefined) call.code = code;
    if (reason !== undefined) call.reason = reason;
    this.closeCalls.push(call);
  }
  terminate() { this.terminated = true; }
}

function fixture(nowValue = 1_000_000) {
  const dir = mkdtempSync(join(tmpdir(), "odr-relay-"));
  const db = createDatabase(join(dir, "server.sqlite"));
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
  const registry = new ConnectionRegistry({ now: () => now });
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const pairing = pairings.createPairing();
  const device = pairings.approvePairing(pairing.userCode, "Game PC", "test-owner");
  const poll = pairings.pollPairing(pairing.deviceCode);
  if (poll.status !== "approved") throw new Error("pairing did not approve");
  const token = auth.refreshDeviceAccess(poll.refreshCredential);

  return {
    devices,
    auth,
    registry,
    device,
    token,
    advance(ms: number) { now += ms; },
  };
}

describe("relay authentication and registry", () => {
  it("rejects missing, invalid and revoked tokens", () => {
    const { auth, devices, device, token } = fixture();

    expect(() => authenticateRelayToken(auth, undefined)).toThrow();
    expect(() => authenticateRelayToken(auth, "not-valid")).toThrow();

    devices.revokeDevice(device.id);
    expect(() => authenticateRelayToken(auth, token.accessToken)).toThrow();
  });

  it("tracks CONNECTED then AUTHENTICATED and replaces an old socket safely", () => {
    const { registry, device } = fixture();
    const first = new FakeSocket();
    const second = new FakeSocket();

    registry.attach(device.id, first as never);
    expect(registry.get(device.id)?.state).toBe("CONNECTED");
    registry.markAuthenticated(device.id, first as never);
    expect(registry.get(device.id)?.state).toBe("AUTHENTICATED");

    registry.attach(device.id, second as never);
    expect(first.closeCalls.at(-1)?.code).toBe(4001);
    registry.markAuthenticated(device.id, second as never);

    registry.detach(device.id, first as never);
    expect(registry.get(device.id)?.socket).toBe(second);
  });

  it("expires a stale READY socket after 45 seconds", () => {
    const { registry, device, advance } = fixture();
    const socket = new FakeSocket();

    registry.attach(device.id, socket as never);
    registry.markAuthenticated(device.id, socket as never);
    registry.markExecutorState(device.id, socket as never, "EXECUTOR_STARTING");
    registry.markExecutorState(device.id, socket as never, "READY");
    expect(registry.get(device.id)?.state).toBe("READY");

    advance(45_001);
    expect(registry.expireStale(45_000)).toEqual([device.id]);
    expect(socket.terminated).toBe(true);
    expect(registry.get(device.id)).toBeUndefined();
  });
});

describe("relay payload handling", () => {
  it("forwards tool results to the request broker", () => {
    const { registry, devices, device } = fixture();
    const socket = new FakeSocket();
    registry.attach(device.id, socket as never);
    registry.markAuthenticated(device.id, socket as never);
    const handled: unknown[] = [];
    const broker = { handleMessage: (message: unknown) => handled.push(message) };

    handleRelayPayload(
      registry,
      devices,
      device.id,
      socket as never,
      JSON.stringify({
        type: "tool.result",
        protocolVersion: 1,
        requestId: "8a4e7a20-8cad-4211-a277-8e0f4438d581",
        deviceId: device.id,
        result: { content: [] },
      }),
      broker as never,
    );

    expect(handled).toHaveLength(1);
  });

  it("rejects invalid protocol payloads without updating durable metadata", () => {
    const { registry, devices, device } = fixture();
    const socket = new FakeSocket();
    registry.attach(device.id, socket as never);
    registry.markAuthenticated(device.id, socket as never);

    expect(() =>
      handleRelayPayload(
        registry,
        devices,
        device.id,
        socket as never,
        JSON.stringify({ type: "totally.invalid", protocolVersion: 1 }),
      ),
    ).toThrow();

    expect(devices.findById(device.id)?.lastSeenAt).toBeNull();
  });

  it("updates runtime metadata and reaches READY only from valid messages", () => {
    const { registry, devices, device } = fixture();
    const socket = new FakeSocket();
    registry.attach(device.id, socket as never);
    registry.markAuthenticated(device.id, socket as never);

    handleRelayPayload(registry, devices, device.id, socket as never, JSON.stringify({
      type: "agent.hello",
      protocolVersion: 1,
      deviceId: device.id,
      agentVersion: "0.1.0",
      protocolRange: { min: 1, max: 1 },
      platform: "win32",
      desktopCommanderVersion: "0.2.52",
      capabilities: ["desktop-commander"],
    }));

    const afterHello = devices.findById(device.id)!;
    expect(afterHello.platform).toBe("win32");
    expect(afterHello.agentVersion).toBe("0.1.0");
    expect(afterHello.desktopCommanderVersion).toBe("0.2.52");
    expect(afterHello.lastSeenAt).not.toBeNull();

    handleRelayPayload(registry, devices, device.id, socket as never, JSON.stringify({
      type: "agent.executor_status",
      protocolVersion: 1,
      deviceId: device.id,
      state: "EXECUTOR_STARTING",
    }));
    expect(registry.get(device.id)?.state).toBe("EXECUTOR_STARTING");

    handleRelayPayload(registry, devices, device.id, socket as never, JSON.stringify({
      type: "agent.ready",
      protocolVersion: 1,
      deviceId: device.id,
      desktopCommanderVersion: "0.2.52",
      capabilities: ["desktop-commander"],
    }));
    expect(registry.get(device.id)?.state).toBe("READY");
  });
});


describe("relay request broker integration", () => {
  it("forwards agent tool responses to the request broker", async () => {
    const { registry, devices, device } = fixture();
    const socket = new FakeSocket();
    registry.attach(device.id, socket as never);
    registry.markAuthenticated(device.id, socket as never);
    registry.markExecutorState(device.id, socket as never, "EXECUTOR_STARTING");
    registry.markExecutorState(device.id, socket as never, "READY");
    const broker = new RequestBroker(registry);

    const pending = broker.call(
      device.id,
      "read_file",
      { path: "C:/tmp/a.txt" },
      { timeoutMs: 1000 },
    );
    const requestId = JSON.parse(socket.sent[0]!).requestId as string;

    handleRelayPayload(
      registry,
      devices,
      device.id,
      socket as never,
      JSON.stringify({
        type: "tool.result",
        protocolVersion: 1,
        requestId,
        deviceId: device.id,
        result: { content: [] },
      }),
      broker,
    );

    await expect(pending).resolves.toMatchObject({
      type: "tool.result",
      requestId,
    });
  });
});

describe("operation recovery negotiation", () => {
  it("offers recovery only for capable hello and enables it only after boot acknowledgement", () => {
    const { registry, devices, device } = fixture();
    const socket = new FakeSocket();
    registry.attach(device.id, socket as never);
    registry.markAuthenticated(device.id, socket as never);
    const receive = (message: object) => handleRelayPayload(registry, devices, device.id, socket as never, JSON.stringify({ protocolVersion: 1, deviceId: device.id, ...message }));
    expect(() => receive({type: "agent.recovery", bootId: "6d1cf056-7fc5-49d4-8930-f989aafd957b"})).toThrow();
    receive({ type: "agent.hello", agentVersion: "1", protocolRange: {min:1,max:1}, platform:"linux", desktopCommanderVersion:"0.2.52", capabilities:["operation-recovery-v1"] });
    expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual(expect.objectContaining({type:"server.notice", code:"OPERATION_RECOVERY_ENABLED"}));
    expect(registry.get(device.id)).not.toHaveProperty("bootId");
    receive({type:"agent.recovery", bootId:"6d1cf056-7fc5-49d4-8930-f989aafd957b"});
    expect(registry.get(device.id)).toHaveProperty("bootId", "6d1cf056-7fc5-49d4-8930-f989aafd957b");
  });
  it("rejects result and hello from replaced sockets before updating state", () => {
    const { registry, devices, device } = fixture();
    const old = new FakeSocket(); const current = new FakeSocket();
    registry.attach(device.id, old as never); registry.markAuthenticated(device.id, old as never);
    registry.attach(device.id, current as never); registry.markAuthenticated(device.id, current as never);
    const handled: unknown[] = [];
    expect(() => handleRelayPayload(registry, devices, device.id, old as never, JSON.stringify({type:"tool.result",protocolVersion:1,deviceId:device.id,requestId:"6d1cf056-7fc5-49d4-8930-f989aafd957b",result:{}}), {handleMessage: (m: unknown) => handled.push(m)})).toThrow();
    expect(handled).toEqual([]);
  });
});

it("accepts an executor watchdog replacement without severing the authenticated Relay connection", () => {
  const { registry, devices, device } = fixture();
  const socket = new FakeSocket();
  registry.attach(device.id, socket as never);
  registry.markAuthenticated(device.id, socket as never);
  registry.markExecutorState(device.id, socket as never, "EXECUTOR_STARTING");
  registry.markExecutorState(device.id, socket as never, "READY");
  const receive = (message: object) => handleRelayPayload(registry, devices, device.id,
    socket as never, JSON.stringify({protocolVersion: 1, deviceId: device.id, ...message}));
  receive({type: "agent.executor_status", state: "EXECUTOR_FAILED"});
  expect(registry.get(device.id)?.state).toBe("EXECUTOR_FAILED");
  receive({type: "agent.executor_status", state: "EXECUTOR_STARTING"});
  expect(registry.get(device.id)?.state).toBe("EXECUTOR_STARTING");
  receive({type: "agent.ready", desktopCommanderVersion: "0.2.52", capabilities: ["desktop-commander", "operation-recovery-v1"]});
  expect(registry.get(device.id)?.state).toBe("READY");
  expect(socket.closeCalls).toHaveLength(0);
});
