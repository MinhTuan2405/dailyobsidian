import { z } from "zod";

import {
  type MutationPlan,
  PermissionScopeSchema,
  VaultConventionsSchema,
  WorkbenchError,
  type VaultInfo,
} from "@obsidian-workbench/shared";
import {
  FilesystemVaultAdapter,
  type VaultAdapter,
} from "@obsidian-workbench/vault-core";

export interface ConfirmationIssuingVaultAdapter extends VaultAdapter {
  issueConfirmation(plan: MutationPlan): string | Promise<string>;
}

function canIssueConfirmation(
  adapter: VaultAdapter,
): adapter is ConfirmationIssuingVaultAdapter {
  return (
    "issueConfirmation" in adapter &&
    typeof adapter.issueConfirmation === "function"
  );
}

const VaultConfigurationSchema = z.object({
  vaultId: z.string().trim().min(1).max(256),
  rootPath: z.string().min(1),
  name: z.string().trim().min(1).max(256).optional(),
  allowedRoots: z.array(z.string()).optional(),
  excludedRoots: z.array(z.string()).optional(),
  scopes: z.array(PermissionScopeSchema).optional(),
  conventions: VaultConventionsSchema.partial().optional(),
});

const VaultConfigurationsSchema = z.array(VaultConfigurationSchema).max(100);

export class VaultRegistry {
  readonly #adapters = new Map<string, VaultAdapter>();
  readonly #uninitialized: VaultAdapter[] = [];
  #initializationPromise: Promise<void> | undefined;

  constructor(adapters: readonly VaultAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: VaultAdapter): void {
    if (this.#initializationPromise !== undefined) {
      throw new WorkbenchError({
        code: "VALIDATION_ERROR",
        message: "Vaults cannot be registered after initialization.",
        recoverable: true,
      });
    }
    this.#uninitialized.push(adapter);
  }

  async initialize(): Promise<void> {
    this.#initializationPromise ??= this.#initializeAdapters();
    await this.#initializationPromise;
  }

  async #initializeAdapters(): Promise<void> {
    for (const adapter of this.#uninitialized.splice(0)) {
      const info = await adapter.getVaultInfo();
      if (this.#adapters.has(info.vaultId)) {
        throw new WorkbenchError({
          code: "VALIDATION_ERROR",
          message: "Vault IDs must be unique.",
          recoverable: true,
        });
      }
      this.#adapters.set(info.vaultId, adapter);
    }
  }

  async list(): Promise<VaultInfo[]> {
    await this.initialize();
    const results = await Promise.all(
      [...this.#adapters.values()].map((adapter) => adapter.getVaultInfo()),
    );
    return results.sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(vaultId: string): Promise<VaultAdapter> {
    await this.initialize();
    const adapter = this.#adapters.get(vaultId);
    if (adapter === undefined) {
      throw new WorkbenchError({
        code: "VAULT_NOT_FOUND",
        message: "The requested vault could not be found.",
        recoverable: true,
      });
    }
    return adapter;
  }

  async issueConfirmation(plan: MutationPlan): Promise<string> {
    const adapter = await this.get(plan.vaultId);
    if (canIssueConfirmation(adapter)) {
      return await adapter.issueConfirmation(plan);
    }
    throw new WorkbenchError({
      code: "UNSUPPORTED_OPERATION",
      message: "This vault mode cannot issue a local confirmation token.",
      recoverable: true,
    });
  }
}

export function createVaultRegistry(
  adapters: readonly VaultAdapter[],
): VaultRegistry {
  const registry = new VaultRegistry();
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}

export function loadVaultRegistryFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): VaultRegistry {
  let rawConfigurations: unknown;
  if (environment.OBSIDIAN_VAULTS_JSON !== undefined) {
    try {
      rawConfigurations = JSON.parse(environment.OBSIDIAN_VAULTS_JSON);
    } catch {
      throw new WorkbenchError({
        code: "VALIDATION_ERROR",
        message: "OBSIDIAN_VAULTS_JSON must contain valid JSON.",
        recoverable: true,
      });
    }
  } else if (environment.OBSIDIAN_VAULT_PATH !== undefined) {
    rawConfigurations = [
      {
        vaultId: environment.OBSIDIAN_VAULT_ID ?? "local-vault",
        rootPath: environment.OBSIDIAN_VAULT_PATH,
        ...(environment.OBSIDIAN_VAULT_NAME !== undefined
          ? { name: environment.OBSIDIAN_VAULT_NAME }
          : {}),
      },
    ];
  } else {
    rawConfigurations = [];
  }

  const parsed = VaultConfigurationsSchema.safeParse(rawConfigurations);
  if (!parsed.success) {
    throw new WorkbenchError({
      code: "VALIDATION_ERROR",
      message: "The configured vault list is invalid.",
      recoverable: true,
    });
  }
  return createVaultRegistry(
    parsed.data.map(
      (configuration) =>
        new FilesystemVaultAdapter({
          vaultId: configuration.vaultId,
          rootPath: configuration.rootPath,
          ...(configuration.name !== undefined
            ? { name: configuration.name }
            : {}),
          ...(configuration.allowedRoots !== undefined
            ? { allowedRoots: configuration.allowedRoots }
            : {}),
          ...(configuration.excludedRoots !== undefined
            ? { excludedRoots: configuration.excludedRoots }
            : {}),
          ...(configuration.scopes !== undefined
            ? { scopes: configuration.scopes }
            : {}),
          ...(configuration.conventions !== undefined
            ? { conventions: configuration.conventions }
            : {}),
        }),
    ),
  );
}
