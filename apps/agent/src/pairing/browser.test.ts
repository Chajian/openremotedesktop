import { describe, expect, it } from "vitest";
import { verificationLink } from "./browser.js";

describe("browser pairing assistance", () => {
  const server = new URL("https://remote.example.com");
  it("prefills only an expiring human code under the same server origin", () => {
    const url = verificationLink(server, "https://remote.example.com/device", "ABCD-2345");
    expect(url).toBe("https://remote.example.com/device?code=ABCD-2345");
    expect(url).not.toContain("refreshCredential");
    expect(url).not.toContain("deviceCode");
  });
  it("rejects different origins, unexpected URLs, and malformed codes", () => {
    expect(() => verificationLink(server, "https://phish.example/device", "ABCD-2345")).toThrow();
    expect(() => verificationLink(server, "https://remote.example.com/evil", "ABCD-2345")).toThrow();
    expect(() => verificationLink(server, "https://remote.example.com/device", "INVALID!")).toThrow();
  });
});
