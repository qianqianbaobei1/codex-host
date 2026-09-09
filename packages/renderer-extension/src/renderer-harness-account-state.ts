import type { HarnessAccountListResult } from "@codexhost/shared-contracts";

import type { RendererModelClient } from "./renderer-model-client.js";

/**
 * Per-Host cache of read-only Harness account rows (currently Antigravity)
 * rendered inside the composer Agent picker. Older Hosts without the multi
 * account API simply keep an empty list and the picker shows no group.
 */
export class RendererHarnessAccountState {
  accounts: HarnessAccountListResult["accounts"] = [];
  switching = false;
  #request: Promise<void> | null = null;

  constructor(readonly client: RendererModelClient) {}

  refresh(): Promise<void> {
    if (this.#request) return this.#request;
    this.#request = Promise.resolve()
      .then(() => this.client.listHarnessAccounts?.())
      .then((result) => {
        if (result) this.accounts = result.accounts;
      })
      .catch(() => {
        // Keep the last known rows on transient failures; the picker hides the
        // group when there is nothing to show.
      })
      .finally(() => {
        this.#request = null;
      });
    return this.#request;
  }
}
