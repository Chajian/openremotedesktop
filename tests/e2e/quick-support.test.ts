import {describe, expect, it} from "vitest";
import {connectMcpClient, startTestServer, waitFor} from "./helpers/test-server.js";
import {startFakeAgent} from "./helpers/test-agent.js";

const csrf = (html:string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
const listed = (x:unknown) => ((x as {structuredContent?:{
  devices?:Array<{id:string;state:string}>}}).structuredContent?.devices ?? []);

describe("temporary customer support",()=>{
  it("supports two approved AI clients and disconnects both when the owner ends support",async()=>{
    const server=await startTestServer({supportEnabled:true});
    let agent:Awaited<ReturnType<typeof startFakeAgent>>|undefined;
    let clientA:Awaited<ReturnType<typeof connectMcpClient>>|undefined;
    let clientB:Awaited<ReturnType<typeof connectMcpClient>>|undefined;
    try {
      const cookie=await server.bootstrapAndLogin();
      const tokenA=await server.issueMcpAccessToken(cookie);
      const tokenB=await server.issueMcpAccessToken(cookie);
      const page=await fetch(new URL("/dashboard/support",server.baseUrl),{headers:{cookie}});
      const created=await fetch(new URL("/dashboard/support/create",server.baseUrl),{
        method:"POST",headers:{cookie,"content-type":"application/x-www-form-urlencoded"},
        body:new URLSearchParams({label:"Customer diagnostic",csrf:csrf(await page.text())}),
      });
      expect(created.status).toBe(200);
      const content=await created.text();
      const invite=/\/support\/invite\/([A-Za-z0-9_-]{32})/.exec(content)?.[1];
      expect(invite).toHaveLength(32);
      const join=await fetch(new URL("/api/support/join",server.baseUrl),{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({invite,deviceName:"Windows Customer",platform:"win32"}),
      });
      expect(join.status).toBe(201);
      const joined=await join.json() as {deviceId:string;refreshCredential:string};
      agent=await startFakeAgent({serverUrl:server.baseUrl.toString(),
        deviceId:joined.deviceId,refreshCredential:joined.refreshCredential},"SUPPORT");
      clientA=await connectMcpClient(server.baseUrl,tokenA);
      clientB=await connectMcpClient(server.baseUrl,tokenB);
      await waitFor(async()=>listed(await clientA!.callTool({name:"list_devices",arguments:{}}))
        .some(d=>d.id===joined.deviceId&&d.state==="READY"),10_000);
      const both=await Promise.all([clientA,clientB].map(c=>c!.callTool({
        name:"read_file",arguments:{deviceId:joined.deviceId,path:"C:/customer-support-fixture.txt"},
      })));
      expect(both.every(r=>!r.isError)).toBe(true);
      expect((both[0] as {structuredContent?:Record<string,unknown>}).structuredContent)
        .toMatchObject({label:"SUPPORT"});
      const session=(server.db.prepare("SELECT id FROM support_sessions").get() as {id:string}).id;
      const confirm=await fetch(new URL(`/dashboard/support/${session}/end`,server.baseUrl),{headers:{cookie}});
      expect(confirm.status).toBe(200);
      const end=await fetch(new URL(`/dashboard/support/${session}/end`,server.baseUrl),{
        method:"POST",redirect:"manual",headers:{cookie,"content-type":"application/x-www-form-urlencoded"},
        body:new URLSearchParams({csrf:csrf(await confirm.text())}),
      });
      expect(end.status).toBe(303);
      await waitFor(async()=>server.relayRegistry.get(joined.deviceId)===undefined,5_000);
      const after=await clientB.callTool({name:"list_devices",arguments:{}});
      expect(listed(after).some(d=>d.id===joined.deviceId)).toBe(false);
      const failed=await clientA.callTool({name:"read_file",
        arguments:{deviceId:joined.deviceId,path:"C:/customer-support-fixture.txt"}});
      expect(failed.isError).toBe(true);
      const refresh=await fetch(new URL("/api/device-auth/refresh",server.baseUrl),{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({refreshCredential:joined.refreshCredential}),
      });
      expect(refresh.status).toBe(401);
    } finally {
      await clientA?.close();
      await clientB?.close();
      await agent?.stop();
      await server.close();
    }
  });
});
