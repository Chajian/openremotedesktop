import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ToolResultMessage } from "@open-desktop-remote/protocol";
import type { WebSocket } from "ws";
import { ConnectionRegistry } from "./connection-registry.js";
import { PreDispatchRejectedError, RelayRequestError, RequestBroker } from "./request-broker.js";

const deviceId = "6d1cf056-7fc5-49d4-8930-f989aafd957b";

class FakeSocket {
  sent: string[] = [];
  close() {}
  terminate() {}
  send(value: string) {
    this.sent.push(value);
  }
}

function readyFixture() {
  const registry = new ConnectionRegistry();
  const socket = new FakeSocket();
  registry.attach(deviceId, socket as unknown as WebSocket);
  registry.markAuthenticated(deviceId, socket as unknown as WebSocket);
  registry.markExecutorState(deviceId, socket as unknown as WebSocket, "EXECUTOR_STARTING");
  registry.markExecutorState(deviceId, socket as unknown as WebSocket, "READY");
  return { registry, socket };
}

function codeOf(error: unknown): string | undefined {
  return error instanceof RelayRequestError ? error.code : undefined;
}

describe("RequestBroker", () => {
  it("rejects calls before dispatch when a device is offline or not READY", async () => {
    const offline = new RequestBroker(new ConnectionRegistry());
    await expect(
      offline.call(deviceId, "read_file", {}, { timeoutMs: 50 }),
    ).rejects.toSatisfy((error: unknown) => codeOf(error) === "DEVICE_OFFLINE");

    const registry = new ConnectionRegistry();
    const socket = new FakeSocket();
    registry.attach(deviceId, socket as unknown as WebSocket);
    registry.markAuthenticated(deviceId, socket as unknown as WebSocket);
    const notReady = new RequestBroker(registry);
    await expect(
      notReady.call(deviceId, "read_file", {}, { timeoutMs: 50 }),
    ).rejects.toSatisfy((error: unknown) => codeOf(error) === "DEVICE_NOT_READY");
    expect(socket.sent).toHaveLength(0);
  });

  it("resolves a dispatched request from a matching tool.result", async () => {
    const { registry, socket } = readyFixture();
    const broker = new RequestBroker(registry);
    const pending = broker.call(deviceId, "read_file", { path: "a" }, { timeoutMs: 200 });
    const sent = JSON.parse(socket.sent[0]!) as { requestId: string };

    const result: ToolResultMessage = {
      type: "tool.result",
      protocolVersion: 1,
      requestId: sent.requestId,
      deviceId,
      result: { content: [] },
    };
    broker.handleMessage(result);

    await expect(pending).resolves.toEqual(result);
  });

  it("marks a dispatched call EXECUTION_UNKNOWN when its socket disconnects and never replays it", async () => {
    const { registry, socket } = readyFixture();
    const broker = new RequestBroker(registry);
    const pending = broker.call(deviceId, "write_file", { path: "a" }, { timeoutMs: 200 });
    expect(socket.sent).toHaveLength(1);

    broker.handleDisconnect(deviceId, socket as unknown as WebSocket);
    await expect(pending).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === "EXECUTION_UNKNOWN",
    );

    const replacement = new FakeSocket();
    registry.attach(deviceId, replacement as unknown as WebSocket);
    registry.markAuthenticated(deviceId, replacement as unknown as WebSocket);
    expect(replacement.sent).toHaveLength(0);
  });

  it("sends tool.cancel and rejects the upstream request as REQUEST_CANCELLED", async () => {
    const { registry, socket } = readyFixture();
    const broker = new RequestBroker(registry);
    const pending = broker.call(deviceId, "read_file", {}, { timeoutMs: 200 });
    const requestId = (JSON.parse(socket.sent[0]!) as { requestId: string }).requestId;

    broker.cancel(requestId);

    expect(JSON.parse(socket.sent[1]!)).toMatchObject({
      type: "tool.cancel",
      requestId,
      deviceId,
    });
    await expect(pending).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === "REQUEST_CANCELLED",
    );
  });

  it("returns REQUEST_TIMEOUT without replay and ignores a late result", async () => {
    const { registry, socket } = readyFixture();
    const broker = new RequestBroker(registry);
    const pending = broker.call(deviceId, "read_file", {}, { timeoutMs: 5 });
    const requestId = (JSON.parse(socket.sent[0]!) as { requestId: string }).requestId;

    await expect(pending).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === "REQUEST_TIMEOUT",
    );

    expect(() =>
      broker.handleMessage({
        type: "tool.result",
        protocolVersion: 1,
        requestId,
        deviceId,
        result: { content: [{ type: "text", text: "late" }] },
      }),
    ).not.toThrow();
    expect(socket.sent).toHaveLength(1);
  });

  it("uses distinct request ids for concurrent calls", async () => {
    const { registry, socket } = readyFixture();
    const broker = new RequestBroker(registry);
    const first = broker.call(deviceId, "read_file", {}, { timeoutMs: 200 });
    const second = broker.call(deviceId, "read_file", {}, { timeoutMs: 200 });
    const [a, b] = socket.sent
      .slice(0, 2)
      .map((raw) => JSON.parse(raw) as { requestId: string });
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.requestId).not.toBe(b!.requestId);

    broker.cancel(a!.requestId);
    broker.cancel(b!.requestId);
    await Promise.allSettled([first, second]);
  });
});

