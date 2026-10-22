import type { OperationQueryMessage, OperationStatusMessage } from "@open-desktop-remote/protocol";
import type { OperationReadStore } from "./operation-store.js";

// Queries possess only a read capability. This module has no execution or transport dependency.
export class OperationQuery {
  constructor(private readonly store: OperationReadStore) {}

  handle(message: OperationQueryMessage): OperationStatusMessage {
    if (message.deviceId !== this.store.deviceId) throw new Error("Query device does not match this Agent");
    return {
      type: "operation.status", protocolVersion: 1,
      deviceId: this.store.deviceId, bootId: this.store.bootId,
      queryId: message.queryId, requestId: message.requestId,
      snapshot: this.store.read(message.requestId, message.bootId, message.includeResult),
    };
  }
}
