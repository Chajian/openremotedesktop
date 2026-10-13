export type ProtocolRange = {
  min: number;
  max: number;
};

export class InvalidProtocolRangeError extends Error {
  constructor(public readonly range: ProtocolRange) {
    super(`Invalid protocol range: ${range.min}..${range.max}`);
    this.name = "InvalidProtocolRangeError";
  }
}

function assertProtocolRange(range: ProtocolRange): void {
  if (
    !Number.isInteger(range.min) ||
    !Number.isInteger(range.max) ||
    range.min < 1 ||
    range.max < 1 ||
    range.min > range.max
  ) {
    throw new InvalidProtocolRangeError(range);
  }
}

export function negotiateProtocol(
  agent: ProtocolRange,
  server: ProtocolRange,
): { version: number } | { error: "PROTOCOL_INCOMPATIBLE" } {
  assertProtocolRange(agent);
  assertProtocolRange(server);

  const minCommon = Math.max(agent.min, server.min);
  const maxCommon = Math.min(agent.max, server.max);

  if (minCommon > maxCommon) {
    return { error: "PROTOCOL_INCOMPATIBLE" };
  }

  return { version: maxCommon };
}
