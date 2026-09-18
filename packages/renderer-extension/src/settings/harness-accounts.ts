import {
  harnessIdSchema,
  type HarnessAccountLoginStartParams,
  type HarnessAccountLoginStartResult,
  type HarnessAccountListResult,
  type HarnessAccountSelectParams,
  type HarnessAccountCreateParams,
  type HarnessAccountDeleteParams,
} from "@codexhost/shared-contracts";
import { KNOWN_RENDERER_AGENTS } from "../agent-selection-state.js";
import { createRendererAgentIcon } from "../renderer-agent-icon.js";
import { rendererCreditsTone } from "../renderer-credits-control.js";
import { formatRendererCreditsPercent } from "../renderer-usage-control.js";
import {
  creditsProductLabel,
  renderAccountUsage,
  type AccountUsageDisplay,
} from "./accounts-usage.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface RendererHarnessAccountClient {
  listHarnessAccounts?(): Promise<HarnessAccountListResult>;
  refreshHarnessAccounts?(): Promise<HarnessAccountListResult>;
  selectHarnessAccount?(input: HarnessAccountSelectParams): Promise<HarnessAccountListResult>;
  startHarnessAccountLogin?(
    input: HarnessAccountLoginStartParams,
  ): Promise<HarnessAccountLoginStartResult>;
  createHarnessAccount?(input: HarnessAccountCreateParams): Promise<HarnessAccountListResult>;
  deleteHarnessAccount?(input: HarnessAccountDeleteParams): Promise<HarnessAccountListResult>;
}

