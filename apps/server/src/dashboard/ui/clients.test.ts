import { expect, it } from "vitest";
import { clientIdentity } from "./clients.js";
it.each([
 ["https://chatgpt.com/cb", "ChatGPT", "chatgpt.com", "known"],
 ["https://chat.openai.com/cb", "ChatGPT", "chat.openai.com", "known"],
 ["https://claude.ai/cb", "Claude", "claude.ai", "known"],
 ["https://chatgpt.com.evil.example/cb", null, "chatgpt.com.evil.example", "other"],
 ["http://localhost:6274/cb", null, "localhost:6274", "local"],
 ["http://[::1]:6274/cb", null, "[::1]:6274", "local"],
] as const)("labels only exact registered hosts: %s", (uri, name, host, kind) => {
  expect(clientIdentity(uri)).toEqual({ name, host, kind });
});
