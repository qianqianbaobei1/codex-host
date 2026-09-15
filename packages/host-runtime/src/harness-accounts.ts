import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  harnessAccountSnapshotSchema,
  type HarnessAccountListResult,
  type HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";

/** A failed/unsupported plugin must not hide other accounts or leak native diagnostics. */
export async function inspectHarnessAccounts(
  adapters: Iterable<HarnessAdapter>,
  descriptors: readonly HarnessPluginDescriptor[],
  timeoutMs = 12_000,
  refreshCredits = false,
): Promise<HarnessAccountListResult> {
  const accounts = await Promise.all(
    [...adapters].map(async (adapter) => {
      if (!adapter.inspectAccount && !adapter.inspectAccounts) return [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const pending: Promise<unknown> = (async () => {
          // Listing remains a cheap metadata read for the Composer picker. The
          // settings page opts into this explicit refresh path when the user
          // asks to see current quota telemetry.
          if (refreshCredits && adapter.refreshAccountCredits) {
            await adapter.refreshAccountCredits().catch(() => undefined);
          }
          return adapter.inspectAccounts
            ? adapter.inspectAccounts()
            : (adapter.inspectAccount?.() ?? null);
        })();
        const value = await Promise.race([
          pending,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), timeoutMs);
          }),
        ]);
        if (value === null) return [];
        const entries = Array.isArray(value) ? value : [value];
        const harnessName =
          descriptors.find((plugin) => plugin.id === adapter.harnessId)?.name ?? adapter.harnessId;
        return entries.flatMap((entry) => {
          const parsed = harnessAccountSnapshotSchema.safeParse(entry);
          return parsed.success
            ? [{ ...parsed.data, harnessId: adapter.harnessId, harnessName }]
            : [];
        });
      } catch {
        return [];
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }),
  );
  return { accounts: accounts.flat() };
}
