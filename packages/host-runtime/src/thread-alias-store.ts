import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ThreadAliasStoreOptions {
  directory: string;
}

export interface ThreadAliasStoreLike {
  resolve(threadId: string): string;
  reverseResolve(threadId: string): string | null;
  has(threadId: string): boolean;
  hasOfficial(officialThreadId: string): boolean;
  setAlias(externalThreadId: string, officialThreadId: string): Promise<void>;
}

export class ThreadAliasStore implements ThreadAliasStoreLike {
  readonly #aliases = new Map<string, string>();
  readonly #reverseAliases = new Map<string, string>();
  readonly #filePath: string;

  constructor(options: ThreadAliasStoreOptions) {
    this.#filePath = path.join(options.directory, "thread-aliases.json");
    this.#load();
  }

  resolve(threadId: string): string {
    return this.#aliases.get(threadId) ?? threadId;
  }

  reverseResolve(threadId: string): string | null {
    return this.#reverseAliases.get(threadId) ?? null;
  }

  has(threadId: string): boolean {
    return this.#aliases.has(threadId);
  }

  hasOfficial(officialThreadId: string): boolean {
    return this.#reverseAliases.has(officialThreadId);
  }

  async setAlias(externalThreadId: string, officialThreadId: string): Promise<void> {
    this.#aliases.set(externalThreadId, officialThreadId);
    this.#reverseAliases.set(officialThreadId, externalThreadId);
    await this.#save();
  }

  #load(): void {
    try {
      if (existsSync(this.#filePath)) {
        const raw = JSON.parse(readFileSync(this.#filePath, "utf8"));
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          for (const [ext, off] of Object.entries(raw)) {
            if (typeof off === "string") {
              this.#aliases.set(ext, off);
              this.#reverseAliases.set(off, ext);
            }
          }
        }
      }
    } catch {
      // Degrade to memory map on corrupt file
    }
  }

  async #save(): Promise<void> {
    try {
      await mkdir(path.dirname(this.#filePath), { recursive: true });
      const obj = Object.fromEntries(this.#aliases);
      await writeFile(this.#filePath, JSON.stringify(obj, null, 2), "utf8");
    } catch {
      // Ignore save failure
    }
  }
}