/** Read-only telemetry, deliberately separate from Codex Account IDs and mutations. */
export function mountHarnessAccounts(
  context: RendererSettingsPageMountContext,
  messages: RendererSettingsMessages,
  getClient: () => RendererHarnessAccountClient | null,
  onChange: () => void,
) {
  const document = context.content.ownerDocument;
  const section = document.createElement("section");
  section.className = "settings-harness-accounts";
  section.hidden = true;

  const header = document.createElement("div");
  header.className = "settings-harness-accounts__header";

  const titleGroup = document.createElement("div");
  titleGroup.className = "settings-harness-accounts__title-group";

  const heading = document.createElement("h2");
  heading.className = "settings-harness-accounts__title";
  heading.textContent = messages.harnessAccountsTitle;

  const subtitle = document.createElement("p");
  subtitle.className = "settings-harness-accounts__subtitle";
  subtitle.textContent = messages.harnessAccountsDescription;

  titleGroup.append(heading, subtitle);

  const addAccountBtn = document.createElement("button");
  addAccountBtn.type = "button";
  addAccountBtn.className =
    "settings-command-button settings-command-button--secondary settings-harness-accounts__add-btn";
  addAccountBtn.textContent = `+ ${messages.addGeminiAccount}`;

  header.append(titleGroup);

  const list = document.createElement("div");
  list.className = "settings-harness-accounts-list";
  section.append(header, list);
  context.content.append(section);
  let accounts: HarnessAccountListResult["accounts"] = [];
  let refreshing = false;
  let selecting = false;
  let loggingInAccountId: string | null = null;
  let deletingAccountId: string | null = null;
  const expandedGrokAccounts = new Set<string>();
  let query = "";
  let display: AccountUsageDisplay = "remaining";

  const select = async (
    harnessId: HarnessAccountListResult["accounts"][number]["harnessId"],
    accountId: string,
  ): Promise<void> => {
    const client = getClient();
    if (
      !client?.selectHarnessAccount ||
      selecting ||
      deletingAccountId !== null ||
      context.signal.aborted
    )
      return;
    selecting = true;
    render();
    onChange();
    try {
      const result = await client.selectHarnessAccount({ harnessId, accountId });
      if (!context.signal.aborted) accounts = result.accounts;
    } catch {
      // Older Hosts and unsupported Harnesses keep the previous rows.
    } finally {
      selecting = false;
      if (!context.signal.aborted) {
        render();
        onChange();
      }
    }
  };

  const login = async (
    harnessId: HarnessAccountListResult["accounts"][number]["harnessId"],
    accountId: string,
  ): Promise<void> => {
    const client = getClient();
    if (
      !client?.startHarnessAccountLogin ||
      selecting ||
      deletingAccountId !== null ||
      loggingInAccountId !== null ||
      context.signal.aborted
    ) {
      return;
    }
    loggingInAccountId = accountId;
    render();
    onChange();
    try {
      await client.startHarnessAccountLogin({ harnessId, accountId });
    } catch {
      // The account remains needs_login; the user can retry explicitly.
    } finally {
      loggingInAccountId = null;
      if (!context.signal.aborted) {
        render();
        onChange();
      }
    }
  };

  const remove = async (
    harnessId: HarnessAccountListResult["accounts"][number]["harnessId"],
    accountId: string,
  ): Promise<void> => {
    const client = getClient();
    if (
      !client?.deleteHarnessAccount ||
      selecting ||
      deletingAccountId !== null ||
      loggingInAccountId !== null ||
      context.signal.aborted
    ) {
      return;
    }
    if (document.defaultView?.confirm?.(messages.accountDeleteConfirm) === false) return;
    deletingAccountId = accountId;
    render();
    onChange();
    try {
      const result = await client.deleteHarnessAccount({ harnessId, accountId });
      if (!context.signal.aborted) accounts = result.accounts;
    } catch {
      // The account remains; the user can retry explicitly.
    } finally {
      deletingAccountId = null;
      if (!context.signal.aborted) {
        render();
        onChange();
      }
    }
  };

  let formElement: HTMLDivElement | null = null;

  const getOrCreateForm = (): HTMLDivElement => {
    if (formElement) return formElement;
    const form = document.createElement("div");
    form.className = "settings-harness-create-form";
    form.style.display = "none";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "settings-harness-create-form__input";
    nameInput.placeholder =
      messages.locale === "zh-CN"
        ? "账号名称（如 倩倩账号、工作）"
        : "Account name (e.g. Work, Personal)";

    const idInput = document.createElement("input");
    idInput.type = "text";
    idInput.className = "settings-harness-create-form__input";
    idInput.placeholder =
      messages.locale === "zh-CN"
        ? "英文标识（可选，留空自动生成）"
        : "ID (optional, leave blank for auto)";

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "settings-command-button";
    submitBtn.textContent = messages.locale === "zh-CN" ? "创建并登录" : "Create & Sign In";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "settings-command-button settings-command-button--secondary";
    cancelBtn.textContent = messages.locale === "zh-CN" ? "取消" : "Cancel";

    const formStatus = document.createElement("span");
    formStatus.className = "settings-harness-create-form__status";
    formStatus.style.display = "none";

    form.append(nameInput, idInput, submitBtn, cancelBtn, formStatus);

    const doCreate = async (): Promise<void> => {
      const client = getClient();
      if (!client?.createHarnessAccount || context.signal.aborted) return;

      const displayName = nameInput.value.trim() || idInput.value.trim() || "Gemini 账号";
      let rawId = idInput.value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "");
      if (!rawId) {
        const existingIds = new Set(
          accounts.filter((a) => a.harnessId === "antigravity").map((a) => a.accountId),
        );
        let idx = 2;
        while (existingIds.has(`gemini-${idx}`)) idx++;
        rawId = `gemini-${idx}`;
      }

      submitBtn.disabled = true;
      cancelBtn.disabled = true;
      idInput.disabled = true;
      nameInput.disabled = true;
      formStatus.style.display = "inline";
      formStatus.style.color = "var(--settings-danger, #e5484d)";
      formStatus.textContent =
        messages.locale === "zh-CN" ? "正在创建隔离环境..." : "Creating isolated account...";

      try {
        const antigravityId = harnessIdSchema.parse("antigravity");
        const result = await client.createHarnessAccount({
          harnessId: antigravityId,
          accountId: rawId,
          name: displayName,
        });
        if (!context.signal.aborted) {
          accounts = result.accounts;
          form.style.display = "none";
          nameInput.value = "";
          idInput.value = "";
          render();
          onChange();
        }
        if (client.startHarnessAccountLogin) {
          await login(antigravityId, rawId);
        }
      } catch (err) {
        formStatus.style.display = "inline";
        formStatus.style.color = "var(--settings-danger, #e5484d)";
        formStatus.textContent = err instanceof Error ? err.message : String(err);
      } finally {
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        idInput.disabled = false;
        nameInput.disabled = false;
      }
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Enter") {
        e.preventDefault();
        void doCreate();
      } else if (e.key === "Escape") {
        form.style.display = "none";
      }
    };
    idInput.addEventListener("keydown", onKey);
    nameInput.addEventListener("keydown", onKey);
    submitBtn.addEventListener("click", () => void doCreate());
    cancelBtn.addEventListener("click", () => {
      form.style.display = "none";
    });

    header.after(form);
    formElement = form;
    return form;
  };

  addAccountBtn.addEventListener("click", () => {
    const form = getOrCreateForm();
    const isHidden = form.style.display === "none";
    form.style.display = isHidden ? "flex" : "none";
    if (isHidden) {
      const inputs = form.getElementsByTagName("input");
      if (inputs.length > 0) inputs[0]?.focus();
    }
  });

  let addBtnMounted = false;

  const render = (): void => {
    section.hidden = accounts.length === 0;
    const canCreate = Boolean(getClient()?.createHarnessAccount);
    if (canCreate && !addBtnMounted) {
      header.append(addAccountBtn);
      addBtnMounted = true;
    } else if (!canCreate && addBtnMounted) {
      addAccountBtn.remove();
      addBtnMounted = false;
    }
    list.replaceChildren();
    const visible = accounts.filter((account) =>
      `${account.harnessName} ${account.email ?? ""} ${account.label ?? ""} ${account.plan ?? ""}`
        .toLocaleLowerCase()
        .includes(query),
    );
    for (const account of visible) {
      const row = document.createElement("article");
      row.className = "settings-harness-account";
      row.dataset.harnessId = account.harnessId;
      const accountKey = `${account.harnessId}:${account.accountId ?? account.email ?? account.label ?? ""}`;
      const isExpanded = expandedGrokAccounts.has(accountKey);
      if (isExpanded) {
        row.className = "settings-harness-account settings-harness-account--expanded";
      }

      const identity = document.createElement("div");
      identity.className = "settings-harness-account__identity";
      const name = document.createElement("strong");
      name.className = "settings-account-email";
      const accountTitle = account.label ?? account.email ?? account.harnessName;
      name.textContent = accountTitle;
      name.title = name.textContent;
      identity.append(name);
      const metadata = document.createElement("div");
      metadata.className = "settings-account-metadata";
      const subtitleText = account.label && account.email ? account.email : account.harnessName;
      const subtitle = document.createElement("span");
      subtitle.className = "settings-account-provider";
      subtitle.textContent = subtitleText;
      subtitle.title = subtitleText;
      metadata.append(subtitle);
      if (account.plan) {
        const separator = document.createElement("span");
        separator.textContent = "·";
        separator.setAttribute("aria-hidden", "true");
        metadata.append(separator);
        const plan = document.createElement("span");
        plan.className = "settings-account-plan";
        plan.textContent = account.plan;
        metadata.append(plan);
      }
      if (metadata.childElementCount) identity.append(metadata);

      const person = document.createElement("div");
      person.className = "settings-account-row__person";
      const agent = KNOWN_RENDERER_AGENTS.find((agent) => agent === account.harnessId);
      if (agent) {
        const logo = document.createElement("div");
        logo.className = "settings-harness-account__logo";
        logo.setAttribute("aria-hidden", "true");
        logo.append(createRendererAgentIcon(agent, 28, document));
        person.append(logo);
      }
      person.append(identity);

      const hasSubProducts =
        account.harnessId === "grok" &&
        Boolean(account.credits?.productUsage && account.credits.productUsage.length > 0);

      const usageCredits =
        hasSubProducts && account.credits
          ? { ...account.credits, productUsage: undefined }
          : account.credits;

      const usage = usageCredits
        ? renderAccountUsage(
            document,
            { status: "ready", credits: usageCredits },
            messages,
            display,
            () => undefined,
          )
        : document.createElement("span");
      if (!usage) continue;
      if (!usageCredits) {
        usage.className = "settings-account-usage__message";
        usage.textContent = account.creditsStale
          ? messages.accountCreditsFailed
          : account.authState === "needs_login"
            ? messages.harnessAccountNeedsLogin
            : refreshing
              ? messages.accountCreditsLoading
              : messages.accountCreditsEmpty;
      }

      const usageContainer = document.createElement("div");
      usageContainer.className = "settings-harness-account__usage-container";
      usageContainer.append(usage);
      if (account.creditsStale && usageCredits) {
        // The numbers are the last good reading; say so instead of letting a
        // failed probe look like the current state (two Accounts once showed the
        // same figure because both probes had failed).
        usage.classList.add("settings-account-usage--stale");
        const note = document.createElement("span");
        note.className = "settings-account-usage__message";
        note.textContent = messages.accountCreditsFailed;
        note.title = account.creditsError
          ? `${messages.accountCreditsFailed}: ${account.creditsError}`
          : messages.accountCreditsFailed;
        usageContainer.append(note);
      }

      if (hasSubProducts) {
        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "settings-ghost-button settings-grok-expand-btn";
        const count = account.credits?.productUsage?.length ?? 0;
        toggleBtn.textContent = isExpanded
          ? `${messages.harnessAccountCollapseCredits} ⌃`
          : `${messages.harnessAccountViewAllCredits}${count > 0 ? ` (${count})` : ""} ⌄`;
        toggleBtn.addEventListener("click", () => {
          if (isExpanded) {
            expandedGrokAccounts.delete(accountKey);
          } else {
            expandedGrokAccounts.add(accountKey);
          }
          render();
        });
        usageContainer.append(toggleBtn);
      }

      if (hasSubProducts && isExpanded && account.credits?.productUsage) {
        const details = document.createElement("div");
        details.className = "settings-grok-details";
        for (const product of account.credits.productUsage) {
          const item = document.createElement("div");
          item.className = "settings-grok-detail-row";
          const label = document.createElement("span");
          label.className = "settings-grok-detail-label";
          label.textContent = creditsProductLabel(product.product, messages);
          const val = display === "remaining" ? 100 - product.usagePercent : product.usagePercent;
          const tone = rendererCreditsTone(product.usagePercent);
          const bar = document.createElement("div");
          bar.className = `settings-account-usage__bar settings-account-usage__bar--${tone}`;
          bar.setAttribute("role", "meter");
          bar.setAttribute(
            "aria-label",
            `${label.textContent} · ${display === "remaining" ? messages.accountCreditsRemaining : messages.accountCreditsUsed}`,
          );
          bar.setAttribute("aria-valuemin", "0");
          bar.setAttribute("aria-valuemax", "100");
          bar.setAttribute("aria-valuenow", String(val));
          const fill = document.createElement("span");
          fill.style.width = `${Math.min(100, Math.max(0, val))}%`;
          bar.append(fill);
          const percent = document.createElement("span");
          percent.className = `settings-grok-detail-percent settings-account-usage__percent--${tone}`;
          percent.textContent = formatRendererCreditsPercent(val);
          item.append(label, bar, percent);
          details.append(item);
        }
        usageContainer.append(details);
      }

      const actions = document.createElement("div");
      actions.className = "settings-account-actions";
      const selectableId = account.accountId;
      if (
        account.authState === "needs_login" &&
        selectableId &&
        getClient()?.startHarnessAccountLogin
      ) {
        const signIn = document.createElement("button");
        signIn.type = "button";
        signIn.className = "settings-account-action";
        signIn.textContent =
          loggingInAccountId === selectableId ? messages.accountSigningIn : messages.accountSignIn;
        signIn.disabled = selecting || loggingInAccountId !== null || deletingAccountId !== null;
        signIn.addEventListener("click", () => void login(account.harnessId, selectableId));
        actions.append(signIn);
      } else if (account.selectable && selectableId) {
        if (account.isDefault) {
          const badge = document.createElement("span");
          badge.className = "settings-account-active";
          badge.textContent = messages.accountDefaultBadge;
          actions.append(badge);
        } else {
          const use = document.createElement("button");
          use.type = "button";
          use.className = "settings-account-action";
          use.textContent = messages.accountUse;
          use.disabled = selecting || loggingInAccountId !== null || deletingAccountId !== null;
          use.addEventListener("click", () => void select(account.harnessId, selectableId));
          actions.append(use);
        }

        if (getClient()?.startHarnessAccountLogin) {
          const reauth = document.createElement("button");
          reauth.type = "button";
          reauth.className = "settings-account-action";
          reauth.textContent =
            loggingInAccountId === selectableId
              ? messages.accountSigningIn
              : messages.accountReauth;
          reauth.disabled = selecting || loggingInAccountId !== null || deletingAccountId !== null;
          reauth.addEventListener("click", () => void login(account.harnessId, selectableId));
          actions.append(reauth);
        }
      }

      if (
        account.harnessId === "antigravity" &&
        selectableId &&
        selectableId !== "default" &&
        getClient()?.deleteHarnessAccount
      ) {
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "settings-icon-button settings-account-delete";
        removeBtn.title = messages.accountDelete;
        removeBtn.setAttribute(
          "aria-label",
          `${messages.accountDelete}: ${accountTitle ?? account.harnessName}`,
        );
        removeBtn.disabled = selecting || loggingInAccountId !== null || deletingAccountId !== null;
        removeBtn.append(createRendererSettingsIcon("trash", 16));
        removeBtn.addEventListener("click", () => void remove(account.harnessId, selectableId));
        actions.append(removeBtn);
      }

      row.append(person, usageContainer, actions);
      list.append(row);
    }
    if (accounts.length && !visible.length) {
      const empty = document.createElement("p");
      empty.className = "settings-account-empty";
      empty.textContent = messages.accountNoMatches;
      list.append(empty);
    }
  };
  return {
    get refreshing() {
      return refreshing;
    },
    get selecting() {
      return selecting;
    },
    update(nextQuery: string, nextDisplay: AccountUsageDisplay) {
      query = nextQuery;
      display = nextDisplay;
      render();
    },
    async refresh(): Promise<void> {
      if (refreshing || context.signal.aborted) return;
      const client = getClient();
      const refreshAccounts = client?.refreshHarnessAccounts ?? client?.listHarnessAccounts;
      if (!refreshAccounts) return;
      refreshing = true;
      onChange();
      const listAccounts = client?.listHarnessAccounts;
      const hasExplicitRefresh = refreshAccounts !== listAccounts && Boolean(listAccounts);
      let baselineLoaded = false;
      const explicitRefreshRequest = hasExplicitRefresh
        ? Promise.resolve().then(() => refreshAccounts())
        : null;
      const baselineRequest =
        hasExplicitRefresh && listAccounts ? Promise.resolve().then(() => listAccounts()) : null;
      if (baselineRequest) {
        try {
          const baseline = await baselineRequest;
          baselineLoaded = true;
          if (!context.signal.aborted) {
            accounts = baseline.accounts;
            render();
            onChange();
          }
        } catch {
          // The explicit refresh below can still return a complete result.
        }
      }
      try {
        const result = await (explicitRefreshRequest ?? refreshAccounts());
        if (
          result.accounts.length === 0 &&
          refreshAccounts !== client?.listHarnessAccounts &&
          client?.listHarnessAccounts
        ) {
          const fallback = await client.listHarnessAccounts();
          if (!context.signal.aborted) accounts = fallback.accounts;
        } else if (!context.signal.aborted) {
          accounts = result.accounts;
        }
      } catch {
        // Keep the row visible when an older Host does not know the explicit
        // refresh RPC, or when telemetry is temporarily unavailable.
        if (hasExplicitRefresh && !baselineLoaded && listAccounts) {
          try {
            const result = await listAccounts();
            if (!context.signal.aborted) accounts = result.accounts;
          } catch {
            // Keep the previous rows; the user can retry explicitly.
          }
        }
      } finally {
        refreshing = false;
        if (!context.signal.aborted) {
          render();
          onChange();
        }
      }
    },
  };
}
