import { describe, expect, it } from "vitest";
import {
  ExecutorManager,
  RelayClient,
  parseAgentCommand,
} from "./index.js";

describe("agent public entry", () => {
  it("exports executor and relay lifecycle primitives", () => {
    expect(ExecutorManager).toBeTypeOf("function");
    expect(RelayClient).toBeTypeOf("function");
  });
});

describe("agent CLI", () => {
  it("parses agent connect --server", () => {
    expect(
      parseAgentCommand([
        "agent",
        "connect",
        "--server",
        "https://remote.example.com",
      ]),
    ).toEqual({
      command: "connect",
      serverUrl: new URL("https://remote.example.com"),
    });
  });

  it("rejects unsupported or incomplete commands", () => {
    expect(() => parseAgentCommand(["agent", "connect"])).toThrow();
    expect(() => parseAgentCommand(["agent", "unknown"])).toThrow();
  });
});
