import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  accountBalanceSnapshotSchema,
  type AccountBalanceSnapshot,
} from "@codexhost/shared-contracts";

export const DEEPSEEK_BALANCE_ENDPOINT = "https://api.deepseek.com/user/balance";

export interface DeepSeekBalanceResponse {
  is_available: boolean;
  balance_infos: Array<{
    currency: string;
    total_balance: string;
    granted_balance?: string;
    topped_up_balance?: string;
  }>;
}

export interface FetchDeepSeekBalanceInput {
  apiKey?: string;
  environment?: NodeJS.ProcessEnv;
  readAuthFile?: (filePath: string) => Promise<string>;
  fetch?: typeof globalThis.fetch;
}

function number(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseDeepSeekBalance(value: unknown): AccountBalanceSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Partial<DeepSeekBalanceResponse>;
  if (response.is_available !== true || !Array.isArray(response.balance_infos)) return null;
  const balances = response.balance_infos.flatMap((info) => {
    if (!info || typeof info.currency !== "string" || !info.currency.trim()) return [];
    const totalBalance = number(info.total_balance);
    if (totalBalance === undefined) return [];
    const grantedBalance = number(info.granted_balance);
    const toppedUpBalance = number(info.topped_up_balance);
    return [
      {
        currency: info.currency,
        totalBalance,
        ...(grantedBalance !== undefined ? { grantedBalance } : {}),
        ...(toppedUpBalance !== undefined ? { toppedUpBalance } : {}),
      },
    ];
  });
  const parsed = accountBalanceSnapshotSchema.safeParse({ balances });
  return parsed.success ? parsed.data : null;
}

async function authApiKey(input: FetchDeepSeekBalanceInput): Promise<string | null> {
  if (input.apiKey?.trim()) return input.apiKey.trim();
  const environment = input.environment ?? process.env;
  if (environment.DEEPSEEK_API_KEY?.trim()) return environment.DEEPSEEK_API_KEY.trim();
  const authPath = path.join(environment.HOME ?? os.homedir(), ".pi", "agent", "auth.json");
  try {
    const text = await (input.readAuthFile ?? ((filePath) => readFile(filePath, "utf8")))(authPath);
    const auth: unknown = JSON.parse(text);
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) return null;
    const provider = (auth as Record<string, unknown>).deepseek;
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) return null;
    const key = (provider as Record<string, unknown>).key;
    return typeof key === "string" && key.trim() ? key.trim() : null;
  } catch {
    return null;
  }
}

export async function fetchDeepSeekBalance(
  input: FetchDeepSeekBalanceInput = {},
): Promise<AccountBalanceSnapshot | null> {
  const apiKey = await authApiKey(input);
  if (!apiKey) return null;
  try {
    const response = await (input.fetch ?? globalThis.fetch)(DEEPSEEK_BALANCE_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return parseDeepSeekBalance(await response.json());
  } catch {
    return null;
  }
}
