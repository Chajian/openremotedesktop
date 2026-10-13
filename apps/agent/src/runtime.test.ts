import { describe, expect, it, vi } from "vitest";
import type { DeviceCredential } from "./credentials/credential-store.js";
import { runAgentConnect } from "./runtime.js";

describe("runAgentConnect", () => {
  it("pairs/loads a credential, runs relay, and closes the executor", async () => {
    const credential: DeviceCredential = {
      serverUrl: "https://remote.example.com/",
      deviceId: "11111111-1111-4111-8111-111111111111",
      refreshCredential: "refresh-secret",
    };
    const ensureCredential = vi.fn(async () => credential);
    const close = vi.fn(async () => undefined);
    const executor = { close };
    const run = vi.fn(async (_signal: AbortSignal) => undefined);
    const createRelay = vi.fn(() => ({ run }));
    const store = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    const io = { showVerification: vi.fn() };
    const signal = new AbortController().signal;

    await runAgentConnect(new URL("https://remote.example.com"), signal, {
      store,
      io,
      ensureCredential,
      createExecutor: () => executor as never,
      createRelay: createRelay as never,
    });

    expect(ensureCredential).toHaveBeenCalledWith(
      new URL("https://remote.example.com"),
      store,
      io,
    );
    expect(createRelay).toHaveBeenCalledWith(credential, executor);
    expect(run).toHaveBeenCalledWith(signal);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("always closes the executor when the relay run fails", async () => {
    const close = vi.fn(async () => undefined);
    const failure = new Error("relay failed");

    await expect(
      runAgentConnect(
        new URL("https://remote.example.com"),
        new AbortController().signal,
        {
          store: {
            get: async () => null,
            set: async () => undefined,
            clear: async () => undefined,
          },
          io: { showVerification: () => undefined },
          ensureCredential: async () => ({
            serverUrl: "https://remote.example.com/",
            deviceId: "11111111-1111-4111-8111-111111111111",
            refreshCredential: "refresh-secret",
          }),
          createExecutor: () => ({ close }) as never,
          createRelay: () =>
            ({
              run: async () => {
                throw failure;
              },
            }) as never,
        },
      ),
    ).rejects.toBe(failure);

    expect(close).toHaveBeenCalledTimes(1);
  });
});
