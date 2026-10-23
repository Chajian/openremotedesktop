import { createHash } from "node:crypto";
import type {
  OperationCallMessage,
  OperationSnapshot,
  ToolErrorMessage,
  ToolResultMessage,
} from "@open-desktop-remote/protocol";

export type OperationResponse = ToolResultMessage | ToolErrorMessage;

// Deliberately excludes admission, cancellation, and the executor.
export interface OperationReadStore {
  readonly deviceId: string;
  readonly bootId: string;
  read(requestId: string, expectedBootId: string, includeResult: boolean): OperationSnapshot;
}

export type OperationStoreOptions = {
  deviceId: string;
  bootId: string;
  now?: () => number;
  maxInFlight?: number;
  maxEntries?: number;
  maxResultBytes?: number;
  maxCachedBytes?: number;
  retentionMs?: number;
};

type Outcome = "success" | "error" | "unknown";
type RecordEntry = {
  fingerprint: string;
  expiresAt: number;
  startedAt: number;
  cancelRequested: boolean;
  completedAt?: number;
  outcome?: Outcome;
  payloadStatus: "available" | "expired" | "evicted" | "unavailable";
  encoded?: string;
  bytes: number;
};

type Admission = { kind: "new" } | { kind: "running" } | { kind: "response"; response: OperationResponse };

