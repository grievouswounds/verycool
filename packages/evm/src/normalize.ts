export type RpcErrorClass =
  | "transport"
  | "rateLimited"
  | "unsupportedMethod"
  | "rangeTooLarge"
  | "executionReverted"
  | "invalidRequest"
  | "alreadyKnown";

export interface ClassifiedRpcFailure {
  readonly class: RpcErrorClass;
  readonly retryable: boolean;
  readonly message: string;
  readonly retryAfterMs?: number;
  readonly revertData?: unknown;
  readonly rpcCode?: number;
  readonly httpStatus?: number;
}

export class ClassifiedRpcError extends Error {
  public readonly class: RpcErrorClass;
  public readonly retryable: boolean;
  public readonly retryAfterMs: number | undefined;
  public readonly revertData: unknown;
  public readonly rpcCode: number | undefined;
  public readonly httpStatus: number | undefined;

  public constructor(failure: ClassifiedRpcFailure) {
    super(failure.message);
    this.name = "ClassifiedRpcError";
    this.class = failure.class;
    this.retryable = failure.retryable;
    this.retryAfterMs = failure.retryAfterMs;
    this.revertData = failure.revertData;
    this.rpcCode = failure.rpcCode;
    this.httpStatus = failure.httpStatus;
  }
}

const REVERT_CODES = new Set([-32_000, -32_015]);
const RANGE_PATTERNS = /query returned more than|block range is too large|exceeds max block range|range limit exceeded/iu;
const RATE_PATTERNS = /capacity exceeded|too many requests|rate limit|over rate limit/iu;
const KNOWN_PATTERNS = /already known|known transaction|nonce too low|replacement transaction underpriced|ALREADY_EXISTS/iu;
const REVERT_PATTERNS = /execution reverted|revert/iu;

export const revertDataOf = (data: unknown): unknown => {
  if (data === undefined || data === null) return undefined;
  if (typeof data === "object" && "data" in data) {
    const nested: unknown = Reflect.get(data, "data");
    if (typeof nested === "string" && nested.startsWith("0x")) return nested;
    if (nested !== undefined) return nested;
  }
  return data;
};

const retryAfterMs = (header: string | null): number | undefined => {
  if (header === null || header.length === 0) return undefined;
  if (/^[0-9]+$/u.test(header)) return Number(header) * 1_000;
  const parsed = Date.parse(header);
  if (!Number.isFinite(parsed)) return undefined;
  const delta = parsed - Date.now();
  return delta > 0 ? delta : 0;
};

export const classifyTransport = (cause: unknown): ClassifiedRpcError =>
  new ClassifiedRpcError({
    class: "transport",
    retryable: true,
    message: cause instanceof Error ? cause.message : "RPC transport failed",
  });

export const classifyHttp = (status: number, retryAfter: string | null, bodyMessage?: string): ClassifiedRpcError => {
  if (status === 429 || RATE_PATTERNS.test(bodyMessage ?? "")) {
    return new ClassifiedRpcError({
      class: "rateLimited",
      retryable: true,
      message: bodyMessage ?? `RPC returned HTTP ${String(status)}`,
      httpStatus: status,
      retryAfterMs: retryAfterMs(retryAfter) ?? 1_000,
    });
  }
  return new ClassifiedRpcError({
    class: "transport",
    retryable: true,
    message: `RPC returned HTTP ${String(status)}`,
    httpStatus: status,
  });
};

export const classifyJsonRpc = (
  method: string,
  params: readonly unknown[],
  code: number,
  message: string,
  data: unknown,
): ClassifiedRpcError => {
  const revertData = revertDataOf(data);
  const detail = typeof revertData === "string" && revertData.length > 0 ? ` data=${revertData}` : "";
  const formatted = `RPC ${String(code)}: ${message}${detail}`;
  if (KNOWN_PATTERNS.test(message)) {
    return new ClassifiedRpcError({ class: "alreadyKnown", retryable: false, message: formatted, rpcCode: code, revertData });
  }
  if (RANGE_PATTERNS.test(message)) {
    return new ClassifiedRpcError({ class: "rangeTooLarge", retryable: true, message: formatted, rpcCode: code });
  }
  if (code === -32_605 || RATE_PATTERNS.test(message)) {
    return new ClassifiedRpcError({ class: "rateLimited", retryable: true, message: formatted, rpcCode: code, retryAfterMs: 1_000 });
  }
  if (code === -32_601 || (code === -32_602 && method === "eth_call" && params.length >= 3)) {
    return new ClassifiedRpcError({ class: "unsupportedMethod", retryable: true, message: formatted, rpcCode: code });
  }
  if (REVERT_CODES.has(code) && (revertData !== undefined || REVERT_PATTERNS.test(message))) {
    return new ClassifiedRpcError({
      class: "executionReverted", retryable: false, message: formatted, rpcCode: code, revertData,
    });
  }
  if (code === -32_600 || code === -32_602) {
    return new ClassifiedRpcError({ class: "invalidRequest", retryable: false, message: formatted, rpcCode: code });
  }
  if (REVERT_CODES.has(code) && REVERT_PATTERNS.test(message)) {
    return new ClassifiedRpcError({
      class: "executionReverted", retryable: false, message: formatted, rpcCode: code, revertData,
    });
  }
  return new ClassifiedRpcError({ class: "transport", retryable: true, message: formatted, rpcCode: code });
};

export const isTerminalClass = (value: RpcErrorClass): boolean =>
  value === "executionReverted" || value === "invalidRequest";
