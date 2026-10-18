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
    retry: $("#retry-button"),
    refresh: $("#refresh-button"),
    startupStatus: $("#startup-status")
  };

  let preferences = { ...policy.DEFAULT_PREFERENCES };
  let tabSortMode = "eligible-first";
  let workspaceData = null;
  let snapshot = null;
  let selectedWorkspaceId = null;
  let pendingBulk = null;
  let busy = false;
  let reviewingBulk = false;
  let refreshSequence = 0;
  let refreshTimer = null;
  let refreshQueued = false;

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
    const controlsBusy = busy || reviewingBulk;
    ui.workspaceSelect.disabled = controlsBusy || !workspaceData;
    ui.tabSortSelect.disabled = controlsBusy || !snapshot;
    ui.confirmBulk.disabled = controlsBusy;
    ui.retry.disabled = controlsBusy;
    ui.refresh.disabled = controlsBusy;
    ui.retry.hidden = Boolean(workspaceData);
    const canUnloadSelectedWorkspace = snapshot &&
      policy.isSameWorkspace(snapshot.workspace.id, snapshot.currentWorkspaceId);
    ui.unloadAll.disabled = controlsBusy || Boolean(pendingBulk) || !snapshot || !canUnloadSelectedWorkspace ||
      snapshot.unknownWorkspaceCount > 0 || snapshot.eligibleTabs.length === 0;
    ui.tabList.querySelectorAll("button").forEach((button) => {
      // A row stays locked when the workspace is read-only, review is active, or
      // a bulk review is awaiting confirmation.
      button.disabled = controlsBusy || Boolean(pendingBulk) || button.dataset.requiresCurrentWorkspace === "true";
    });
    document.querySelectorAll(".preference-toggle").forEach((button) => {
      button.disabled = controlsBusy;
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
    updateControls();
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

  async function refresh({ allowWhileBusy = false, clearPending = true, quiet = false } = {}) {
    if ((busy || reviewingBulk) && !allowWhileBusy) {
      refreshQueued = true;
      return false;
    }
    if (clearPending) clearBulkConfirmation();

    const sequence = ++refreshSequence;
    if (!quiet) setStatus("Checking workspace and tab eligibility…");
    try {
      const data = await readWorkspaceData();
      if (sequence !== refreshSequence) return false;
      if (selectedWorkspaceId === null ||
          !data.workspaces.some((item) => sameId(item.id, selectedWorkspaceId))) {
        selectedWorkspaceId = data.currentWorkspaceId;
      }
      const next = createSnapshot(data, selectedWorkspaceId);
      render(next, data);

      if (!quiet) {
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
      }
      return true;
    } catch (error) {
      if (sequence !== refreshSequence) return false;
      const detail = error instanceof Error && error.message
        ? error.message
        : "An unknown browser API error occurred.";
      snapshot = null;
      workspaceData = null;
      selectedWorkspaceId = null;
      clearBulkConfirmation();

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
      if (!quiet) setStatus("Workspace check failed: " + detail + " No tabs were unloaded.");
      updateControls();
      return false;
    }
  }

  function scheduleRefresh() {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      if (busy || reviewingBulk) {
        refreshQueued = true;
        return;
      }
      const hadPendingReview = Boolean(pendingBulk);
      if (hadPendingReview) {
        clearBulkConfirmation();
        setStatus("Tab state changed. The bulk review was cancelled; review the refreshed list again.");
      }
      refresh({ clearPending: false, quiet: true }).catch(function () {});
    }, 250);
  }

  function attachLiveUpdates() {
    const eventNames = ["onUpdated", "onCreated", "onRemoved", "onActivated", "onReplaced"];
    eventNames.forEach(function (name) {
      const event = chrome.tabs && chrome.tabs[name];
      if (event && typeof event.addListener === "function") event.addListener(scheduleRefresh);
    });
    if (chrome.storage && chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === "function") {
      chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName === "local" && changes.startupStatus) renderStartupStatus(changes.startupStatus.newValue);
      });
    }
  }

  function renderStartupStatus(value) {
    if (!ui.startupStatus) return;
    if (!value || typeof value.message !== "string" || !value.message) {
      ui.startupStatus.textContent = preferences.autoUnloadOnStartup
        ? "Startup auto-unload is enabled for the next browser startup."
        : "Startup auto-unload is off.";
      return;
    }
    ui.startupStatus.textContent = "Last startup run: " + value.message;
  }

  async function loadStartupStatus() {
    try {
      const stored = await chrome.storage.local.get("startupStatus");
      renderStartupStatus(stored.startupStatus || null);
    } catch (_error) {
      renderStartupStatus(null);
    }
  }

  async function requestBackground(type, payload) {
    const response = await chrome.runtime.sendMessage({ type, ...(payload || {}) });
    if (!response || response.ok !== true) {
      throw new Error(response && response.error ? response.error : "The background unload coordinator did not respond.");
    }
    return response.result;
  }

  async function handleIndividual(tabId, targetWorkspaceId) {
    if (busy || reviewingBulk) return;
    clearBulkConfirmation();
    busy = true;
    updateControls();
    try {
      setStatus("Rechecking tab immediately before unloading…");
      const result = await requestBackground("UNLOAD_ONE", {
        tabId: tabId,
        workspaceId: targetWorkspaceId,
        preferences: preferences
      });
      const refreshed = await refresh({ allowWhileBusy: true, clearPending: false });
      if (refreshed && result && result.message) setStatus(result.message);
    } catch (error) {
      const refreshed = await refresh({ allowWhileBusy: true, clearPending: false });
      if (refreshed) setStatus(error instanceof Error ? error.message : "The tab could not be safely checked.");
    } finally {
      busy = false;
      if (snapshot && workspaceData) render(snapshot, workspaceData);
      else updateControls();
      if (refreshQueued) {
        refreshQueued = false;
        scheduleRefresh();
      }
    }
  }

  async function beginBulkReview() {
    if (busy || reviewingBulk || pendingBulk) {
      if (pendingBulk) setStatus("A bulk review is already awaiting confirmation. Confirm or cancel it first.");
      return;
    }
    reviewingBulk = true;
    updateControls();
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
    } finally {
      reviewingBulk = false;
      updateControls();
      if (refreshQueued) {
        refreshQueued = false;
        scheduleRefresh();
      }
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
    clearBulkConfirmation();
    updateControls();
    setStatus("The background coordinator is rechecking and unloading the reviewed tabs…");
    try {
      const result = await requestBackground("UNLOAD_BATCH", {
        workspaceId: operation.workspaceId,
        tabIds: operation.tabIds,
        preferences: preferences
      });
      const refreshed = await refresh({ allowWhileBusy: true, clearPending: false });
      if (refreshed && result && result.message) setStatus(result.message);
    } catch (error) {
      const refreshed = await refresh({ allowWhileBusy: true, clearPending: false });
      if (refreshed) setStatus(error instanceof Error ? error.message : "Bulk operation failed safely.");
    } finally {
      busy = false;
      if (snapshot && workspaceData) render(snapshot, workspaceData);
      else updateControls();
      if (refreshQueued) {
        refreshQueued = false;
        scheduleRefresh();
      }
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
        let saved = true;
        try {
          await chrome.storage.local.set({ [key]: enabled });
        } catch (_error) {
          saved = false;
        }
        await refresh({ clearPending: false });
        if (!saved) {
          setStatus(key === "autoUnloadOnStartup"
            ? "Could not save startup preference. The toggle is temporary for this popup; startup automation will not use it."
            : "Could not save that preference. The change remains active for this popup session.");
        } else if (key === "autoUnloadOnStartup") {
          renderStartupStatus(null);
          setStatus(enabled
            ? "Startup auto-unload is enabled for the next browser startup."
            : "Startup auto-unload is disabled.");
        }
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
  ui.refresh.addEventListener("click", () => refresh());
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
    if (!chrome.tabs || typeof chrome.tabs.query !== "function" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
      setStatus("This browser build does not expose the extension APIs required for safe unloading.");
      ui.unloadAll.disabled = true;
      return;
    }
    await loadPreferences();
    attachLiveUpdates();
    await loadStartupStatus();
    // The selector always starts with the current workspace whenever the popup opens.
    selectedWorkspaceId = null;
    await refresh();
  })();
})();