function errorResponse(
  identity: { requestId: string; deviceId: string },
  reason: string,
  code: ToolErrorMessage["error"]["code"] = "TOOL_EXECUTION_ERROR",
): ToolErrorMessage {
  return {
    type: "tool.error", protocolVersion: 1, ...identity,
    error: { code, message: "Operation cannot provide a confirmed tool result", details: { reason } },
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Intent must contain JSON values");
  return encoded;
}

export class OperationStore implements OperationReadStore {
  readonly deviceId: string;
  readonly bootId: string;
  private readonly entries = new Map<string, RecordEntry>();
  private readonly nowSource: () => number;
  private readonly maxInFlight: number;
  private readonly maxEntries: number;
  private readonly maxResultBytes: number;
  private readonly maxCachedBytes: number;
  private readonly retentionMs: number;
  private lastNow = 0;
  private inFlight = 0;
  private cachedBytes = 0;

  constructor(options: OperationStoreOptions) {
    this.deviceId = options.deviceId;
    this.bootId = options.bootId;
    this.nowSource = options.now ?? Date.now;
    this.maxInFlight = options.maxInFlight ?? 32;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.maxResultBytes = options.maxResultBytes ?? 8 * 1024 * 1024;
    this.maxCachedBytes = options.maxCachedBytes ?? 64 * 1024 * 1024;
    this.retentionMs = options.retentionMs ?? 15 * 60 * 1000;
  }

  admit(call: OperationCallMessage): Admission {
    const now = this.clock();
    this.cleanup(now);
    const identity = { requestId: call.requestId, deviceId: call.deviceId };
    const reject = (reason: string): Admission => ({ kind: "response", response: errorResponse(identity, reason) });
    let fingerprint: string;
    try {
      fingerprint = createHash("sha256").update(canonical({ deviceId: call.deviceId, bootId: call.bootId,
        toolName: call.toolName, arguments: call.arguments, expiresAt: call.expiresAt })).digest("hex");
    } catch { return reject("INVALID_INTENT"); }
    const existing = this.entries.get(call.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return reject("OPERATION_CONFLICT");
      if (existing.completedAt === undefined) return { kind: "running" };
      return { kind: "response", response: existing.encoded ? JSON.parse(existing.encoded) as OperationResponse
        : errorResponse(identity, `RESULT_${existing.payloadStatus.toUpperCase()}`, "EXECUTION_UNKNOWN") };
    }
    if (call.deviceId !== this.deviceId) return reject("DEVICE_MISMATCH");
    if (call.bootId !== this.bootId) return reject("BOOT_MISMATCH");
    if (call.expiresAt <= now) return reject("SUBMISSION_EXPIRED");
    if (call.expiresAt > now + 5 * 60 * 1000) return reject("SUBMISSION_TOO_FAR_IN_FUTURE");
    if (this.inFlight >= this.maxInFlight) return reject("IN_FLIGHT_CAPACITY");
    if (this.entries.size >= this.maxEntries) return reject("METADATA_CAPACITY");
    this.entries.set(call.requestId, { fingerprint, expiresAt: call.expiresAt, startedAt: now,
      cancelRequested: false, payloadStatus: "unavailable", bytes: 0 });
    this.inFlight++;
    return { kind: "new" };
  }

  complete(requestId: string, response: OperationResponse, outcome: Outcome): OperationResponse {
    const record = this.entries.get(requestId);
    if (!record || record.completedAt !== undefined) return response;
    const identity = { requestId, deviceId: this.deviceId };
    let encoded: string;
    try {
      encoded = JSON.stringify(response);
      // Snapshot the wire value now; later tool mutations cannot change the saved evidence.
      response = JSON.parse(encoded) as OperationResponse;
      if (response.type === "tool.result" && !("result" in response)) throw new Error("Missing result");
      if (Buffer.byteLength(encoded, "utf8") > this.maxResultBytes) {
        response = errorResponse(identity, "RESULT_TOO_LARGE", "EXECUTION_UNKNOWN");
        outcome = "unknown";
        encoded = JSON.stringify(response);
      }
    } catch {
      response = errorResponse(identity, "RESULT_NOT_SERIALIZABLE", "EXECUTION_UNKNOWN");
      outcome = "unknown";
      encoded = JSON.stringify(response);
    }
    const now = this.clock();
    this.cleanup(now);
    record.completedAt = now;
    record.outcome = outcome;
    this.inFlight--;
    const bytes = Buffer.byteLength(encoded, "utf8");
    if (bytes <= this.maxResultBytes && bytes <= this.maxCachedBytes) {
      this.evictFor(bytes);
      record.encoded = encoded;
      record.bytes = bytes;
      record.payloadStatus = "available";
      this.cachedBytes += bytes;
    }
    return response;
  }

  cancel(requestId: string): void {
    const record = this.entries.get(requestId);
    if (record) record.cancelRequested = true;
  }

  read(requestId: string, expectedBootId: string, includeResult: boolean): OperationSnapshot {
    this.cleanup(this.clock());
    if (expectedBootId !== this.bootId) return { state: "restarted" };
    const record = this.entries.get(requestId);
    if (!record) return { state: "not_found" };
    if (record.completedAt === undefined) return { state: "running", startedAt: record.startedAt, cancelRequested: record.cancelRequested };
    return {
      state: "completed", completedAt: record.completedAt, cancelRequested: record.cancelRequested,
      outcome: record.outcome!, payload: record.payloadStatus === "available"
        ? { status: "available", ...(includeResult && record.encoded ? { response: JSON.parse(record.encoded) as OperationResponse } : {}) }
        : { status: record.payloadStatus },
    };
  }

  private clock(): number {
    this.lastNow = Math.max(this.lastNow, this.nowSource());
    return this.lastNow;
  }

  private dropBody(record: RecordEntry, status: "expired" | "evicted"): void {
    this.cachedBytes -= record.bytes;
    record.bytes = 0;
    delete record.encoded;
    record.payloadStatus = status;
  }

  private cleanup(now: number): void {
    for (const [id, record] of this.entries) {
      if (record.completedAt === undefined) continue;
      if (now >= record.completedAt + this.retentionMs) {
        if (record.encoded) this.dropBody(record, "expired");
        if (now >= record.expiresAt) this.entries.delete(id);
      }
    }
  }

  private evictFor(bytes: number): void {
    // Map order is admission order. Victims are completed bodies only, deterministically oldest first.
    for (const record of this.entries.values()) {
      if (this.cachedBytes + bytes <= this.maxCachedBytes) break;
      if (record.encoded) this.dropBody(record, "evicted");
    }
  }
}

export class OperationCoordinator {
  private readonly active = new Map<string, {
    promise: Promise<OperationResponse>;
    resolve: (response: OperationResponse) => void;
  }>();
  private readonly watchdogs = new Map<string, NodeJS.Timeout>();
  private recoveringStalledExecutor = false;

  constructor(
    private readonly executor: { callTool(name: string, args: unknown): Promise<unknown> },
    readonly store: OperationStore,
    private readonly options: { maxExecutionMs?: number; recoverExecutor?: () => Promise<void> } = {},
  ) {}

  private armWatchdog(requestId: string): void {
    if (!this.options.recoverExecutor) return;
    // A hard executor deadline, never an instruction to retry the tool.
    const timer = setTimeout(() => {
      if (!this.active.has(requestId) || this.recoveringStalledExecutor) return;
      this.recoveringStalledExecutor = true;
      void this.options.recoverExecutor!().catch(() => {
        // Recovery itself failed: do not preserve a phantom running slot.
        this.invalidateRunning();
      }).finally(() => { this.recoveringStalledExecutor = false; });
    }, this.options.maxExecutionMs ?? 10 * 60_000);
    timer.unref();
    this.watchdogs.set(requestId, timer);
  }

  private clearWatchdog(requestId: string): void {
    const timer = this.watchdogs.get(requestId);
    if (timer) clearTimeout(timer);
    this.watchdogs.delete(requestId);
  }

  handle(call: OperationCallMessage): Promise<OperationResponse> {
    const admission = this.store.admit(call);
    if (admission.kind === "response") return Promise.resolve(admission.response);
    if (admission.kind === "running") return this.active.get(call.requestId)!.promise;
    let resolve!: (response: OperationResponse) => void;
    const promise = new Promise<OperationResponse>((done) => { resolve = done; });
    const active = { promise, resolve };
    this.active.set(call.requestId, active);
    this.armWatchdog(call.requestId);
    void Promise.resolve().then(async () => {
      if (this.active.get(call.requestId) !== active) return;
      let response: OperationResponse;
      let outcome: Outcome;
      try {
        const raw = await this.executor.callTool(call.toolName, call.arguments);
        response = { type: "tool.result", protocolVersion: 1, requestId: call.requestId,
          deviceId: call.deviceId, result: raw === undefined ? null : raw };
        outcome = raw !== null && typeof raw === "object" && "isError" in raw && raw.isError === true ? "error" : "success";
      } catch {
        response = errorResponse({ requestId: call.requestId, deviceId: call.deviceId }, "EXECUTOR_ERROR", "EXECUTION_UNKNOWN");
        outcome = "unknown";
      }
      if (this.active.get(call.requestId) !== active) return;
      const saved = this.store.complete(call.requestId, response, outcome);
      this.active.delete(call.requestId);
      this.clearWatchdog(call.requestId);
      resolve(saved);
    });
    return promise;
  }

  cancel(requestId: string): void { this.store.cancel(requestId); }

  invalidateRunning(): void {
    for (const [requestId, active] of this.active) {
      const response = errorResponse({ requestId, deviceId: this.store.deviceId }, "EXECUTOR_REPLACED", "EXECUTION_UNKNOWN");
      const saved = this.store.complete(requestId, response, "unknown");
      this.active.delete(requestId);
      this.clearWatchdog(requestId);
      active.resolve(saved);
    }
  }
}
