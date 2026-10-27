import {describe, expect, it, vi} from "vitest";
import type {ServerClient} from "../http/server-client.js";
import type {AgentConnectOptions} from "../runtime.js";
import {runSupportConnect} from "./support-client.js";

function fixture() {
  const client = {
    supportPreview:vi.fn(async()=>({label:"Customer Support",inviteExpiresAt:Date.now()+300_000,access:"full" as const})),
    joinSupport:vi.fn(async()=>({deviceId:"11111111-1111-4111-8111-111111111111",
      refreshCredential:"r".repeat(43),sessionId:"s1"})),
    stopSupport:vi.fn(async()=>undefined),
  };
  return client;
}

describe("customer support agent",()=>{
  it("requires local approval before using the invite",async()=>{
    const client=fixture();
    await expect(runSupportConnect(new URL("https://remote.example.com"),"i".repeat(32),
      new AbortController().signal,{client,consent:async()=>false})).rejects.toThrow(/declined/);
    expect(client.joinSupport).not.toHaveBeenCalled();
    expect(client.stopSupport).not.toHaveBeenCalled();
  });

  it("runs with only in-memory credentials and revokes on customer Ctrl+C",async()=>{
    const client=fixture();
    const controller=new AbortController();
    const runAgent=vi.fn(async(_url:URL,_signal:AbortSignal,options:AgentConnectOptions={})=>{
      expect(options.store).toBeDefined();
      await expect(options.store!.get()).rejects.toThrow(/cannot read/);
      await expect(options.store!.set({serverUrl:"",deviceId:"",refreshCredential:""})).rejects.toThrow(/persist/);
      expect(options.ensureCredential).toBeDefined();
      const credential=await options.ensureCredential!(new URL("https://remote.example.com"),
        options.store!,{showVerification(){}});
      expect(credential).toMatchObject({deviceId:"11111111-1111-4111-8111-111111111111",refreshCredential:"r".repeat(43)});
      controller.abort();
    });
    await runSupportConnect(new URL("https://remote.example.com"),"i".repeat(32),
      controller.signal,{
        client,consent:async()=>true,runAgent,
        deviceName:"Customer Windows",platform:"win32",
      });
    expect(client.joinSupport).toHaveBeenCalledWith("i".repeat(32),"Customer Windows","win32",expect.anything());
    expect(client.stopSupport).toHaveBeenCalledWith("r".repeat(43));
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("leaves support for creator to end after unexpected executor failure",async()=>{
    const client=fixture();
    await expect(runSupportConnect(new URL("https://remote.example.com"),"i".repeat(32),
      new AbortController().signal,{client,consent:async()=>true,
        runAgent:async()=>{throw new Error("executor failed")}})).rejects.toThrow("executor failed");
    expect(client.stopSupport).not.toHaveBeenCalled();
  });

  it("fails closed when the request is already cancelled",async()=>{
    const client=fixture();
    const controller=new AbortController();
    controller.abort();
    await expect(runSupportConnect(new URL("https://remote.example.com"),"i".repeat(32),
      controller.signal,{client,consent:async()=>true})).rejects.toBeDefined();
    expect(client.supportPreview).not.toHaveBeenCalled();
  });
});
