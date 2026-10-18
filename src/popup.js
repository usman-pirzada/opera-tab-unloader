(function () {
  "use strict";

  const policy = window.TabPolicy;
  const $ = (selector) => document.querySelector(selector);
  const ui = {
    workspaceLabel: $("#workspace-label"),
    workspaceSelect: $("#workspace-select"),
    workspaceScopeNote: $("#workspace-scope-note"),
    summaryWorkspaceName: $("#summary-workspace-name"),
    tabCount: $("#workspace-tab-count"),
    eligibleCount: $("#eligible-count"),
    skippedCount: $("#skipped-count"),
    unloadAll: $("#unload-all-button"),
    confirmation: $("#bulk-confirmation"),
    confirmationText: $("#bulk-confirmation-text"),
    cancelBulk: $("#cancel-bulk-button"),
    confirmBulk: $("#confirm-bulk-button"),
    tabSectionTitle: $("#tabs-title"),
    tabSectionNote: $("#tab-section-note"),
    tabSortSelect: $("#tab-sort-select"),
    tabList: $("#tab-list"),
    status: $("#status"),
    retry: $("#retry-button")
  };

  let preferences = { ...policy.DEFAULT_PREFERENCES };
  let tabSortMode = "eligible-first";
  let workspaceData = null;
  let snapshot = null;
  let selectedWorkspaceId = null;
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

  function displayWorkspaceName(workspace) {
    return workspace && workspace.name ? workspace.name : "Workspace " + (workspace ? workspace.id : "");
  }

  function updateControls() {
    ui.workspaceSelect.disabled = busy || !workspaceData;
    ui.tabSortSelect.disabled = busy || !snapshot;
    ui.confirmBulk.disabled = busy;
    ui.retry.disabled = busy;
    ui.retry.hidden = Boolean(workspaceData);
    const canUnloadSelectedWorkspace = snapshot &&
      policy.isSameWorkspace(snapshot.workspace.id, snapshot.currentWorkspaceId);
    ui.unloadAll.disabled = busy || !snapshot || !canUnloadSelectedWorkspace ||
      snapshot.unknownWorkspaceCount > 0 || snapshot.eligibleTabs.length === 0;
    ui.tabList.querySelectorAll("button").forEach((button) => {
      // Refreshing or changing the busy state must never unlock read-only rows.
      button.disabled = busy || button.dataset.requiresCurrentWorkspace === "true";
    });
    document.querySelectorAll(".preference-toggle").forEach((button) => {
      button.disabled = busy;
    });
  }

  function renderPreferenceToggle(button, isOn) {
    button.classList.toggle("is-on", isOn);
    button.classList.toggle("is-off", !isOn);
    button.textContent = isOn ? "ON" : "OFF";
    button.setAttribute("aria-pressed", String(isOn));
  }

  async function readWorkspaceData() {
    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const activeTab = activeTabs.find((tab) => Number.isInteger(tab.id));
    if (!activeTab) {
      throw new Error("Could not identify the active tab in the last-focused browser window.");
    }

    const currentWorkspaceId = normalizeId(activeTab.workspaceId);
    if (currentWorkspaceId === null) {
      throw new Error("Opera GX did not expose the active tab's workspace ID. Workspace targeting is disabled rather than guessing from the window.");
    }

    const allTabs = await chrome.tabs.query({});
    const workspacesById = new Map();
    for (const tab of allTabs) {
      const id = normalizeId(tab.workspaceId);
      if (id === null) continue;
      const known = workspacesById.get(id);
      const name = typeof tab.workspaceName === "string" && tab.workspaceName.trim()
        ? tab.workspaceName.trim()
        : null;
      if (!known) {
        workspacesById.set(id, { id, name: name || "Workspace " + id });
      } else if (name && (!known.name || known.name === "Workspace " + id)) {
        known.name = name;
      }
    }

    const activeWorkspaceName = typeof activeTab.workspaceName === "string" && activeTab.workspaceName.trim()
      ? activeTab.workspaceName.trim()
      : "Workspace " + currentWorkspaceId;
    if (!workspacesById.has(currentWorkspaceId)) {
      workspacesById.set(currentWorkspaceId, { id: currentWorkspaceId, name: activeWorkspaceName });
    } else if (activeWorkspaceName && activeWorkspaceName !== "Workspace " + currentWorkspaceId) {
      workspacesById.get(currentWorkspaceId).name = activeWorkspaceName;
    }

    const workspaces = Array.from(workspacesById.values()).sort((a, b) => {
      if (a.id === currentWorkspaceId) return -1;
      if (b.id === currentWorkspaceId) return 1;
      return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });

    const nameCounts = new Map();
    for (const workspace of workspaces) {
      nameCounts.set(workspace.name, (nameCounts.get(workspace.name) || 0) + 1);
    }
    for (const workspace of workspaces) {
      workspace.label = workspace.id === currentWorkspaceId
        ? "Current workspace — " + workspace.name
        : workspace.name + (nameCounts.get(workspace.name) > 1 ? " (ID " + workspace.id + ")" : "");
    }

    return {
      currentWorkspaceId,
      currentWorkspaceName: activeWorkspaceName,
      allTabs,
      workspaces,
      unknownWorkspaceCount: allTabs.filter((tab) => normalizeId(tab.workspaceId) === null).length
    };
  }

  function createSnapshot(data, targetWorkspaceId) {
    const targetId = normalizeId(targetWorkspaceId);
    const workspace = data.workspaces.find((item) => sameId(item.id, targetId));
    if (!workspace) {
      throw new Error("The selected workspace is no longer available. Choose another workspace.");
    }

    const workspaceTabs = data.allTabs.filter((tab) => sameId(tab.workspaceId, targetId));
    const evaluatedTabs = workspaceTabs.map((tab, index) => ({
      tab,
      index,
      evaluation: policy.evaluateTab(tab, targetId, preferences)
    }));
    const sortedTabs = policy.sortEvaluatedTabs(evaluatedTabs, tabSortMode);
    return {
      workspace,
      currentWorkspaceId: data.currentWorkspaceId,
      unknownWorkspaceCount: data.unknownWorkspaceCount,
      workspaceTabs,
      evaluatedTabs: sortedTabs,
      eligibleTabs: sortedTabs.filter((item) => item.evaluation.eligible).map((item) => item.tab),
      skippedTabs: sortedTabs.filter((item) => !item.evaluation.eligible)
    };
  }

  function renderWorkspaceOptions(data) {
    const currentValue = selectedWorkspaceId;
    ui.workspaceSelect.replaceChildren();
    for (const workspace of data.workspaces) {
      const option = document.createElement("option");
      option.value = workspace.id;
      option.textContent = workspace.label;
      ui.workspaceSelect.appendChild(option);
    }
    ui.workspaceSelect.value = currentValue;
  }

  function clearBulkConfirmation() {
    pendingBulk = null;
    ui.confirmation.hidden = true;
  }

  function renderTab(item, workspaceId) {
    const tab = item.tab;
    const evaluation = item.evaluation;
    const row = document.createElement("article");
    row.className = "tab-row " + (evaluation.eligible ? "eligible-row" : "skipped-row");

    const top = document.createElement("div");
    top.className = "tab-row-top";
    const details = document.createElement("div");
    details.className = "tab-details";
    appendText(details, "div", "tab-title", tab.title || "Untitled tab");
    let displayUrl = "URL unavailable";
    try {
      const parsed = new URL(tab.url);
      displayUrl = parsed.host || parsed.href;
    } catch (_error) {
      // The eligibility policy records unavailable or invalid URL reasons.
    }
    appendText(details, "div", "tab-url", displayUrl);
    top.appendChild(details);
    appendText(top, "span", "tab-status " + (evaluation.eligible ? "eligible" : "skipped"),
      evaluation.eligible ? "Eligible" : "Skipped");
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
      const workspaceIsCurrent = policy.isSameWorkspace(workspaceId, snapshot.currentWorkspaceId);
      button.type = "button";
      button.className = "tab-action-button";
      button.dataset.requiresCurrentWorkspace = String(!workspaceIsCurrent);
      button.textContent = workspaceIsCurrent ? "Unload tab" : "Switch workspace to unload";
      button.setAttribute("aria-label", workspaceIsCurrent
        ? "Unload tab: " + (tab.title || "Untitled tab")
        : "Switch to this workspace in Opera GX before unloading " + (tab.title || "this tab"));
      button.disabled = busy || !workspaceIsCurrent;
      if (workspaceIsCurrent) {
        button.addEventListener("click", () => handleIndividual(tab.id, workspaceId));
      }
      actions.appendChild(button);
      row.appendChild(actions);
    }
    return row;
  }

  function render(nextSnapshot, data) {
    snapshot = nextSnapshot;
    workspaceData = data;
    renderWorkspaceOptions(data);

    const isCurrentWorkspace = policy.isSameWorkspace(nextSnapshot.workspace.id, data.currentWorkspaceId);
    ui.workspaceLabel.textContent = "Managing " + displayWorkspaceName(nextSnapshot.workspace);
    ui.workspaceScopeNote.classList.toggle("read-only-note", !isCurrentWorkspace);
    ui.workspaceScopeNote.textContent = isCurrentWorkspace
      ? "Current workspace · Unloading enabled."
      : "Read-only preview. Switch to this workspace in Opera GX before unloading tabs.";
    ui.summaryWorkspaceName.textContent = isCurrentWorkspace ? "Current" : "Read-only";
    ui.tabSectionTitle.textContent = "Tabs in " + displayWorkspaceName(nextSnapshot.workspace);
    ui.tabSectionNote.textContent = isCurrentWorkspace
      ? "Eligible tabs are checked again immediately before unloading."
      : "Read-only preview: eligibility is shown, but unloading is disabled until you switch to this workspace in Opera GX.";
    ui.tabCount.textContent = String(nextSnapshot.workspaceTabs.length);
    ui.eligibleCount.textContent = String(nextSnapshot.eligibleTabs.length);
    ui.skippedCount.textContent = String(nextSnapshot.skippedTabs.length);

    ui.tabSortSelect.value = tabSortMode;
    ui.tabList.replaceChildren();

    if (nextSnapshot.unknownWorkspaceCount > 0) {
      appendText(ui.tabList, "p", "empty-state",
        nextSnapshot.unknownWorkspaceCount + " tab(s) do not expose a verifiable workspace ID. Bulk unloading is blocked to avoid guessing.");
    }

    if (nextSnapshot.workspaceTabs.length === 0) {
      appendText(ui.tabList, "p", "empty-state", "No tabs could be confidently assigned to this workspace.");
    } else {
      nextSnapshot.evaluatedTabs.forEach((item) => {
        ui.tabList.appendChild(renderTab(item, nextSnapshot.workspace.id));
      });
    }

    ui.unloadAll.textContent = nextSnapshot.unknownWorkspaceCount > 0
      ? "Bulk unload blocked: unknown workspace IDs"
      : !isCurrentWorkspace
        ? "Read-only: switch workspace to unload"
        : "Unload " + nextSnapshot.eligibleTabs.length + " eligible tab" + (nextSnapshot.eligibleTabs.length === 1 ? "" : "s");
    updateControls();
  }

  async function refresh({ allowWhileBusy = false, clearPending = true } = {}) {
    if (busy && !allowWhileBusy) return;
    if (clearPending) clearBulkConfirmation();

    setStatus("Checking workspace and tab eligibility…");
    try {
      const data = await readWorkspaceData();
      if (selectedWorkspaceId === null ||
          !data.workspaces.some((item) => sameId(item.id, selectedWorkspaceId))) {
        selectedWorkspaceId = data.currentWorkspaceId;
      }
      const next = createSnapshot(data, selectedWorkspaceId);
      render(next, data);

      if (next.unknownWorkspaceCount > 0) {
        setStatus("Safety hold: " + data.unknownWorkspaceCount +
          " tab(s) have unknown workspace identity. Bulk unloading is blocked.");
      } else if (!policy.isSameWorkspace(next.workspace.id, next.currentWorkspaceId)) {
        setStatus("Read-only preview: switch to “" + next.workspace.name + "” in Opera GX to unload its tabs.");
      } else {
        setStatus("Checked " + next.workspaceTabs.length + " tab(s) in " +
          next.workspace.name + ": " + next.eligibleTabs.length + " eligible, " +
          next.skippedTabs.length + " skipped.");
      }
      return true;
    } catch (error) {
      const detail = error instanceof Error && error.message
        ? error.message
        : "An unknown browser API error occurred.";
      snapshot = null;
      workspaceData = null;
      selectedWorkspaceId = null;
      clearBulkConfirmation();

      // Clear every workspace-specific field so an old workspace name/count/button
      // can never remain visible beside an unavailable-state message.
      ui.workspaceLabel.textContent = "Workspace unavailable";
      ui.workspaceScopeNote.textContent = "Workspace detection failed. Retry or close and reopen this popup.";
      ui.workspaceSelect.replaceChildren();
      appendText(ui.workspaceSelect, "option", "", "Workspace unavailable");
      ui.tabCount.textContent = "—";
      ui.eligibleCount.textContent = "—";
      ui.skippedCount.textContent = "—";
      ui.summaryWorkspaceName.textContent = "Unavailable";
      ui.tabSectionTitle.textContent = "Workspace tabs unavailable";
      ui.tabSectionNote.textContent = "No tab actions are available until workspace detection succeeds.";
      ui.tabList.replaceChildren();
      appendText(ui.tabList, "p", "empty-state", detail);
      ui.unloadAll.textContent = "Workspace unavailable";
      ui.unloadAll.disabled = true;
      ui.tabSortSelect.value = tabSortMode;
      ui.retry.hidden = false;
      setStatus("Workspace check failed: " + detail + " No tabs were unloaded.");
      updateControls();
      return false;
    }
  }

  async function inspectTab(tabId, expectedWorkspaceId, requireCompleteMap) {
    const data = await readWorkspaceData();
    if (!data.workspaces.some((item) => sameId(item.id, expectedWorkspaceId))) {
      throw new Error("The selected workspace no longer exists. No tab was unloaded.");
    }
    if (!policy.isSameWorkspace(expectedWorkspaceId, data.currentWorkspaceId)) {
      throw new Error("The selected workspace is not active in Opera GX. Switch to it in the browser before unloading. No tab was unloaded.");
    }
    if (requireCompleteMap && data.unknownWorkspaceCount > 0) {
      throw new Error("Workspace identity became ambiguous during bulk unloading. Remaining tabs were not attempted.");
    }

    const tab = await chrome.tabs.get(tabId);
    const evaluation = policy.evaluateTab(tab, expectedWorkspaceId, preferences);
    return { tab, evaluation };
  }

  async function discardOne(tabId, expectedWorkspaceId, requireCompleteMap) {
    const result = await inspectTab(tabId, expectedWorkspaceId, requireCompleteMap === true);
    const tab = result.tab;
    if (!result.evaluation.eligible) {
      return {
        ok: false,
        skipped: true,
        message: "Skipped “" + (tab.title || "Tab") + "”: " + result.evaluation.reasons.join(" ")
      };
    }

    try {
      await chrome.tabs.discard(tabId);
    } catch (error) {
      const detail = error instanceof Error && error.message
        ? error.message
        : "The browser returned an unknown API error.";
      throw new Error("Opera GX rejected the unload request: " + detail);
    }

    let after;
    try {
      after = await chrome.tabs.get(tabId);
    } catch (error) {
      const detail = error instanceof Error && error.message
        ? error.message
        : "The browser returned an unknown API error.";
      throw new Error("Opera GX returned from the unload request, but the final tab state could not be verified: " + detail);
    }

    if (!after || after.discarded !== true) {
      return {
        ok: false,
        skipped: false,
        message: (tab.title || "Tab") + ": the unload request returned, but Opera GX still does not confirm that the tab is discarded."
      };
    }
    return { ok: true, skipped: false, message: (tab.title || "Tab") + " was unloaded." };
  }

  async function handleIndividual(tabId, targetWorkspaceId) {
    if (busy) return;
    busy = true;
    updateControls();
    try {
      setStatus("Rechecking tab immediately before unloading…");
      const result = await discardOne(tabId, targetWorkspaceId, false);
      const refreshed = await refresh({ allowWhileBusy: true, clearPending: false });
      if (refreshed) setStatus(result.message);
    } catch (error) {
      const refreshed = await refresh({ allowWhileBusy: true, clearPending: false });
      if (refreshed) {
        setStatus(error instanceof Error ? error.message : "The tab could not be safely checked.");
      }
    } finally {
      busy = false;
      if (snapshot && workspaceData) render(snapshot, workspaceData);
      else updateControls();
    }
  }

  async function beginBulkReview() {
    if (busy) return;
    try {
      const data = await readWorkspaceData();
      if (selectedWorkspaceId === null ||
          !data.workspaces.some((item) => sameId(item.id, selectedWorkspaceId))) {
        selectedWorkspaceId = data.currentWorkspaceId;
      }
      const latest = createSnapshot(data, selectedWorkspaceId);
      render(latest, data);

      if (!policy.isSameWorkspace(latest.workspace.id, latest.currentWorkspaceId)) {
        clearBulkConfirmation();
        setStatus("Read-only preview: switch to “" + latest.workspace.name + "” in Opera GX before unloading tabs.");
        return;
      }
      if (latest.unknownWorkspaceCount > 0) {
        clearBulkConfirmation();
        setStatus("Bulk unload blocked because " + latest.unknownWorkspaceCount +
          " tab(s) have no verifiable workspace ID.");
        return;
      }
      if (latest.eligibleTabs.length === 0) {
        setStatus("No tabs passed the current preferences and safety checks.");
        return;
      }

      pendingBulk = {
        workspaceId: latest.workspace.id,
        tabIds: latest.eligibleTabs.map((tab) => tab.id)
      };
      ui.confirmationText.textContent = "Unload " + pendingBulk.tabIds.length + " eligible tab(s) in “" +
        latest.workspace.name + "”? Every tab will be checked again immediately before unloading.";
      ui.confirmation.hidden = false;
      setStatus("Confirm the bulk operation below to proceed. Individual tabs unload without this confirmation.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not verify workspace membership; no tabs were unloaded.");
    }
  }

  async function confirmBulk() {
    if (busy || !pendingBulk) return;
    const operation = pendingBulk;
    if (!sameId(selectedWorkspaceId, operation.workspaceId)) {
      clearBulkConfirmation();
      setStatus("The selected workspace changed. Review the new selection before unloading.");
      return;
    }

    busy = true;
    ui.confirmation.hidden = true;
    updateControls();
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;
    let aborted = false;
    const messages = [];

    try {
      const data = await readWorkspaceData();
      if (!policy.isSameWorkspace(operation.workspaceId, data.currentWorkspaceId)) {
        throw new Error("The active Opera GX workspace changed before bulk unloading. The operation was cancelled; switch to the target workspace and review again.");
      }
      if (data.unknownWorkspaceCount > 0) {
        throw new Error("Bulk unload stopped because one or more tabs have unknown workspace identity.");
      }
      const before = createSnapshot(data, operation.workspaceId);
      const currentIds = before.eligibleTabs.map((tab) => tab.id).sort((a, b) => a - b);
      const expectedIds = operation.tabIds.slice().sort((a, b) => a - b);
      const sameCandidates = currentIds.length === expectedIds.length &&
        currentIds.every((id, index) => id === expectedIds[index]);
      if (!sameCandidates) {
        pendingBulk = null;
        render(before, data);
        setStatus("The eligible tab list changed after review. Nothing was unloaded; review the refreshed list again.");
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
          messages.push(error instanceof Error ? error.message : "A tab unload failed.");
          // A thrown error means the target or browser API state is uncertain.
          // Stop rather than attempting more native discards in this batch.
          aborted = true;
          break;
        }
      }

      pendingBulk = null;
      const refreshed = await refresh({ allowWhileBusy: true, clearPending: false });
      if (refreshed) {
        setStatus("Bulk result: " + succeeded + " unloaded, " + skipped + " skipped on recheck, " +
          failed + " failed." + (aborted ? " Remaining tabs were not attempted." : "") +
          (messages.length > 0 ? " " + messages.slice(0, 2).join(" ") : ""));
      }
    } catch (error) {
      pendingBulk = null;
      const refreshed = await refresh({ allowWhileBusy: true, clearPending: false });
      if (refreshed) {
        setStatus(error instanceof Error ? error.message : "Bulk operation aborted safely.");
      }
    } finally {
      busy = false;
      if (snapshot && workspaceData) render(snapshot, workspaceData);
      else updateControls();
    }
  }

  function enableSafetyPreferenceButtons() {
    document.querySelectorAll(".preference-toggle[data-pref]").forEach((button) => {
      const key = button.dataset.pref;
      renderPreferenceToggle(button, preferences[key] === true);
      button.addEventListener("click", async () => {
        if (busy) return;
        const enabled = !(preferences[key] === true);
        preferences = { ...preferences, [key]: enabled };
        renderPreferenceToggle(button, enabled);
        clearBulkConfirmation();
        updateControls();
        try {
          await chrome.storage.local.set({ [key]: enabled });
        } catch (_error) {
          setStatus("Could not save that preference. The change remains active for this popup session.");
        }
        await refresh({ clearPending: false });
      });
    });
  }

  ui.workspaceSelect.addEventListener("change", async () => {
    if (busy) return;
    selectedWorkspaceId = normalizeId(ui.workspaceSelect.value);
    clearBulkConfirmation();
    await refresh({ clearPending: false });
  });

  ui.tabSortSelect.addEventListener("change", async () => {
    if (busy) return;
    const value = ui.tabSortSelect.value;
    if (!["eligible-first", "eligible-last", "tab-order"].includes(value)) return;
    tabSortMode = value;
    try {
      await chrome.storage.local.set({ tabSortMode });
    } catch (_error) {
      setStatus("The sort choice is active for this popup session but could not be saved.");
    }
    if (workspaceData && snapshot) {
      const next = createSnapshot(workspaceData, selectedWorkspaceId);
      render(next, workspaceData);
    }
  });

  ui.retry.addEventListener("click", () => refresh());
  ui.unloadAll.addEventListener("click", beginBulkReview);
  ui.cancelBulk.addEventListener("click", () => {
    clearBulkConfirmation();
    setStatus("Bulk unload cancelled. No tabs were unloaded.");
  });
  ui.confirmBulk.addEventListener("click", confirmBulk);

  async function loadPreferences() {
    const keys = [...Object.keys(policy.DEFAULT_PREFERENCES), "tabSortMode"];
    try {
      const stored = await chrome.storage.local.get(keys);
      preferences = { ...policy.DEFAULT_PREFERENCES };
      for (const key of Object.keys(policy.DEFAULT_PREFERENCES)) {
        if (typeof stored[key] === "boolean") preferences[key] = stored[key];
      }
      if (["eligible-first", "eligible-last", "tab-order"].includes(stored.tabSortMode)) {
        tabSortMode = stored.tabSortMode;
      }
    } catch (_error) {
      preferences = { ...policy.DEFAULT_PREFERENCES };
      tabSortMode = "eligible-first";
      setStatus("Saved preferences could not be loaded. Conservative defaults are active for this session.");
    }
    enableSafetyPreferenceButtons();
    ui.tabSortSelect.value = tabSortMode;
  }

  (async function init() {
    if (!chrome.tabs || typeof chrome.tabs.discard !== "function") {
      setStatus("This browser build does not expose tabs.discard. Nothing was unloaded.");
      ui.unloadAll.disabled = true;
      return;
    }
    await loadPreferences();
    // The selector always starts with the current workspace whenever the popup opens.
    selectedWorkspaceId = null;
    await refresh();
  })();
})();
