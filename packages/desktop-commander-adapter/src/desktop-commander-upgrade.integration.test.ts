import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { DesktopCommanderClient } from "./desktop-commander-client.js";

const text = (result: CallToolResult) => result.content
  .filter((part) => part.type === "text")
  .map((part) => part.text)
  .join("\n");

// A real, two-page PDF with a font, byte-accurate xref and distinct page text.
// Keeping the fixture here avoids a browser/PDF-generator installation in CI.
function pdfFixture(): Buffer {
  const streams = ["FIRST_PAGE_TOKEN", "SECOND_PAGE_TOKEN"].map(
    (token) => `BT /F1 12 Tf 72 720 Td (${token}) Tj ET\n`,
  );
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    ...[6, 7].map((content) =>
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents ${content} 0 R >>`),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...streams.map((stream) =>
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) =>
    `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

describe("Desktop Commander 0.3.1 real stdio upgrade regressions", () => {
  let root: string;
  let workspace: string;
  let client: DesktopCommanderClient | undefined;
  const searches = new Set<string>();
  const processes = new Set<number>();

  const call = (name: string, args: Record<string, unknown>) => {
    if (!client) throw new Error("Test Desktop Commander did not start");
    return client.callTool(name, args, { timeoutMs: 20_000 });
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "odr-dc-upgrade-"));
    workspace = join(root, "中文目录 with spaces");
    const home = join(root, "home");
    await mkdir(workspace);
    await mkdir(join(home, ".claude-server-commander"), { recursive: true });
    // Only the isolated subprocess sees this temporary home/config. Never
    // touch a user's existing Desktop Commander configuration or telemetry.
    await writeFile(join(home, ".claude-server-commander", "config.json"),
      JSON.stringify({
        allowedDirectories: [workspace],
        telemetryEnabled: false,
        welcomeOnboardingEligible: false,
        pendingWelcomeOnboarding: false,
        fileReadLineLimit: 1000,
        fileWriteLineLimit: 50,
      }));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    try {
      client = await DesktopCommanderClient.start({ cwd: workspace });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(client.serverVersion?.version).toBe("0.3.1");
    const config = await call("get_config", {});
    expect(text(config)).toContain(workspace.replaceAll("\\", "\\\\"));
    expect(text(config)).toContain('"telemetryEnabled": false');
  }, 45_000);

  afterAll(async () => {
    try {
      if (client) {
        try {
          for (const sessionId of searches) await call("stop_search", { sessionId });
          for (const pid of processes) await call("force_terminate", { pid });
        } finally {
          await client.close();
        }
      }
    } finally {
      vi.unstubAllEnvs();
      if (root) await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("round-trips writes and appends in a Chinese path containing spaces", async () => {
    const path = join(workspace, "测试 file.txt");
    expect((await call("write_file", { path, content: "第一行\nsecond line" })).isError)
      .not.toBe(true);
    expect((await call("write_file", { path, content: "\n追加内容", mode: "append" })).isError)
      .not.toBe(true);
    const result = await call("read_file", { path });
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("第一行\nsecond line\n追加内容");
    expect(await readFile(path, "utf8")).toBe("第一行\nsecond line\n追加内容");
  });

  it("reads an empty file and returns a useful directory listing", async () => {
    const directory = join(workspace, "空目录");
    await mkdir(directory);
    await writeFile(join(directory, "empty.txt"), "");
    const empty = await call("read_file", { path: join(directory, "empty.txt") });
    expect(empty.isError).not.toBe(true);
    expect(text(empty)).toContain("0 lines");
    const listing = await call("read_file", { path: directory });
    expect(listing.isError).not.toBe(true);
    expect(text(listing)).toContain("list_directory");
    expect(text(listing)).toContain("[FILE] empty.txt");
  });

  it("reads exact deep and tail lines from a UTF-8 file over 10 MiB", async () => {
    const path = join(workspace, "大文件.txt");
    const lines = Array.from({ length: 16_000 }, (_, index) =>
      `行${index}:${"a".repeat(800 + (index % 3) * 200)}:终${index}`);
    const contents = lines.join("\n") + "\n";
    expect(Buffer.byteLength(contents)).toBeGreaterThan(10 * 1024 * 1024);
    await writeFile(path, contents);
    const middle = await call("read_file", { path, offset: 12_345, length: 2 });
    expect(middle.isError).not.toBe(true);
    expect(text(middle).split("\n").filter((line) => line.startsWith("行")))
      .toEqual(lines.slice(12_345, 12_347));
    const tail = await call("read_file", { path, offset: -2 });
    expect(tail.isError).not.toBe(true);
    expect(text(tail).split("\n").filter((line) => line.startsWith("行")))
      .toEqual(lines.slice(-2));
  }, 30_000);

  it("reads and paginates a valid PDF, and reports an invalid PDF without losing stdio", async () => {
    const valid = join(workspace, "有效文档.pdf");
    const invalid = join(workspace, "无效文档.pdf");
    await writeFile(valid, pdfFixture());
    await writeFile(invalid, "%PDF-1.4\ninvalid PDF fixture\n");
    const all = await call("read_file", { path: valid });
    expect(all.isError).not.toBe(true);
    expect(text(all)).toContain("2 pages");
    expect(text(all)).toContain("FIRST_PAGE_TOKEN");
    expect(text(all)).toContain("SECOND_PAGE_TOKEN");
    const second = await call("read_file", { path: valid, offset: 1, length: 1 });
    expect(second.isError).not.toBe(true);
    expect(text(second)).toContain("SECOND_PAGE_TOKEN");
    expect(text(second)).not.toContain("FIRST_PAGE_TOKEN");
    const bad = await call("read_file", { path: invalid });
    // Upstream currently reports PDF parse errors in text, without isError.
    // Preserve and document that behavior rather than inventing a wrapper error.
    expect(text(bad)).toMatch(/Error reading PDF:/);
    expect((await call("get_config", {})).isError).not.toBe(true);
  }, 30_000);

  it.each([
    ["maxResults", -1], ["maxResults", 0.5],
    ["contextLines", -1], ["contextLines", 0.5],
    ["timeout_ms", -1], ["timeout_ms", 0.5],
  ])("rejects invalid search %s=%s before creating a session", async (key, value) => {
    const result = await call("start_search", {
      path: workspace, pattern: "not-executed", [key]: value,
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`${key} must be a whole number of at least 0`);
    expect(text(result)).not.toContain("Started file search session:");
  });

  it.each([0, Number.MAX_SAFE_INTEGER])(
    "supports zero/unbounded and large valid search limits (%s)", async (limit) => {
      const directory = join(workspace, `search-${limit}`);
      await mkdir(directory);
      await writeFile(join(directory, "命中.txt"), "needle first\nother\nneedle second\n");
      const result = await call("start_search", {
        path: directory, pattern: "needle", searchType: "content",
        maxResults: limit, timeout_ms: limit, contextLines: 0,
      });
      expect(result.isError).not.toBe(true);
      // Upstream deliberately omits its internal structuredContent for search
      // and process tools from public stdio results. Exercise that public API.
      const sessionId = text(result).match(/search session: (\S+)/)?.[1];
      expect(typeof sessionId).toBe("string");
      searches.add(sessionId!);
      let page: CallToolResult | undefined;
      await expect.poll(async () => {
        page = await call("get_more_search_results", {
          sessionId, offset: 0, length: Number.MAX_SAFE_INTEGER,
        });
        return text(page).includes("Status: COMPLETED");
      }, { timeout: 10_000, interval: 100 }).toBe(true);
      expect(page?.isError).not.toBe(true);
      expect(text(page!)).toContain("Total results: 2 matches");
      expect(text(page!)).toContain("Search completed.");
      expect(text(page!)).toContain("命中.txt:1 - needle");
      expect(text(page!)).toContain("命中.txt:3 - needle");
      const tail = await call("get_more_search_results", { sessionId, offset: -1, length: 1 });
      expect(text(tail)).toContain("Showing last 1 results");
      expect(text(tail)).toContain("命中.txt:3 - needle");
      expect(text(tail)).not.toContain("命中.txt:1 - needle");
      const beyond = await call("get_more_search_results", {
        sessionId, offset: Number.MAX_SAFE_INTEGER, length: 1,
      });
      expect(beyond.isError).not.toBe(true);
      expect(text(beyond)).toContain(`No results at offset ${Number.MAX_SAFE_INTEGER} (2 in total)`);
      for (const args of [{ offset: 0.5 }, { length: 0 }, { length: -1 }, { length: 0.5 }]) {
        const invalid = await call("get_more_search_results", { sessionId, ...args });
        expect(invalid.isError).toBe(true);
        expect(text(invalid)).toContain("must be a whole number");
      }
    }, 20_000,
  );

  async function startFixture(name: string, code: string, timeoutMs: number) {
    const script = join(workspace, name + ".mjs");
    await writeFile(script, code);
    const powershell = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    const posix = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const windows = process.platform === "win32";
    const command = windows
      ? `& ${powershell(process.execPath)} ${powershell(script)}; exit $LASTEXITCODE`
      : `${posix(process.execPath)} ${posix(script)}`;
    const result = await call("start_process", {
      command, shell: windows ? "powershell.exe" : "/bin/sh", timeout_ms: timeoutMs,
    });
    expect(result.isError).not.toBe(true);
    const pid = Number(text(result).match(/Process started with PID (\d+)/)?.[1]);
    expect(pid).toBeGreaterThan(0);
    processes.add(pid);
    return { result, pid };
  }

  async function readUntilFinished(pid: number, initial: CallToolResult, exitCode: number) {
    let output = text(initial);
    await expect.poll(async () => {
      const result = await call("read_process_output", { pid, timeout_ms: 200 });
      expect(result.isError).not.toBe(true);
      output += "\n" + text(result);
      return text(result).includes(`✅ Process completed with exit code ${exitCode}`);
    }, { timeout: 10_000, interval: 50 }).toBe(true);
    processes.delete(pid);
    return output;
  }

  it("preserves stdout, stderr and the real nonzero exit code", async () => {
    const { result, pid } = await startFixture("输出与错误", [
      'console.log("STDOUT_TOKEN");',
      'console.error("STDERR_TOKEN");',
      "process.exitCode = 7;",
    ].join("\n"), 1_000);
    const output = await readUntilFinished(pid, result, 7);
    expect(output).toContain("STDOUT_TOKEN");
    expect(output).toContain("STDERR_TOKEN");
  }, 20_000);

  it("keeps a delayed process running across calls until it actually exits", async () => {
    const { result, pid } = await startFixture("延迟结束", [
      'console.log("Process completed with exit code 0");',
      'setTimeout(() => console.log("DELAYED_DONE_TOKEN"), 1_500);',
    ].join("\n"), 100);
    expect(text(result)).toContain("Process is running");
    const output = await readUntilFinished(pid, result, 0);
    expect(output).toContain("DELAYED_DONE_TOKEN");
  }, 20_000);
});
