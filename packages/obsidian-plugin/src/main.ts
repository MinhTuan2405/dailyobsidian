import { Notice, Plugin } from "obsidian";

import { AuditLog } from "./audit.js";
import { VaultEventStream } from "./events.js";
import { GatewayClient, type GatewayStatus } from "./gateway.js";
import { StableNoteIds } from "./note-ids.js";
import { PairingClient } from "./pairing.js";
import { RequestRouter } from "./router.js";
import { WorkbenchSettingTab } from "./settings.js";
import {
  defaultSettings,
  loadSettings,
  type PluginSettingsData,
} from "./settings-data.js";
import { ObsidianVaultAdapter } from "./vault-adapter.js";

export default class ObsidianWorkbenchPlugin extends Plugin {
  override settings: PluginSettingsData = defaultSettings();
  audit!: AuditLog;
  gatewayStatus: GatewayStatus = { state: "offline" };
  #gateway!: GatewayClient;
  #events?: VaultEventStream;
  #saveChain: Promise<void> = Promise.resolve();
  #saveScheduled = false;

  override async onload(): Promise<void> {
    this.settings = loadSettings(await this.loadData());
    this.audit = new AuditLog(
      this.settings.auditEntries,
      () => this.settings.auditRetention,
      () => this.#scheduleSave(),
    );
    const noteIds = new StableNoteIds(this.settings.noteIds, () =>
      this.#scheduleSave(),
    );
    const adapter = new ObsidianVaultAdapter({
      app: this.app,
      settings: () => this.settings,
      noteIds,
      connectionState: () => this.gatewayStatus.state,
    });
    const router = new RequestRouter({
      adapter,
      audit: this.audit,
      identity: () => {
        const device = this.settings.device;
        return device === undefined
          ? undefined
          : {
              deviceId: device.deviceId,
              userId: device.userId,
              vaultId: device.vaultId,
              scopes: device.scopes,
            };
      },
      enabledScopes: () => this.settings.enabledScopes,
    });
    this.#gateway = new GatewayClient({
      onRequest: async (request, signal) => await router.route(request, signal),
      onStatus: (status) => this.#handleStatus(status),
    });
    this.#events = new VaultEventStream({
      app: this.app,
      plugin: this,
      gateway: this.#gateway,
      noteIds,
      settings: () => this.settings,
    });
    this.#events.start();
    this.addSettingTab(new WorkbenchSettingTab(this.app, this));
    if (this.settings.autoConnect && this.settings.device !== undefined) {
      this.app.workspace.onLayoutReady(() => this.connectGateway());
    }
  }

  override onunload(): void {
    if (this.gatewayStatus.state === "online") this.#events?.disconnected();
    this.#gateway?.disconnect();
  }

  async saveSettings(): Promise<void> {
    this.settings.auditEntries = [...this.audit.entries];
    this.#saveChain = this.#saveChain.then(
      async () => await this.saveData(this.settings),
    );
    await this.#saveChain;
  }

  async pair(code: string): Promise<void> {
    const client = new PairingClient({ gatewayUrl: this.settings.gatewayUrl });
    const result = await client.exchangeCode({
      code,
      vaultId: this.settings.vaultId,
      vaultName: this.app.vault.getName(),
      scopes: this.settings.enabledScopes,
    });
    this.settings.device = {
      ...result,
      pairedAt: new Date().toISOString(),
    };
    await this.saveSettings();
    this.connectGateway();
  }

  connectGateway(): void {
    const device = this.settings.device;
    if (device === undefined) {
      new Notice("Pair this vault before connecting.");
      return;
    }
    if (device.vaultId !== this.settings.vaultId) {
      new Notice("The paired device is not authorized for this vault.");
      return;
    }
    if (
      device.deviceTokenExpiresAt <= Date.now() ||
      device.vaultTokenExpiresAt <= Date.now()
    ) {
      new Notice("The gateway authorization expired. Pair this vault again.");
      return;
    }
    try {
      this.#gateway.connect({
        gatewayUrl: this.settings.gatewayUrl,
        deviceId: device.deviceId,
        vaultId: device.vaultId,
        deviceToken: device.deviceToken,
        vaultToken: device.vaultToken,
        scopes: this.settings.enabledScopes.filter((scope) =>
          device.scopes.includes(scope),
        ),
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The gateway configuration is invalid.";
      this.gatewayStatus = {
        state: "error",
        message,
      };
      new Notice(message);
    }
  }

  disconnectGateway(): void {
    if (this.gatewayStatus.state === "online") this.#events?.disconnected();
    this.#gateway.disconnect();
  }

  emergencyDisconnect(): void {
    if (this.gatewayStatus.state === "online") this.#events?.disconnected();
    this.#gateway.emergencyDisconnect();
  }

  async revokeDevice(): Promise<void> {
    const device = this.settings.device;
    if (this.gatewayStatus.state === "online") this.#events?.disconnected();
    this.#gateway.disconnect();
    if (device === undefined) return;
    let failure: unknown;
    try {
      await new PairingClient({ gatewayUrl: this.settings.gatewayUrl }).revoke({
        deviceId: device.deviceId,
        deviceToken: device.deviceToken,
      });
    } catch (error) {
      failure = error;
    } finally {
      delete this.settings.device;
      await this.saveSettings();
    }
    if (failure !== undefined) throw failure;
  }

  #handleStatus(status: GatewayStatus): void {
    const previous = this.gatewayStatus.state;
    this.gatewayStatus = status;
    if (status.state === "online" && previous !== "online")
      this.#events?.connected();
    if (previous === "online" && status.state !== "online")
      this.#events?.disconnected();
  }

  #scheduleSave(): void {
    if (this.#saveScheduled) return;
    this.#saveScheduled = true;
    queueMicrotask(() => {
      this.#saveScheduled = false;
      void this.saveSettings();
    });
  }
}
