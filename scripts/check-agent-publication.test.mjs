import assert from "node:assert/strict";
import test from "node:test";
import { assertAgentVersionAvailable } from "./check-agent-publication.mjs";

const candidate = { name: "open-desktop-remote-agent", version: "0.1.3" };

test("only an explicit npm 404 permits a new version", async () => {
  let lookups = 0;
  await assertAgentVersionAvailable(candidate, {
    fetchImpl: async (url, options) => {
      lookups++;
      assert.equal(url, "https://registry.npmjs.org/open-desktop-remote-agent/0.1.3");
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      return new Response('{"error":"version not found: 0.1.3"}', { status: 404 });
    },
  });
  assert.equal(lookups, 1);
});

for (const desktopCommanderVersion of ["0.2.52", "0.3.1"]) {
  test(`an existing version cannot be reused (published Desktop Commander ${desktopCommanderVersion})`, async () => {
    await assert.rejects(assertAgentVersionAvailable(candidate, {
      fetchImpl: async () => Response.json({
        ...candidate,
        dependencies: { "@wonderwhy-er/desktop-commander": desktopCommanderVersion },
      }),
    }), /open-desktop-remote-agent@0\.1\.3 is already published.*new version/i);
  });
}

for (const status of [204, 301, 401, 403, 429, 500, 503]) {
  test(`registry HTTP ${status} blocks staging instead of implying availability`, async () => {
    await assert.rejects(assertAgentVersionAvailable(candidate, {
      fetchImpl: async () => new Response(null, { status }),
    }), new RegExp(`registry.*HTTP ${status}`, "i"));
  });
}

for (const error of [new TypeError("fetch failed"), new DOMException("Timed out", "TimeoutError")]) {
  test(`registry ${error.name} blocks staging`, async () => {
    await assert.rejects(assertAgentVersionAvailable(candidate, {
      fetchImpl: async () => { throw error; },
    }), /could not verify.*npm registry/i);
  });
}

for (const pkg of [
  { ...candidate, name: "another-package" },
  { ...candidate, version: "0.1.3/invalid" },
  { ...candidate, version: "latest" },
  { ...candidate, version: "0.1.3-beta.1" },
]) {
  test(`invalid release identity is rejected before a registry lookup: ${pkg.name}@${pkg.version}`, async () => {
    await assert.rejects(assertAgentVersionAvailable(pkg, {
      fetchImpl: async () => { assert.fail("Invalid identity must not query npm"); },
    }), /expected open-desktop-remote-agent with a stable semver version/i);
  });
}
