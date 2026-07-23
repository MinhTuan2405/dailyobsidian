export type GatewayErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "CAPACITY_EXCEEDED"
  | "IDEMPOTENCY_CONFLICT"
  | "INTERNAL_ERROR"
  | "INVALID_REQUEST"
  | "PAIRING_INVALID"
  | "PERMISSION_DENIED"
  | "REQUEST_TIMEOUT"
  | "VAULT_OFFLINE";

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status: number;

  constructor(code: GatewayErrorCode, message: string, status = 400) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
  }
}

export function safeGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError(
    "INTERNAL_ERROR",
    "The gateway could not complete the request.",
    500,
  );
}
