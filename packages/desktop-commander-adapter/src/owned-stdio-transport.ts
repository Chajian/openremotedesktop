import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { ReadBuffer, serializeMessage, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client";

type StdioProcessOptions = {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
};

/** Own the process until physical close; use the SDK's public MCP framing. */
export class OwnedStdioTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  readonly stderr = new PassThrough();
  private readonly buffer = new ReadBuffer();
  private readonly closedEvent = Promise.withResolvers<void>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private started = false;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: StdioProcessOptions) {}

  get pid(): number | null { return this.child?.pid ?? null; }

  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error("Desktop Commander transport cannot be started again");
    this.started = true;
    const child = spawn(this.options.command, this.options.args, {
      env: this.options.env,
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: process.platform === "win32",
    });
    this.child = child;
    child.once("close", () => this.confirmClose());
    child.stdin.on("error", error => this.onerror?.(error));
    child.stdout.on("error", error => this.onerror?.(error));
    child.stderr.on("error", error => this.onerror?.(error));
    child.stderr.pipe(this.stderr);
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
      } catch (cause) {
        this.onerror?.(new Error("Desktop Commander exceeded the MCP read buffer", { cause }));
        void this.close().catch(error => this.onerror?.(error));
        return;
      }
      // Match the SDK stdio behavior: a malformed complete frame is reported,
      // while subsequent frames remain usable. Buffer overflow above is fatal.
      while (true) {
        try {
          const message = this.buffer.readMessage();
          if (message === null) break;
          this.onmessage?.(message);
        } catch (cause) {
          this.onerror?.(new Error("Desktop Commander sent invalid MCP data", { cause }));
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.on("error", error => { reject(error); this.onerror?.(error); });
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    if (!child || this.closing || !child.stdin.writable) throw new Error("Desktop Commander transport is not connected");
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(serializeMessage(message), error => error ? reject(error) : resolve());
    });
  }

  close(): Promise<void> {
    if (this.closing === undefined) {
      const closing = Promise.resolve().then(() => this.closeProcess());
      this.closing = closing;
      void closing.catch(() => {
        if (this.closing === closing) this.closing = undefined;
      });
    }
    return this.closing;
  }

  private async closeProcess(): Promise<void> {
    const child = this.child;
    if (!child) { this.confirmClose(); return; }
    let failure: unknown;
    try { child.stdin.end(); } catch (error) { failure = error; }
    if (await this.waitForClose()) return;
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      // The actual ChildProcess handle prevents signaling a recycled PID.
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (!child.kill(signal)) failure = new Error(`Desktop Commander ${signal} was not delivered`);
        } catch (error) { failure = error; }
      } else {
        // A descendant may still hold inherited pipes after this child exits.
        // These streams belong to this transport and can now be released.
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
      if (await this.waitForClose()) return;
    }
    throw new Error("Desktop Commander subprocess close was not confirmed", { cause: failure });
  }

  private async waitForClose(): Promise<boolean> {
    if (this.closed) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.closedEvent.promise.then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 2_000); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  private confirmClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.child = undefined;
    this.buffer.clear();
    this.stderr.end();
    this.closedEvent.resolve();
    this.onclose?.();
  }
}
