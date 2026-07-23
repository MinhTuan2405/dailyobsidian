import { randomId } from "./hash.js";

export class StableNoteIds {
  readonly #ids: Record<string, string>;
  readonly #onChange: () => void;

  constructor(ids: Record<string, string>, onChange: () => void) {
    this.#ids = ids;
    this.#onChange = onChange;
  }

  getOrCreate(path: string): string {
    const existing = this.#ids[path];
    if (existing !== undefined) return existing;
    const noteId = randomId("note");
    this.#ids[path] = noteId;
    this.#onChange();
    return noteId;
  }

  get(path: string): string | undefined {
    return this.#ids[path];
  }

  remove(path: string): string | undefined {
    const noteId = this.#ids[path];
    if (noteId !== undefined) {
      Reflect.deleteProperty(this.#ids, path);
      this.#onChange();
    }
    return noteId;
  }

  rename(oldPath: string, newPath: string): string {
    const noteId = this.#ids[oldPath] ?? this.#ids[newPath] ?? randomId("note");
    Reflect.deleteProperty(this.#ids, oldPath);
    this.#ids[newPath] = noteId;
    this.#onChange();
    return noteId;
  }
}
