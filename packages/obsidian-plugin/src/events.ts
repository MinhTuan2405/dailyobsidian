import { VaultEventSchema, type VaultEvent } from "@obsidian-workbench/shared";
import type { App, Plugin, TAbstractFile, TFile } from "obsidian";

import type { GatewayClient } from "./gateway.js";
import type { StableNoteIds } from "./note-ids.js";
import { VaultPermissions } from "./permissions.js";
import type { PluginSettingsData } from "./settings-data.js";

export interface VaultEventStreamOptions {
  app: App;
  plugin: Plugin;
  gateway: GatewayClient;
  noteIds: StableNoteIds;
  settings(): PluginSettingsData;
}

function isMarkdown(file: TAbstractFile | null): file is TFile {
  if (file === null) return false;
  const candidate = file as Partial<TFile>;
  return (
    typeof candidate.extension === "string" &&
    candidate.extension.toLocaleLowerCase("en-US") === "md"
  );
}

export class VaultEventStream {
  readonly #app: App;
  readonly #plugin: Plugin;
  readonly #gateway: GatewayClient;
  readonly #noteIds: StableNoteIds;
  readonly #settings: () => PluginSettingsData;

  constructor(options: VaultEventStreamOptions) {
    this.#app = options.app;
    this.#plugin = options.plugin;
    this.#gateway = options.gateway;
    this.#noteIds = options.noteIds;
    this.#settings = options.settings;
  }

  start(): void {
    this.#plugin.registerEvent(
      this.#app.vault.on("create", (file) => {
        if (isMarkdown(file) && this.#allows(file.path)) {
          this.#emit(
            "note.created",
            file.path,
            this.#noteIds.getOrCreate(file.path),
          );
        }
      }),
    );
    this.#plugin.registerEvent(
      this.#app.vault.on("modify", (file) => {
        if (isMarkdown(file) && this.#allows(file.path)) {
          this.#emit(
            "note.modified",
            file.path,
            this.#noteIds.getOrCreate(file.path),
          );
        }
      }),
    );
    this.#plugin.registerEvent(
      this.#app.vault.on("rename", (file, oldPath) => {
        if (
          !isMarkdown(file) &&
          !oldPath.toLocaleLowerCase("en-US").endsWith(".md")
        )
          return;
        const oldAllowed = this.#allows(oldPath);
        const newAllowed = this.#allows(file.path);
        const noteId = this.#noteIds.rename(oldPath, file.path);
        if (oldAllowed && newAllowed)
          this.#emit("note.renamed", file.path, noteId);
        else if (oldAllowed) this.#emit("note.deleted", oldPath, noteId);
        else if (newAllowed) this.#emit("note.created", file.path, noteId);
      }),
    );
    this.#plugin.registerEvent(
      this.#app.vault.on("delete", (file) => {
        if (isMarkdown(file) && this.#allows(file.path)) {
          this.#emit(
            "note.deleted",
            file.path,
            this.#noteIds.remove(file.path),
          );
        }
      }),
    );
    this.#plugin.registerEvent(
      this.#app.metadataCache.on("changed", (file) => {
        if (this.#allows(file.path)) {
          this.#emit(
            "metadata.changed",
            file.path,
            this.#noteIds.getOrCreate(file.path),
          );
        }
      }),
    );
    this.#plugin.registerEvent(
      this.#app.workspace.on("file-open", (file) => {
        if (file !== null && this.#allows(file.path)) {
          this.#emit(
            "active_note.changed",
            file.path,
            this.#noteIds.getOrCreate(file.path),
          );
        } else {
          this.#emit("active_note.changed");
        }
      }),
    );
  }

  connected(): void {
    this.#emit("vault.connected");
  }

  disconnected(): void {
    this.#emit("vault.disconnected");
  }

  #emit(type: VaultEvent["type"], path?: string, noteId?: string): void {
    const event = VaultEventSchema.parse({
      type,
      vaultId: this.#settings().vaultId,
      ...(path === undefined ? {} : { path }),
      ...(noteId === undefined ? {} : { noteId }),
      occurredAt: new Date().toISOString(),
    });
    this.#gateway.sendEvent(event);
  }

  #allows(path: string): boolean {
    const settings = this.#settings();
    try {
      return new VaultPermissions({
        allowedRoots: settings.allowedRoots,
        excludedRoots: settings.excludedRoots,
        scopes: settings.enabledScopes,
      }).allowsPath(path);
    } catch {
      return false;
    }
  }
}
