import { describe, expect, it, vi } from "vitest";

import {
  DEEPSEEK_BALANCE_ENDPOINT,
  fetchDeepSeekBalance,
  parseDeepSeekBalance,
} from "../src/credits.js";

describe("DeepSeek account balance", () => {
  it("parses official currency balances without converting them to percentages", () => {
    expect(
      parseDeepSeekBalance({
        is_available: true,
        balance_infos: [
          {
            currency: "CNY",
            total_balance: "12.50",
            granted_balance: "10.00",
            topped_up_balance: "2.50",
          },
        ],
      }),
    ).toEqual({
      balances: [{ currency: "CNY", totalBalance: 12.5, grantedBalance: 10, toppedUpBalance: 2.5 }],
    });
  });

  it("reads the configured API key and never exposes it in the request URL", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(DEEPSEEK_BALANCE_ENDPOINT);
      expect(init?.headers).toEqual({
        Authorization: "Bearer secret-key",
        Accept: "application/json",
      });
      return new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [{ currency: "USD", total_balance: "3" }],
        }),
        { status: 200 },
      );
    });
    await expect(fetchDeepSeekBalance({ apiKey: "secret-key", fetch })).resolves.toEqual({
      balances: [{ currency: "USD", totalBalance: 3 }],
    });
  });

  it("degrades to null for unavailable or malformed responses", async () => {
    await expect(
      fetchDeepSeekBalance({
        apiKey: "secret-key",
        fetch: vi.fn(async () => new Response("{}", { status: 200 })),
      }),
    ).resolves.toBeNull();
    expect(parseDeepSeekBalance({ is_available: false, balance_infos: [] })).toBeNull();
  });
});
