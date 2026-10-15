import assert from "node:assert/strict";
import test from "node:test";
import { privateInformationKinds, privateOperationsPath, privacyFindingsInDiff } from "./private-data-policy.mjs";

test("reserved documentation addresses and example identities are allowed", () => {
  for (const line of [
    "https://example.com/mcp", "user@example.com", "ssh user@node.example.com",
    "203.0.113.8", "198.51.100.12", "192.0.2.5", "127.0.0.1",
  ]) assert.deepEqual(privateInformationKinds(line), [], line);
});

test("non-example Internet and private IPv4 addresses require review", () => {
  const publicIp = ["8", "8", "4", "4"].join(".");
  const privateIp = ["10", "21", "5", "8"].join(".");
  assert.ok(privateInformationKinds(`server=${publicIp}`).includes("non-example IP address"));
  assert.ok(privateInformationKinds(privateIp).includes("non-example IP address"));
});

test("private email and remote server access are flagged", () => {
  const email = ["owner", "@", "private-mail", ".corp"].join("");
  const server = ["ssh deploy", "@", "production-gateway", ".corp"].join("");
  assert.ok(privateInformationKinds(email).includes("non-example email address"));
  assert.ok(privateInformationKinds(server).includes("remote server login"));
});

test("home directories, private internal hosts, and labeled phone numbers are flagged", () => {
  const home = ["C:", "\\", "Users", "\\", "worker", "\\", "Documents", "\\"].join("");
  const internal = ["node", ".", "example", ".", "internal"].join("");
  const phone = ["phone: +1 ", "202 ", "555 ", "0100"].join("");
  assert.ok(privateInformationKinds(home).includes("personal home path"));
  assert.ok(privateInformationKinds(internal).includes("private infrastructure hostname"));
  assert.ok(privateInformationKinds(phone).includes("personal contact number"));
});

test("sensitive operational files are blocked regardless of extension case", () => {
  for (const file of ["server-private/inventory.md", "docs/.private/machine.txt", "infra/terraform.tfstate", "connections/vps.RDP"]) {
    assert.equal(privateOperationsPath(file), true, file);
  }
  assert.equal(privateOperationsPath("docs/architecture.md"), false);
});

test("new diff lines are scanned; deleted lines and example addresses are ignored", () => {
  const ip = ["8", "8", "4", "4"].join(".");
  const patch = `diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1,1 +1,2 @@\n-${ip}\n+203.0.113.20\n+server=${ip}\n`;
  const issues = privacyFindingsInDiff(patch);
  assert.deepEqual(issues, ["docs/a.md (non-example IP address)"]);
  assert.ok(!issues[0].includes(ip), "diagnostics must not print the matched value");
});
