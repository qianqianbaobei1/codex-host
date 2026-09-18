import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  harnessAccountSnapshotSchema,
  type HarnessAccountListResult,
  type HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";

/**
 * How eagerly per-account quota telemetry is refreshed while listing accounts.
 *
 * `force` belongs to an explicit user refresh, `stale` to background work that
 * must respect each Account's freshness window, and `none` keeps listing a
 * cheap metadata read for the Composer picker.
 */
export type HarnessCreditsRefreshMode = "none" | "stale" | "force";

/** A failed/unsupported plugin must not hide other accounts or leak native diagnostics. */
export async function inspectHarnessAccounts(
  adapters: Iterable<HarnessAdapter>,
  descriptors: readonly HarnessPluginDescriptor[],
  timeoutMs = 12_000,
  creditRefresh: HarnessCreditsRefreshMode = "none",
  onInvalidRow?: (message: string) => void,
): Promise<HarnessAccountListResult> {
  const accounts = await Promise.all(
    [...adapters].map(async (adapter) => {
      if (!adapter.inspectAccount && !adapter.inspectAccounts) return [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const pending: Promise<unknown> = (async () => {
          if (creditRefresh !== "none" && adapter.refreshAccountCredits) {
            await adapter
              .refreshAccountCredits({ force: creditRefresh === "force" })
              .catch(() => undefined);
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
        return entries.flatMap((entry, index) => {
          const parsed = harnessAccountSnapshotSchema.safeParse(entry);
          if (!parsed.success) {
            // A row the shared contract rejects is a Host/plugin version mismatch, not an Account
            // that stopped existing. Reporting it is what turns "a row silently disappeared"
            // into a named cause; a stale Host Bundle once dropped rows this way.
            const reasons = parsed.error.issues
              .slice(0, 3)
              .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
              .join("; ");
            onInvalidRow?.(
              `Harness '${adapter.harnessId}' account row ${index + 1} was dropped: ${reasons}`,
            );
            return [];
          }
          return [{ ...parsed.data, harnessId: adapter.harnessId, harnessName }];
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
