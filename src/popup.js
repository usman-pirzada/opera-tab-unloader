(function () {
  "use strict";

  const policy = window.TabPolicy;
  const $ = (selector) => document.querySelector(selector);
  const ui = {
    workspaceLabel: $("#workspace-label"),
    refresh: $("#refresh-button"),
    tabCount: $("#workspace-tab-count"),
    eligibleCount: $("#eligible-count"),
    skippedCount: $("#skipped-count"),
    reviewAll: $("#review-all-button"),
    confirmation: $("#bulk-confirmation"),
    confirmationText: $("#bulk-confirmation-text"),
    cancelBulk: $("#cancel-bulk-button"),
    confirmBulk: $("#confirm-bulk-button"),
    tabList: $("#tab-list"),
    status: $("#status")
  };

  let preferences = { ...policy.DEFAULT_PREFERENCES };
  let snapshot = null;
  let pendingIndividualId = null;
  let pendingBulk = null;
  let busy = false;

  function setStatus(message) {
    ui.status.textContent = message;
  }

  function normalizeId(value) {
    return policy.normalizeWorkspaceId(value);
  }

  function sameId(a, b) {
    const left = normalizeId(a);
    const right = normalizeId(b);
    return left !== null && right !== null && left === right;
  }

  function appendText(parent, tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = value;
    parent.appendChild(element);
    return element;
  }

  function updateControls() {
    ui.refresh.disabled = busy;
    ui.confirmBulk.disabled = busy;
    ui.reviewAll.disabled = busy || !snapshot ||
      snapshot.unknownWorkspaceCount > 0 || snapshot.eligibleTabs.length === 0;
    ui.tabList.querySelectorAll("button").forEach((button) => {
      button.disabled = busy;
    });
  }

  async function readActiveWorkspace() {
    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const activeTab = activeTabs.find((tab) => Number.isInteger(tab.id));
    if (!activeTab) {
      throw new Error("Could not identify the active tab in the last-focused browser window.");
    }

    const id = normalizeId(activeTab.workspaceId);
    if (id === null) {
      throw new Error("This Opera GX build did not expose the active tab's workspace ID. Unloading is disabled rather than guessing from its window.");
    }

    return {
      id,
      name: typeof activeTab.workspaceName === "string" && activeTab.workspaceName.trim()
        ? activeTab.workspaceName.trim()
        : "Workspace " + id
    };
  }

  async function readSnapshot() {
    const workspace = await readActiveWorkspace();
    const allTabs = await chrome.tabs.query({});
    const unknownWorkspaceCount = allTabs.filter((tab) => normalizeId(tab.workspaceId) === null).length;
    const workspaceTabs = allTabs.filter((tab) => sameId(tab.workspaceId, workspace.id));
    const evaluatedTabs = workspaceTabs.map((tab) => ({
      tab,
      evaluation: policy.evaluateTab(tab, workspace.id, preferences)
    }));

    return {
      workspace,
      unknownWorkspaceCount,
      workspaceTabs,
      evaluatedTabs,
      eligibleTabs: evaluatedTabs.filter((item) => item.evaluation.eligible).map((item) => item.tab),
      skippedTabs: evaluatedTabs.filter((item) => !item.evaluation.eligible)
    };
  }

  function clearConfirmation() {
    pendingIndividualId = null;
    pendingBulk = null;
    ui.confirmation.hidden = true;
  }

  function renderTab(item, workspaceId) {
    const tab = item.tab;
    const evaluation = item.evaluation;
    const row = document.createElement("article");
    row.className = "tab-row";

    const top = document.createElement("div");
    top.className = "tab-row-top";
    const details = document.createElement("div");
    details.style.minWidth = "0";
    appendText(details, "div", "tab-title", tab.title || "Untitled tab");
    let displayUrl = "URL unavailable";
    try {
      const parsed = new URL(tab.url);
      displayUrl = parsed.host || parsed.href;
    } catch (_error) {
      // The policy exposes unavailable/invalid URL reasons for skipped tabs.
    }
    appendText(details, "div", "tab-url", displayUrl);
    top.appendChild(details);
    appendText(top, "span", "tab-status" + (evaluation.eligible ? " eligible" : ""),
      evaluation.eligible ? "Passed" : "Skipped");
    row.appendChild(top);

    if (!evaluation.eligible) {
      const reasons = document.createElement("ul");
      reasons.className = "tab-reasons";
      evaluation.reasons.forEach((reason) => appendText(reasons, "li", "", reason));
      row.appendChild(reasons);
    } else {
      const actions = document.createElement("div");
      actions.className = "tab-actions";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tab-action-button";
      button.textContent = pendingIndividualId === tab.id ? "Confirm unload" : "Review & unload";
      button.disabled = busy;
      button.addEventListener("click", () => handleIndividual(tab.id, workspaceId));
      actions.appendChild(button);
      row.appendChild(actions);
    }
    return row;
  }

  function render(nextSnapshot) {
    snapshot = nextSnapshot;
    ui.workspaceLabel.textContent = nextSnapshot.workspace.name + " · ID " + nextSnapshot.workspace.id;
    ui.tabCount.textContent = String(nextSnapshot.workspaceTabs.length);
    ui.eligibleCount.textContent = String(nextSnapshot.eligibleTabs.length);
    ui.skippedCount.textContent = String(nextSnapshot.skippedTabs.length);
    ui.tabList.replaceChildren();

    if (nextSnapshot.unknownWorkspaceCount > 0) {
      appendText(ui.tabList, "p", "empty-state",
        nextSnapshot.unknownWorkspaceCount + " tab(s) have no verifiable workspace ID. Bulk unloading is blocked to avoid guessing.");
    }

    if (nextSnapshot.workspaceTabs.length === 0) {
      appendText(ui.tabList, "p", "empty-state", "No tabs could be confidently assigned to this workspace.");
    } else {
      nextSnapshot.evaluatedTabs.forEach((item) => {
        ui.tabList.appendChild(renderTab(item, nextSnapshot.workspace.id));
      });
    }

    ui.reviewAll.textContent = nextSnapshot.unknownWorkspaceCount > 0
      ? "Bulk unload blocked: unknown workspace IDs"
      : "Review " + nextSnapshot.eligibleTabs.length + " eligible tab(s)";
    updateControls();
  }

  async function refresh({ allowWhileBusy = false, clearPending = true } = {}) {
    if (busy && !allowWhileBusy) return;
    if (clearPending) clearConfirmation();

    setStatus("Reading tab metadata and checking workspace identity…");
    try {
      const next = await readSnapshot();
      render(next);
      if (next.unknownWorkspaceCount > 0) {
        setStatus("Safety hold: workspace identity is missing for one or more tabs. Bulk unloading is blocked.");
      } else {
        setStatus("Preflight complete. " + next.eligibleTabs.length + " tab(s) passed; " +
          next.skippedTabs.length + " skipped.");
      }
    } catch (error) {
      snapshot = null;
      ui.workspaceLabel.textContent = "Workspace could not be verified";
      ui.tabCount.textContent = "—";
      ui.eligibleCount.textContent = "—";
      ui.skippedCount.textContent = "—";
      ui.tabList.replaceChildren();
      appendText(ui.tabList, "p", "empty-state",
        error instanceof Error ? error.message : "Unable to read the current workspace.");
      ui.reviewAll.disabled = true;
      ui.refresh.disabled = false;
      setStatus("No tabs were unloaded.");
    }
  }

  async function inspectTab(tabId, expectedWorkspaceId, requireCompleteMap) {
    const activeWorkspace = await readActiveWorkspace();
    if (!sameId(activeWorkspace.id, expectedWorkspaceId)) {
      throw new Error("The active workspace changed. Refresh the list and review the new workspace.");
    }

    if (requireCompleteMap) {
      const allTabs = await chrome.tabs.query({});
      if (allTabs.some((tab) => normalizeId(tab.workspaceId) === null)) {
        throw new Error("Workspace identity became ambiguous during bulk unloading. Remaining tabs were not attempted.");
      }
    }

    const tab = await chrome.tabs.get(tabId);
    const evaluation = policy.evaluateTab(tab, expectedWorkspaceId, preferences);
    return { tab, evaluation };
  }

  async function discardOne(tabId, expectedWorkspaceId, requireCompleteMap = false) {
    const { tab, evaluation } = await inspectTab(tabId, expectedWorkspaceId, requireCompleteMap);
    if (!evaluation.eligible) {
      return {
        ok: false,
        skipped: true,
        message: "Skipped “" + (tab.title || "Tab") + "”: " + evaluation.reasons.join(" ")
      };
    }

    await chrome.tabs.discard(tabId);
    const after = await chrome.tabs.get(tabId);
    if (after.discarded !== true) {
      return {
        ok: false,
        skipped: false,
        message: (tab.title || "Tab") + ": Opera GX did not confirm that it was discarded."
      };
    }
    return { ok: true, skipped: false, message: (tab.title || "Tab") + " was discarded." };
  }

  async function handleIndividual(tabId, workspaceId) {
    if (busy) return;
    try {
      const { tab, evaluation } = await inspectTab(tabId, workspaceId, false);
      if (!evaluation.eligible) {
        pendingIndividualId = null;
        setStatus("Skipped: " + evaluation.reasons.join(" "));
        await refresh({ clearPending: false });
        return;
      }

      if (pendingIndividualId !== tabId) {
        pendingIndividualId = tabId;
        pendingBulk = null;
        ui.confirmation.hidden = true;
        render(snapshot);
        setStatus("Review “" + (tab.title || "this tab") +
          "”. Discarding reloads the page later and may lose unsaved application-only state. Click Confirm unload to continue.");
        return;
      }

      busy = true;
      updateControls();
      setStatus("Rechecking tab immediately before discard…");
      const result = await discardOne(tabId, workspaceId);
      pendingIndividualId = null;
      await refresh({ allowWhileBusy: true, clearPending: false });
      setStatus(result.message);
    } catch (error) {
      pendingIndividualId = null;
      await refresh({ allowWhileBusy: true, clearPending: false });
      setStatus(error instanceof Error ? error.message : "The tab could not be safely checked.");
    } finally {
      busy = false;
      if (snapshot) render(snapshot);
      else updateControls();
    }
  }

  async function beginBulkReview() {
    if (busy) return;
    pendingIndividualId = null;
    try {
      const latest = await readSnapshot();
      render(latest);
      if (latest.unknownWorkspaceCount > 0) {
        clearConfirmation();
        setStatus("Bulk unload blocked because not every tab has a verifiable workspace ID.");
        return;
      }
      if (latest.eligibleTabs.length === 0) {
        setStatus("No tabs passed the current safety checks.");
        return;
      }

      pendingBulk = {
        workspaceId: latest.workspace.id,
        tabIds: latest.eligibleTabs.map((tab) => tab.id)
      };
      ui.confirmationText.textContent = "Unload " + pendingBulk.tabIds.length + " tab(s) in “" +
        latest.workspace.name + "”? Each tab will be checked again just before discard. Unsaved application state cannot be detected reliably.";
      ui.confirmation.hidden = false;
      setStatus("Review the warning, then confirm to begin sequential unloading.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not verify the workspace; no tabs were unloaded.");
    }
  }

  async function confirmBulk() {
    if (busy || !pendingBulk) return;
    const operation = pendingBulk;
    busy = true;
    ui.confirmation.hidden = true;
    updateControls();
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;
    const messages = [];

    try {
      const before = await readSnapshot();
      if (!sameId(before.workspace.id, operation.workspaceId)) {
        throw new Error("The active workspace changed before confirmation. No tabs were unloaded.");
      }
      if (before.unknownWorkspaceCount > 0) {
        throw new Error("Bulk unload stopped because workspace identity is ambiguous.");
      }
      const candidateIds = before.eligibleTabs.map((tab) => tab.id);
      const sameCandidates = candidateIds.length === operation.tabIds.length &&
        candidateIds.every((id) => operation.tabIds.includes(id));
      if (!sameCandidates) {
        pendingBulk = null;
        render(before);
        setStatus("The candidate set changed since review. Nothing was unloaded; review the refreshed list again.");
        return;
      }

      for (let index = 0; index < operation.tabIds.length; index++) {
        setStatus("Rechecking and unloading tab " + (index + 1) + " of " + operation.tabIds.length + "…");
        try {
          const result = await discardOne(operation.tabIds[index], operation.workspaceId, true);
          if (result.ok) succeeded++;
          else if (result.skipped) skipped++;
          else failed++;
          messages.push(result.message);
        } catch (error) {
          failed++;
          messages.push(error instanceof Error ? error.message : "A tab discard failed.");
          if (error instanceof Error &&
              (error.message.includes("active workspace changed") ||
               error.message.includes("Workspace identity became ambiguous"))) {
            break;
          }
        }
      }

      pendingBulk = null;
      await refresh({ allowWhileBusy: true, clearPending: false });
      setStatus("Bulk operation finished: " + succeeded + " discarded, " + skipped +
        " skipped on recheck, " + failed + " failed. " + messages.slice(0, 2).join(" "));
    } catch (error) {
      pendingBulk = null;
      await refresh({ allowWhileBusy: true, clearPending: false });
      setStatus(error instanceof Error ? error.message : "Bulk operation aborted safely.");
    } finally {
      busy = false;
      if (snapshot) render(snapshot);
      else updateControls();
    }
  }

  async function loadPreferences() {
    const keys = Object.keys(policy.DEFAULT_PREFERENCES);
    try {
      const stored = await chrome.storage.local.get(keys);
      preferences = { ...policy.DEFAULT_PREFERENCES, ...stored };
    } catch (_error) {
      preferences = { ...policy.DEFAULT_PREFERENCES };
      setStatus("Preferences could not be loaded. Conservative defaults are active for this session.");
    }

    document.querySelectorAll("input[data-pref]").forEach((input) => {
      input.checked = preferences[input.dataset.pref] === true;
      input.addEventListener("change", async () => {
        const key = input.dataset.pref;
        preferences = { ...preferences, [key]: input.checked };
        clearConfirmation();
        try {
          await chrome.storage.local.set({ [key]: input.checked });
        } catch (_error) {
          setStatus("Could not save the preference. It is active for this popup session only.");
        }
        await refresh({ clearPending: false });
      });
    });
  }

  ui.refresh.addEventListener("click", () => refresh());
  ui.reviewAll.addEventListener("click", beginBulkReview);
  ui.cancelBulk.addEventListener("click", () => {
    pendingBulk = null;
    ui.confirmation.hidden = true;
    setStatus("Bulk unload cancelled. No tabs were unloaded.");
  });
  ui.confirmBulk.addEventListener("click", confirmBulk);

  (async function init() {
    if (!chrome.tabs || typeof chrome.tabs.discard !== "function") {
      setStatus("This browser build does not expose tabs.discard. Nothing was unloaded.");
      ui.reviewAll.disabled = true;
      return;
    }
    await loadPreferences();
    await refresh();
  })();
})();
