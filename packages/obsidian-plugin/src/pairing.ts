import {
  PermissionScopeSchema,
  type PermissionScope,
} from "@obsidian-workbench/shared";
import { z } from "zod";

import { validationError, workbenchError } from "./errors.js";

const PairingResponseSchema = z.object({
  deviceId: z.string().min(1).max(256),
  userId: z.string().min(1).max(256),
  vaultId: z.string().min(1).max(256),
  deviceToken: z.string().min(16).max(8192),
  deviceTokenExpiresAt: z.number().int().positive(),
  vaultToken: z.string().min(16).max(8192),
  vaultTokenExpiresAt: z.number().int().positive(),
  scopes: z.array(PermissionScopeSchema),
});

export interface PairingRequest {
  code: string;
  vaultId: string;
  vaultName: string;
  scopes: PermissionScope[];
}

export interface PairingResult {
  deviceId: string;
  userId: string;
  vaultId: string;
  deviceToken: string;
  deviceTokenExpiresAt: number;
  vaultToken: string;
  vaultTokenExpiresAt: number;
  scopes: PermissionScope[];
}

export interface RevocationRequest {
  deviceId: string;
  deviceToken: string;
}

export interface PairingClientOptions {
  gatewayUrl: string;
  fetch?: typeof globalThis.fetch;
}

function serviceUrl(gatewayUrl: string, path: string): URL {
  let url: URL;
  try {
    url = new URL(gatewayUrl);
  } catch {
    throw validationError("The gateway URL is invalid.");
  }
  if (url.protocol !== "wss:") {
    throw validationError(
      "The gateway URL must use secure WebSocket transport (wss).",
    );
  }
  url.protocol = "https:";
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url;
}

export class PairingClient {
  readonly #gatewayUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: PairingClientOptions) {
    this.#gatewayUrl = options.gatewayUrl;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async exchangeCode(request: PairingRequest): Promise<PairingResult> {
    const code = request.code.trim();
    if (!/^[a-zA-Z0-9-]{6,64}$/.test(code)) {
      throw validationError("The one-time pairing code is invalid.");
    }
    const response = await this.#request(
      serviceUrl(this.#gatewayUrl, "/v1/pairing/exchange"),
      {
        code,
        vaultId: request.vaultId,
        vaultName: request.vaultName.slice(0, 256),
        scopes: PermissionScopeSchema.array().parse(request.scopes),
      },
    );
    const parsed = PairingResponseSchema.safeParse(response);
    if (!parsed.success || parsed.data.vaultId !== request.vaultId) {
      throw workbenchError(
        "VALIDATION_ERROR",
        "The pairing service returned an invalid device authorization.",
      );
    }
    const requested = new Set(request.scopes);
    if (parsed.data.scopes.some((scope) => !requested.has(scope))) {
      throw workbenchError(
        "PERMISSION_DENIED",
        "The pairing response granted an unrequested scope.",
      );
    }
    return { ...parsed.data, scopes: [...new Set(parsed.data.scopes)] };
  }

  async revoke(request: RevocationRequest): Promise<void> {
    await this.#request(
      serviceUrl(this.#gatewayUrl, "/v1/devices/revoke"),
      { deviceId: request.deviceId },
      request.deviceToken,
    );
  }

  async #request(url: URL, body: unknown, token?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
        credentials: "omit",
        redirect: "error",
      });
    } catch {
      throw workbenchError(
        "VAULT_OFFLINE",
        "The pairing service could not be reached.",
      );
    }
    if (!response.ok) {
      throw workbenchError(
        "PERMISSION_DENIED",
        `The pairing service rejected the request (HTTP ${response.status}).`,
      );
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw validationError(
        "The pairing service returned an invalid response.",
      );
    }
  }
}
