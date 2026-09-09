import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface AntigravityLedgerTurn {
  nativeTurnKey: string;
  input: string;
  response: string;
  status: "succeeded" | "failed" | "cancelled";
  error?: string;
  modelSlug?: string;
}

export interface AntigravityLedgerData {
  version: 1;
  conversationId: string;
  cwd: string;
  turns: AntigravityLedgerTurn[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseTurn(value: unknown): AntigravityLedgerTurn | null {
  if (!isRecord(value)) return null;
  if (
    !nonBlankString(value.nativeTurnKey) ||
    typeof value.input !== "string" ||
    typeof value.response !== "string" ||
    (value.status !== "succeeded" && value.status !== "failed" && value.status !== "cancelled")
  ) {
    return null;
  }
  return {
    nativeTurnKey: value.nativeTurnKey,
    input: value.input,
    response: value.response,
    status: value.status,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(typeof value.modelSlug === "string" ? { modelSlug: value.modelSlug } : {}),
  };
}

function parseLedger(value: unknown): AntigravityLedgerData {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !nonBlankString(value.conversationId) ||
    !nonBlankString(value.cwd) ||
    !Array.isArray(value.turns)
  ) {
    throw new Error("Antigravity session ledger is invalid");
  }
  const turns = value.turns.map(parseTurn);
  if (turns.some((turn) => turn === null)) {
    throw new Error("Antigravity session ledger contains an invalid Turn");
  }
  return {
    version: 1,
    conversationId: value.conversationId,
    cwd: value.cwd,
    turns: turns as AntigravityLedgerTurn[],
  };
}

function dataDirectory(environment: NodeJS.ProcessEnv): string {
  const root = environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
  return path.join(root, "antigravity-sessions");
}

function fileName(conversationId: string): string {
  return `${Buffer.from(conversationId, "utf8").toString("base64url")}.json`;
}

export class AntigravitySessionLedger {
  readonly #directory: string;
  readonly #filePath: string;
  readonly #conversationId: string;
  readonly #cwd: string;

  constructor(input: { conversationId: string; cwd: string; environment?: NodeJS.ProcessEnv }) {
    this.#conversationId = input.conversationId;
    this.#cwd = input.cwd;
    this.#directory = dataDirectory(input.environment ?? process.env);
    this.#filePath = path.join(this.#directory, fileName(input.conversationId));
  }

  get filePath(): string {
    return this.#filePath;
  }

  async read(): Promise<AntigravityLedgerData | null> {
    try {
      const content = await readFile(this.#filePath, "utf8");
      const parsed = parseLedger(JSON.parse(content) as unknown);
      if (
        parsed.conversationId !== this.#conversationId ||
        path.resolve(parsed.cwd) !== path.resolve(this.#cwd)
      ) {
        throw new Error("Antigravity session ledger identity does not match the Native Session");
      }
      return parsed;
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async append(turn: AntigravityLedgerTurn): Promise<void> {
    const current = (await this.read()) ?? {
      version: 1 as const,
      conversationId: this.#conversationId,
      cwd: this.#cwd,
      turns: [],
    };
    const turns = current.turns.filter(({ nativeTurnKey }) => nativeTurnKey !== turn.nativeTurnKey);
    turns.push(turn);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(
      this.#directory,
      `.${path.basename(this.#filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ ...current, turns })}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.#filePath);
    } catch (error) {
      try {
        await rename(temporaryPath, `${temporaryPath}.failed`);
      } catch {
        // Best-effort cleanup; the durable ledger remains unchanged.
      }
      throw error;
    }
  }
}