describe("recovery queries",()=>{
 it("correlates every identity including current exact socket and strips unrequested results",async()=>{
  const {registry,socket}=readyFixture(); const broker=new RequestBroker(registry); const bootId=randomUUID(); registry.get(deviceId)!.bootId=bootId;
  const requestId=randomUUID(); const pending=broker.query(deviceId,requestId,bootId,false);
  const query=JSON.parse(socket.sent[0]!); const status={...query,type:"operation.status",snapshot:{state:"completed",completedAt:1,cancelRequested:false,outcome:"success",payload:{status:"available",response:{type:"tool.result",protocolVersion:1,requestId,deviceId,result:{secret:true}}}}};
  broker.handleStatus(status,new FakeSocket() as never);
  broker.handleStatus({...status,queryId:randomUUID()},socket as never);
  broker.handleStatus({...status,requestId:randomUUID()},socket as never);
  broker.handleStatus({...status,bootId:randomUUID()},socket as never);
  let settled=false; void pending.then(()=>{settled=true;}); await Promise.resolve(); expect(settled).toBe(false);
  broker.handleStatus(status,socket as never); await expect(pending).resolves.toMatchObject({snapshot:{payload:{status:"available"}}});
  expect((await pending).snapshot).not.toHaveProperty("payload.response");
 });
 it("bounds outstanding read-only queries at 64 and releases them on disconnect",async()=>{
  const {registry,socket}=readyFixture(); const broker=new RequestBroker(registry); const bootId=randomUUID(); registry.get(deviceId)!.bootId=bootId;
  const pending=Array.from({length:64},()=>broker.query(deviceId,randomUUID(),bootId,true));
  await expect(broker.query(deviceId,randomUUID(),bootId,true)).rejects.toThrow("capacity"); expect(socket.sent).toHaveLength(64);
  broker.handleDisconnect(deviceId,socket as never); const results=await Promise.allSettled(pending); expect(results.every(x=>x.status==="rejected")).toBe(true);
 });
});

it("expires a query after five seconds without sending any execution or retry",async()=>{
 vi.useFakeTimers();
 try {
 const {registry,socket}=readyFixture();const broker=new RequestBroker(registry);const bootId=randomUUID();registry.get(deviceId)!.bootId=bootId;
 const pending=broker.query(deviceId,randomUUID(),bootId,true);const rejected=expect(pending).rejects.toMatchObject({code:"REQUEST_TIMEOUT"});
 await vi.advanceTimersByTimeAsync(5000);await rejected;expect(socket.sent).toHaveLength(1);expect(JSON.parse(socket.sent[0]!).type).toBe("operation.query");
 } finally {vi.useRealTimers();}
});

it("bounds call waiters independently of query capacity and releases a cancelled slot",async()=>{
 const {registry,socket}=readyFixture();const broker=new RequestBroker(registry,{maxPendingCalls:1});
 const first=broker.call(deviceId,"read_file",{},{timeoutMs:1000});
 await expect(broker.call(deviceId,"read_file",{},{timeoutMs:1000})).rejects.toMatchObject({code:"REQUEST_TIMEOUT",details:{reason:"capacity"}});
 expect(socket.sent).toHaveLength(1);broker.cancel(JSON.parse(socket.sent[0]!).requestId);await expect(first).rejects.toMatchObject({code:"REQUEST_CANCELLED"});
 const second=broker.call(deviceId,"read_file",{},{timeoutMs:1000});broker.cancel(JSON.parse(socket.sent[2]!).requestId);await expect(second).rejects.toMatchObject({code:"REQUEST_CANCELLED"});
});

it("distinguishes a capacity refusal from a sent request", async () => {
  const { registry, socket } = readyFixture();
  const broker = new RequestBroker(registry, { maxPendingCalls: 0 });
  const caught = await broker.call(deviceId, "write_file", {}, { timeoutMs: 100 }).catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(PreDispatchRejectedError);
  expect(caught).toMatchObject({ details: { dispatched: false, reason: "capacity" } });
  expect(socket.sent).toHaveLength(0);
});
