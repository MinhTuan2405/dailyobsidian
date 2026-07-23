export interface AuditEntry {
  timestamp: string;
  operationId: string;
  method: string;
  target: string;
  resultCode: string;
  durationMs: number;
  confirmationUsed: boolean;
}

export interface AuditRecordInput {
  timestamp?: string;
  operationId: string;
  method: string;
  target?: string;
  resultCode: string;
  durationMs: number;
  confirmationUsed: boolean;
}

function safeText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex -- audit fields never retain control characters.
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maxLength);
}

function sanitizeEntry(value: unknown): AuditEntry | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const input = value as Partial<AuditEntry>;
  if (
    typeof input.operationId !== "string" ||
    typeof input.method !== "string" ||
    typeof input.resultCode !== "string" ||
    typeof input.durationMs !== "number" ||
    typeof input.confirmationUsed !== "boolean"
  ) {
    return undefined;
  }
  const parsedTime = Date.parse(
    typeof input.timestamp === "string" ? input.timestamp : "",
  );
  return {
    timestamp: Number.isFinite(parsedTime)
      ? new Date(parsedTime).toISOString()
      : new Date(0).toISOString(),
    operationId: safeText(input.operationId, 256),
    method: safeText(input.method, 128),
    target: safeText(input.target, 512),
    resultCode: safeText(input.resultCode, 64),
    durationMs: Math.max(0, Math.min(Math.round(input.durationMs), 86_400_000)),
    confirmationUsed: input.confirmationUsed,
  };
}

export class AuditLog {
  readonly #entries: AuditEntry[];
  readonly #retention: () => number;
  readonly #onChange: () => void;

  constructor(
    entries: unknown[],
    retention: () => number,
    onChange: () => void,
  ) {
    this.#entries = entries
      .map(sanitizeEntry)
      .filter((entry): entry is AuditEntry => entry !== undefined);
    this.#retention = retention;
    this.#onChange = onChange;
    this.#trim();
  }

  get entries(): readonly AuditEntry[] {
    return this.#entries;
  }

  record(input: AuditRecordInput): void {
    const entry = sanitizeEntry({
      timestamp: input.timestamp ?? new Date().toISOString(),
      operationId: input.operationId,
      method: input.method,
      target: input.target ?? "",
      resultCode: input.resultCode,
      durationMs: input.durationMs,
      confirmationUsed: input.confirmationUsed,
    });
    if (entry === undefined) return;
    this.#entries.unshift(entry);
    this.#trim();
    this.#onChange();
  }

  clear(): void {
    this.#entries.length = 0;
    this.#onChange();
  }

  #trim(): void {
    const retention = Math.max(
      10,
      Math.min(1000, Math.floor(this.#retention())),
    );
    if (this.#entries.length > retention) this.#entries.length = retention;
  }
}
