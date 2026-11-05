import {describe, expect, it} from "vitest";
import {createHash} from "node:crypto";
import {buildApp} from "../app.js";
import {createDatabase} from "../db/database.js";
import {OwnerRepository} from "../auth/owner-repository.js";
import {installerSource} from "../dashboard/installer.js";

const platforms = [["mac", "macos.command", "OpenRemote-Support.command", "macos.sh"],
  ["linux", "linux.sh", "OpenRemote-Support.sh", "linux.sh"]] as const;
async function fixture(enabled = true, install = true, version = "0.1.6") {
  const db = createDatabase(":memory:");
  const app = buildApp({db,config:{databasePath:":memory:", environment:"test",
    publicBaseUrl:new URL("https://remote.example.com"), additionalPublicBaseUrls:[new URL("https://new.example.com")],
    supportEnabled:enabled, agentInstallEnabled:install, supportAgentVersion:version}});
  await new OwnerRepository(db).bootstrapOwner({password:"fixture-secret-passphrase"});
  const login = await app.inject({method:"POST",url:"/api/login",payload:{password:"fixture-secret-passphrase"}});
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const page = await app.inject({url:"/dashboard/support",headers:{cookie}});
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? "";
  const created = await app.inject({method:"POST",url:"/dashboard/support/create",headers:{cookie},payload:{csrf,label:"Cross-platform fixture"}});
  const invite = /\/support\/invite\/([A-Za-z0-9_-]{32})/.exec(created.body)?.[1] ?? "X".repeat(32);
  return {app,db,created,invite,async dispose(){await app.close();db.close();}};
}

describe("POSIX support invitation downloads", () => {
  it.each(platforms)("serves %s file and commands with mirror selection without redeeming the invitation", async (os, suffix, filename, installer) => {
    const f = await fixture();
    try {
      const path = `/support/invite/${f.invite}`;
      expect(f.created.body).toContain(`${path}/${suffix}`);
      expect(f.created.body).toContain(`${path}/${suffix}?downloadSource=npmmirror`);
      const headers = {host:"new.example.com", "x-forwarded-host":"spoof.example.com"};
      const download = await f.app.inject({url:`${path}/${suffix}?downloadSource=npmmirror`,headers});
      expect(download.statusCode).toBe(200);
      expect(download.headers["content-disposition"]).toBe(`attachment; filename="${filename}"`);
      expect(download.headers["cache-control"]).toBe("no-store");
      expect(download.headers["referrer-policy"]).toBe("no-referrer");
      expect(download.body).toMatch(/^#!\/usr\/bin\/env bash\n/);
      expect(download.body).toContain(`https://new.example.com/install/${installer}`);
      expect(download.body).toContain(createHash("sha256").update(installerSource(os)).digest("hex"));
      expect(download.body).toContain("--accept-support");
      expect(download.body).toContain("--download-source 'npmmirror'");
      expect(download.body).not.toContain("spoof.example.com");
      const page = await f.app.inject({url:`${path}?os=${os}&downloadSource=npmmirror`,headers});
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain(`${path}/${suffix}?downloadSource=npmmirror`);
      expect(page.body).toContain("--support-invite");
      expect(page.body).toContain("--download-source");
      expect(page.body).toContain("os=mac&amp;downloadSource=npmmirror");
      expect(page.body).toContain("os=linux&amp;downloadSource=npmmirror");
      expect(page.body).toContain(`bash ~/Downloads/${filename}`);
      expect(page.body).not.toContain("PowerShell");
      expect((f.db.prepare("SELECT count(*) AS n FROM devices").get() as {n:number}).n).toBe(0);
      expect((await f.app.inject({url:`/api/support/invite/${f.invite}`})).statusCode).toBe(200);
      f.db.prepare("UPDATE support_sessions SET invite_expires_at=0").run();
      expect((await f.app.inject({url:`${path}/${suffix}`})).statusCode).toBe(410);
    } finally {await f.dispose();}
  });

  it.each(platforms)("rejects %s downloads after join and end, and ignores unsupported source values", async (os, suffix) => {
    const f = await fixture();
    try {
      const path = `/support/invite/${f.invite}`;
      const download = await f.app.inject({url:`${path}/${suffix}?downloadSource=untrusted`,headers:{host:"spoof.example.com"}});
      expect(download.statusCode).toBe(200);
      expect(download.body).toContain("https://remote.example.com/install/");
      expect(download.body).not.toContain("npmmirror");
      expect(download.body).not.toContain("spoof.example.com");
      const fallback = await f.app.inject({url:`${path}?os=freebsd`});
      expect(fallback.body).toContain(`${path}/windows.cmd`);
      const joined = await f.app.inject({method:"POST",url:"/api/support/join",
        payload:{invite:f.invite,deviceName:"Support fixture",platform:os === "mac" ? "darwin" : "linux"}});
      expect(joined.statusCode).toBe(201);
      expect((await f.app.inject({url:`${path}/${suffix}`})).statusCode).toBe(409);
      const stopped = await f.app.inject({method:"POST",url:"/api/support/stop",payload:{refreshCredential:joined.json().refreshCredential}});
      expect(stopped.statusCode).toBe(204);
      expect((await f.app.inject({url:`${path}/${suffix}`})).statusCode).toBe(404);
    } finally {await f.dispose();}
  });

  it.each(platforms)("gates %s launcher by feature flags and minimum package version", async (_os, suffix) => {
    for (const [enabled, install, version] of [[false,true,"0.1.6"],[true,false,"0.1.6"],[true,true,"0.1.5"]] as const) {
      const f = await fixture(enabled, install, version);
      try {
        expect((await f.app.inject({url:`/support/invite/${f.invite}/${suffix}`})).statusCode).toBe(404);
      } finally {await f.dispose();}
    }
  });
});
