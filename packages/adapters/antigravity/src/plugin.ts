import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { AntigravityAdapter } from "./antigravity-adapter.js";
import { ANTIGRAVITY_COMMAND_ENV } from "./command.js";
import { loadAntigravityAccountsSync } from "./accounts.js";

export function createHarnessAdapter(context: HarnessPluginContext): AntigravityAdapter {
  const environment = { ...context.environment };
  const command = environment[ANTIGRAVITY_COMMAND_ENV];
  // Absent file -> legacy mode; malformed file -> the adapter fails closed.
  const accounts = loadAntigravityAccountsSync({ environment });
  return new AntigravityAdapter({
    ...(command ? { command } : {}),
    environment,
    accounts,
    // OAuth is stored in the OS keyring, not just under HOME. On Darwin the
    // adapter serializes a dedicated account-keychain lease and restores the
    // user's keychain settings after each Session or probe.
    manageDarwinKeychain: context.platform === "darwin",
  });
}
