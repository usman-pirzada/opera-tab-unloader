(function (root) {
  "use strict";
  if (typeof importScripts === "function" && !root.TabPolicy) importScripts("tab-policy.js");
  const policy = root.TabPolicy || (typeof require === "function" ? require("./tab-policy.js") : null);
  const PREF_KEYS = policy ? Object.keys(policy.DEFAULT_PREFERENCES) : [];
  const DEFAULT_OPERATION_STATUS = Object.freeze({ state: "idle", message: "Ready." });
  const STATUS_COLORS = Object.freeze({
    idle: "#7B8493",
    working: "#3985FF",
    success: "#20A464",
    error: "#E34850"
  });

  function createController(api, tabPolicy, options) {
    let operationQueue = Promise.resolve();
    let startupRun = null;
    let startupAttempted = false;
    let startupSequence = 0;
    let unresolvedDiscard = null;
    let statusEnabled = true;

    function timeoutError(operation) {
      const error = new Error(operation + " exceeded its configured time budget.");
      error.operationTimedOut = true;
      return error;
    }

    async function awaitWithinDeadline(promise, deadlineAt, operation) {
      if (!Number.isFinite(deadlineAt)) return await promise;
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw timeoutError(operation);
      let timer = null;
      try {
        return await Promise.race([
          Promise.resolve(promise),
          new Promise(function (_resolve, reject) {
            timer = setTimeout(function () { reject(timeoutError(operation)); }, remaining);
          })
        ]);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    }

    function observeUnresolvedDiscard(promise) {
      let tracked;
      tracked = Promise.resolve(promise).then(function () {}, function () {}).then(function () {
        if (unresolvedDiscard === tracked) {
          unresolvedDiscard = null;
          setActionStatus("error", "A timed-out discard request has settled; review tab state before retrying.");
        }
      });
      unresolvedDiscard = tracked;
    }

    function drawStatusIcon(state, size) {
      const canvas = new OffscreenCanvas(size, size);
      const context = canvas.getContext("2d");
      const scale = size / 16;
      context.clearRect(0, 0, size, size);
      context.fillStyle = "#20232B";
      context.fillRect(scale, scale, size - 2 * scale, size - 2 * scale);
      context.fillStyle = "#F2F4F8";
      context.fillRect(size * 0.23, size * 0.18, size * 0.49, size * 0.60);
      context.strokeStyle = "#737C8B";
      context.lineWidth = Math.max(1, size / 18);
      [0.36, 0.49, 0.62].forEach(function (fraction, index) {
        context.beginPath();
        context.moveTo(size * 0.32, size * fraction);
        context.lineTo(size * (index === 2 ? 0.54 : 0.62), size * fraction);
        context.stroke();
      });
      if (state !== "off") {
        context.beginPath();
        context.arc(size * 0.76, size * 0.76, size * 0.20, 0, Math.PI * 2);
        context.fillStyle = "#20232B";
        context.fill();
        context.beginPath();
        context.arc(size * 0.76, size * 0.76, size * 0.16, 0, Math.PI * 2);
        context.fillStyle = STATUS_COLORS[state] || STATUS_COLORS.idle;
        context.fill();
        context.strokeStyle = "#FFFFFF";
        context.lineWidth = Math.max(1, size / 32);
        context.stroke();
      }
      return context.getImageData(0, 0, size, size);
    }

    async function setActionStatus(state, message) {
      const normalizedState = Object.prototype.hasOwnProperty.call(STATUS_COLORS, state) ? state : "idle";
      const status = {
        state: normalizedState,
        message: typeof message === "string" && message ? message : DEFAULT_OPERATION_STATUS.message,
        time: new Date().toISOString()
      };
      try {
        const stored = await api.storage.local.get("showStatusIndicator");
        statusEnabled = stored.showStatusIndicator !== false;
      } catch (_error) {}
      if (api.action) {
        try {
          if (typeof OffscreenCanvas === "function" && typeof api.action.setIcon === "function") {
            const imageData = {};
            const iconState = statusEnabled ? normalizedState : "off";
            [16, 32, 48].forEach(function (size) { imageData[size] = drawStatusIcon(iconState, size); });
            await api.action.setIcon({ imageData: imageData });
            if (!statusEnabled && typeof api.action.setBadgeText === "function") {
              await api.action.setBadgeText({ text: "" });
            }
          } else if (typeof api.action.setBadgeText === "function") {
            await api.action.setBadgeText({ text: statusEnabled && normalizedState !== "idle" ? "●" : "" });
            if (typeof api.action.setBadgeBackgroundColor === "function") {
              await api.action.setBadgeBackgroundColor({
                color: statusEnabled ? (STATUS_COLORS[normalizedState] || STATUS_COLORS.idle) : STATUS_COLORS.idle
              });
            }
          }
        } catch (_error) {
          try {
            if (typeof api.action.setBadgeText === "function") {
              await api.action.setBadgeText({ text: statusEnabled && normalizedState !== "idle" ? "●" : "" });
              if (typeof api.action.setBadgeBackgroundColor === "function") {
                await api.action.setBadgeBackgroundColor({ color: STATUS_COLORS[normalizedState] || STATUS_COLORS.idle });
              }
            }
          } catch (_ignored) {}
        }
        try {
          if (typeof api.action.setTitle === "function") {
            await api.action.setTitle({
              title: "Workspace Tab Unloader · " + (statusEnabled ? status.message : "Status indicator disabled")
            });
          }
        } catch (_error) {}
      }
      try { await api.storage.local.set({ operationStatus: status }); } catch (_error) {}
      return status;
    }

    const normalizeId = (value) => tabPolicy.normalizeWorkspaceId(value);
    const sameWorkspace = (left, right) => tabPolicy.isSameWorkspace(left, right);
    const errText = (error) => error && typeof error.message === "string" && error.message
      ? error.message : "The browser returned an unknown API error.";

    function withOperationLock(task) {
      const operation = operationQueue.catch(function () {}).then(async function () {
        await setActionStatus("working", "An unload operation is in progress.");
        try {
          const result = await task();
          let state = "success";
          let message = result && typeof result.message === "string" ? result.message : "Operation completed.";
          if (result && (result.failed > 0 ||
              ["aborted", "cancelled", "uncertain", "failure", "timeout", "failed"].includes(result.state))) {
            state = "error";
          } else if (result && ["skipped", "review-changed", "idle"].includes(result.state)) {
            state = "idle";
          }
          await setActionStatus(state, message);
          return result;
        } catch (error) {
          await setActionStatus("error", errText(error));
          throw error;
        }
      });
      operationQueue = operation.catch(function () {});
      return operation;
    }

    async function loadPreferences(override) {
      let stored = {};
      try {
        stored = await api.storage.local.get(PREF_KEYS);
      } catch (_error) {}
      return {
        preferences: tabPolicy.normalizePreferences({ ...stored, ...(override || {}) }),
        stored: stored
      };
    }

    async function saveStartupStatus(status) {
      const value = {
        time: new Date().toISOString(),
        state: status.state || "unknown",
        message: status.message || "",
        unloaded: Number.isInteger(status.unloaded) ? status.unloaded : 0,
        skipped: Number.isInteger(status.skipped) ? status.skipped : 0,
        failed: Number.isInteger(status.failed) ? status.failed : 0
      };
      try { await api.storage.local.set({ startupStatus: value }); } catch (_error) {}
      if (value.state === "running") {
        await setActionStatus("working", value.message);
      } else if (["completed", "success"].includes(value.state)) {
        await setActionStatus("success", value.message || "Startup operation completed.");
      } else if (["cancelled", "failed", "aborted", "timeout", "error"].includes(value.state)) {
        await setActionStatus("error", value.message || "Startup operation stopped.");
      } else {
        await setActionStatus("idle", value.message || "Startup auto-unload did not run.");
      }
      return value;
    }

    async function getActiveContext(deadlineAt) {
      const activeTabs = await awaitWithinDeadline(
        api.tabs.query({ active: true, lastFocusedWindow: true }), deadlineAt, "reading the active workspace"
      );
      const activeTab = activeTabs.find(function (tab) { return Number.isInteger(tab.id); }) || null;
      return {
        activeTab: activeTab,
        currentWorkspaceId: activeTab ? normalizeId(activeTab.workspaceId) : null
      };
    }

    async function getWorkspaceContext(deadlineAt) {
      const active = await getActiveContext(deadlineAt);
      const allTabs = await awaitWithinDeadline(api.tabs.query({}), deadlineAt, "enumerating tabs");
      return {
        activeTab: active.activeTab,
        currentWorkspaceId: active.currentWorkspaceId,
        allTabs: allTabs,
        unknownWorkspaceCount: allTabs.filter(function (tab) {
          return normalizeId(tab.workspaceId) === null;
        }).length
      };
    }

    function wakeRun(run) {
      if (run && typeof run.wake === "function") run.wake();
    }

    function waitForSignal(run, milliseconds, observedGeneration) {
      return new Promise(function (resolve) {
        if (run.cancelled ||
            (Number.isInteger(observedGeneration) && run.updateGeneration !== observedGeneration)) {
          resolve();
          return;
        }
        let done = false;
        let timer;
        const finish = function () {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (run.wake === finish) run.wake = null;
          resolve();
        };
        run.wake = finish;
        timer = setTimeout(finish, Math.max(0, milliseconds));
        // Close the small race between checking the generation and registering wake.
        if (run.cancelled ||
            (Number.isInteger(observedGeneration) && run.updateGeneration !== observedGeneration)) finish();
      });
    }

    function cancelStartupRun(run, reason) {
      if (!run || run.cancelled) return;
      run.cancelled = true;
      run.cancelReason = reason || "The active workspace changed.";
      wakeRun(run);
    }

    function addCandidate(run, tab) {
      if (!run || run.cancelled || !run.collecting || !tab || !Number.isInteger(tab.id)) return;
      if (sameWorkspace(tab.workspaceId, run.workspaceId)) run.candidates.add(tab.id);
    }

    function onTabCreated(tab) {
      const run = startupRun;
      if (!run || run.cancelled || !run.collecting) return;
      const wasCandidate = run.candidates.has(tab && tab.id);
      addCandidate(run, tab);
      if (!wasCandidate && tab && run.candidates.has(tab.id)) {
        run.updateGeneration += 1;
        run.lastActivityAt = Date.now();
        if (run.phase === "waiting-load") wakeRun(run);
      }
    }

    function onTabUpdated(tabId, _changeInfo, tab) {
      const run = startupRun;
      if (!run || run.cancelled) return;
      if (run.collecting) addCandidate(run, tab);
      if (run.candidates.has(tabId)) {
        run.updateGeneration += 1;
        run.lastActivityAt = Date.now();
        if (run.phase === "waiting-load") wakeRun(run);
      }
    }

    function onTabRemoved(tabId) {
      const run = startupRun;
      if (!run || run.cancelled || !run.candidates.has(tabId)) return;
      run.candidates.delete(tabId);
      run.updateGeneration += 1;
      run.lastActivityAt = Date.now();
      if (run.phase === "waiting-load") wakeRun(run);
    }

    async function onTabActivated(activeInfo) {
      const run = startupRun;
      if (!run || run.cancelled) return;

      // Inspect both the event tab and the active tab in the last-focused window.
      // A switch away and back can happen before this asynchronous handler resumes;
      // the event tab still lets us detect that switch when it belongs to the focused
      // window. Events from an unfocused window must not cancel the startup run.
      const [eventTabResult, focusedContextResult] = await Promise.allSettled([
        api.tabs.get(activeInfo.tabId),
        getActiveContext()
      ]);
      const eventTab = eventTabResult.status === "fulfilled" ? eventTabResult.value : null;
      const focusedContext = focusedContextResult.status === "fulfilled" ? focusedContextResult.value : null;
      const currentWorkspaceId = focusedContext ? focusedContext.currentWorkspaceId : null;
      const focusedWindowId = focusedContext && focusedContext.activeTab
        ? focusedContext.activeTab.windowId : null;
      const eventWindowId = activeInfo && Number.isInteger(activeInfo.windowId)
        ? activeInfo.windowId
        : (eventTab ? eventTab.windowId : null);
      const eventWorkspaceId = eventTab ? normalizeId(eventTab.workspaceId) : null;
      const activationIsInFocusedWindow = Number.isInteger(eventWindowId) &&
        Number.isInteger(focusedWindowId) && eventWindowId === focusedWindowId;

      if (activationIsInFocusedWindow && !sameWorkspace(eventWorkspaceId, run.workspaceId)) {
        cancelStartupRun(run, eventWorkspaceId === null
          ? "The activated tab's workspace became unverifiable during startup. Remaining tabs were not attempted."
          : "Workspace changed during startup auto-unload. Remaining tabs were not attempted.");
      } else if (currentWorkspaceId === null) {
        cancelStartupRun(run, "The current workspace became unverifiable during startup auto-unload. Remaining tabs were not attempted.");
      } else if (!sameWorkspace(currentWorkspaceId, run.workspaceId)) {
        cancelStartupRun(run, "Workspace changed during startup auto-unload. Remaining tabs were not attempted.");
      } else {
        run.updateGeneration += 1;
        run.lastActivityAt = Date.now();
        if (run.phase === "waiting-load") wakeRun(run);
      }
    }

    async function inspectAndDiscard(tabId, targetWorkspaceId, preferences, requireCompleteMap, run, operation) {
      const prefs = tabPolicy.normalizePreferences(preferences);
      const operationOptions = operation && typeof operation === "object" ? operation : {};
      const startedAt = Date.now();
      const tabDeadlineAt = Math.min(
        startedAt + prefs.perTabTimeoutSeconds * 1000,
        Number.isFinite(operationOptions.deadlineAt) ? operationOptions.deadlineAt : Number.POSITIVE_INFINITY
      );
      if (unresolvedDiscard) {
        return { state: "aborted", message: "A previous discard request exceeded its timeout and remains unresolved. No further tabs were attempted." };
      }
      if (Date.now() >= tabDeadlineAt) {
        return { state: "aborted", message: "The operation deadline was reached before this tab could be checked." };
      }
      if (run && run.cancelled) {
        return { state: "aborted", message: run.cancelReason || "Startup auto-unload was cancelled." };
      }

      let context;
      try { context = await getWorkspaceContext(tabDeadlineAt); } catch (error) {
        return {
          state: "aborted",
          message: error && error.operationTimedOut
            ? "Per-tab time budget expired while verifying the active workspace. No unload was attempted."
            : "Could not verify the active workspace: " + errText(error)
        };
      }
      if (run && run.cancelled) {
        return { state: "aborted", message: run.cancelReason || "Startup auto-unload was cancelled." };
      }
      if (context.currentWorkspaceId === null) {
        return { state: "aborted", message: "The active workspace ID is unavailable. No further tabs were attempted." };
      }
      if (!sameWorkspace(targetWorkspaceId, context.currentWorkspaceId)) {
        if (run) cancelStartupRun(run, "Workspace changed during startup auto-unload. Remaining tabs were not attempted.");
        return { state: "aborted", message: "The active workspace changed. Remaining tabs were not attempted." };
      }
      if (requireCompleteMap && context.unknownWorkspaceCount > 0) {
        return { state: "aborted", message: "Workspace identity became ambiguous. Remaining tabs were not attempted." };
      }

      let tab;
      try {
        tab = await awaitWithinDeadline(api.tabs.get(tabId), tabDeadlineAt, "reading tab " + tabId);
      } catch (error) {
        if (error && error.operationTimedOut) {
          return { state: "aborted", message: "Per-tab time budget expired while reading tab " + tabId + ". Remaining tabs were not attempted." };
        }
        return { state: "skipped", message: "Tab " + tabId + " no longer exists before the unload attempt; skipped." };
      }
      const evaluation = tabPolicy.evaluateTab(tab, targetWorkspaceId, preferences);
      if (!evaluation.eligible) {
        return { state: "skipped", message: "Skipped \"" + (tab.title || "Tab") + "\": " + evaluation.reasons.join(" ") };
      }

      // Workspace verification and discard cannot be atomic in the browser API.
      // Recheck immediately before the call, and cancel the run on workspace events.
      if (run && run.cancelled) {
        return { state: "aborted", message: run.cancelReason || "Startup auto-unload was cancelled." };
      }
      let latestWorkspaceId;
      try { latestWorkspaceId = (await getActiveContext(tabDeadlineAt)).currentWorkspaceId; } catch (error) {
        return {
          state: "aborted",
          message: error && error.operationTimedOut
            ? "Per-tab time budget expired before the final workspace check. No unload was attempted."
            : "Could not recheck workspace before unloading: " + errText(error)
        };
      }
      if (run && run.cancelled) {
        return { state: "aborted", message: run.cancelReason || "Startup auto-unload was cancelled." };
      }
      if (!sameWorkspace(targetWorkspaceId, latestWorkspaceId)) {
        if (run) cancelStartupRun(run, "Workspace changed during startup auto-unload. Remaining tabs were not attempted.");
        return { state: "aborted", message: "The active workspace changed immediately before unloading. Remaining tabs were not attempted." };
      }

      if (Date.now() >= tabDeadlineAt ||
          (Number.isFinite(operationOptions.deadlineAt) && Date.now() >= operationOptions.deadlineAt)) {
        return { state: "aborted", message: "The time budget expired immediately before the discard request. No unload was attempted." };
      }

      let discardResult;
      let discardError = null;
      let discardPromise = null;
      try {
        discardPromise = Promise.resolve(api.tabs.discard(tabId));
        discardResult = await awaitWithinDeadline(discardPromise, tabDeadlineAt, "discarding tab " + tabId);
      } catch (error) {
        if (error && error.operationTimedOut && discardPromise) {
          observeUnresolvedDiscard(discardPromise);
          return {
            state: "uncertain",
            message: "The unload request for “" + (tab.title || "Tab") +
              "” exceeded its time budget. Its outcome is uncertain; no further tabs were attempted."
          };
        }
        discardError = error;
      }

      if (discardResult && discardResult.discarded === true) {
        return { state: "success", message: "\"" + (tab.title || "Tab") + "\" was unloaded." };
      }

      let after;
      try { after = await awaitWithinDeadline(api.tabs.get(tabId), tabDeadlineAt, "verifying tab " + tabId); } catch (error) {
        return {
          state: "uncertain",
          message: "Unload outcome for \"" + (tab.title || "Tab") +
            "\" is uncertain because the tab could not be found during verification: " + errText(error)
        };
      }
      if (after && after.discarded === true) {
        return { state: "success", message: "\"" + (after.title || tab.title || "Tab") + "\" was unloaded." };
      }
      if (after && after.discarded === false) {
        return {
          state: "failure",
          message: "\"" + (after.title || tab.title || "Tab") + "\" was not discarded." +
            (discardError ? " Opera GX rejected the request: " + errText(discardError) : "")
        };
      }
      return {
        state: "uncertain",
        message: "Unload outcome for \"" + (tab.title || "Tab") + "\" is uncertain; the final discard state was not reported."
      };
    }

    async function unloadOneMessage(message) {
      const requestStartedAt = Date.now();
      return withOperationLock(async function () {
        const loaded = await loadPreferences(message.preferences);
        return inspectAndDiscard(message.tabId, message.workspaceId, loaded.preferences, false, null, {
          deadlineAt: requestStartedAt + loaded.preferences.overallDeadlineSeconds * 1000
        });
      });
    }

    async function unloadBatchMessage(message) {
      const requestStartedAt = Date.now();
      return withOperationLock(async function () {
        const loaded = await loadPreferences(message.preferences);
        const preferences = loaded.preferences;
        const deadlineAt = requestStartedAt + preferences.overallDeadlineSeconds * 1000;
        if (Date.now() >= deadlineAt) {
          return { state: "timeout", message: "The overall deadline expired before bulk review could start. No tabs were unloaded." };
        }
        const ids = Array.from(new Set((Array.isArray(message.tabIds) ? message.tabIds : [])
          .filter(function (id) { return Number.isInteger(id) && id >= 0; }))).sort(function (a, b) { return a - b; });
        if (!ids.length) return { state: "aborted", message: "No reviewed tab IDs were supplied. Nothing was unloaded." };

        let context;
        try { context = await getWorkspaceContext(deadlineAt); } catch (error) {
          return {
            state: error && error.operationTimedOut ? "timeout" : "aborted",
            message: error && error.operationTimedOut
              ? "The overall deadline expired while reading workspace state. No tabs were unloaded."
              : "Could not verify workspace before bulk unloading: " + errText(error)
          };
        }
        if (!sameWorkspace(message.workspaceId, context.currentWorkspaceId)) {
          return { state: "aborted", message: "The active workspace changed before bulk unloading. Nothing was unloaded." };
        }
        if (context.unknownWorkspaceCount > 0) {
          return {
            state: "aborted",
            message: "Bulk unload blocked because " + context.unknownWorkspaceCount + " tab(s) have unknown workspace identity."
          };
        }

        const currentIds = context.allTabs.filter(function (tab) {
          return sameWorkspace(tab.workspaceId, message.workspaceId) &&
            tabPolicy.evaluateTab(tab, message.workspaceId, preferences).eligible;
        }).map(function (tab) { return tab.id; }).sort(function (a, b) { return a - b; });
        if (currentIds.length !== ids.length || !currentIds.every(function (id, index) { return id === ids[index]; })) {
          return { state: "review-changed", message: "The eligible tab list changed after review. Nothing was unloaded; refresh and review again." };
        }

        const summary = { state: "completed", unloaded: 0, skipped: 0, failed: 0, aborted: false, messages: [] };
        for (const tabId of ids) {
          if (Date.now() >= deadlineAt) {
            summary.state = "timeout";
            summary.aborted = true;
            summary.messages.push("The overall deadline was reached. Remaining tabs were not attempted.");
            break;
          }
          const result = await inspectAndDiscard(tabId, message.workspaceId, preferences, true, null, { deadlineAt: deadlineAt });
          if (result.state === "success") summary.unloaded += 1;
          else if (result.state === "skipped") summary.skipped += 1;
          else if (result.state === "failure") summary.failed += 1;
          else {
            if (result.state === "uncertain") summary.failed += 1;
            summary.aborted = true;
            summary.state = "aborted";
            summary.messages.push(result.message);
            break;
          }
          if (summary.messages.length < 2 && result.message) summary.messages.push(result.message);
        }
        summary.message = "Bulk result: " + summary.unloaded + " unloaded, " + summary.skipped +
          " skipped on recheck, " + summary.failed + " failed." +
          (summary.aborted ? " Remaining tabs were not attempted." : "") +
          (summary.messages.length ? " " + summary.messages.join(" ") : "");
        return summary;
      });
    }

    async function startupContextStillCurrent(run) {
      const context = await getWorkspaceContext(run.deadlineAt);
      if (run.cancelled) return { ok: false, context: context };
      if (!sameWorkspace(run.workspaceId, context.currentWorkspaceId)) {
        cancelStartupRun(run, "Workspace changed during startup auto-unload. Tabs in the old workspace will not be attempted further.");
        return { ok: false, context: context };
      }
      return { ok: true, context: context };
    }

    async function waitForLoadingCandidates(run, timeoutMs, preferences, waitForLoads) {
      const deadline = Math.min(
        Date.now() + timeoutMs,
        Number.isFinite(run.deadlineAt) ? run.deadlineAt : Number.POSITIVE_INFINITY
      );
      const quietPeriodMs = 1200;
      const readinessPreferences = { ...preferences, skipLoadingTabs: false };
      run.phase = "waiting-load";
      while (!run.cancelled && Date.now() < deadline) {
        const generation = run.updateGeneration;
        const candidateIds = Array.from(run.candidates);
        let loadingFound = false;
        if (waitForLoads) {
          for (const tabId of candidateIds) {
            if (run.cancelled) return false;
            try {
              const tab = await awaitWithinDeadline(
                api.tabs.get(tabId),
                Math.min(Date.now() + preferences.perTabTimeoutSeconds * 1000, deadline),
                "checking a loading tab"
              );
              const couldBecomeEligible = tabPolicy.evaluateTab(
                tab, run.workspaceId, readinessPreferences
              ).eligible;
              if (sameWorkspace(tab.workspaceId, run.workspaceId) &&
                  tab.status === "loading" && couldBecomeEligible) {
                loadingFound = true;
                break;
              }
            } catch (error) {
              if (error && error.operationTimedOut) return false;
              // A tab closed during restoration is no longer a candidate.
            }
          }
        }
        if (generation !== run.updateGeneration) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const quietElapsed = Date.now() - (run.lastActivityAt || run.startedAt || Date.now());
        if (!loadingFound && quietElapsed >= quietPeriodMs) return true;

        // Even if no currently-known tab is loading, keep collecting briefly
        // after the most recent relevant tab event. This catches tabs restored
        // a little later than the first query without polling the browser.
        const waitMs = loadingFound
          ? remaining
          : Math.min(remaining, Math.max(1, quietPeriodMs - quietElapsed));
        await waitForSignal(run, waitMs, generation);
      }
      return false;
    }

    async function runStartupAutoUnload() {
      if (startupAttempted) return;
      startupAttempted = true;
      const startupStartedAt = Date.now();
      // Start reading the active workspace immediately, before storage latency can
      // delay the startup scope snapshot.
      const activePromise = getActiveContext().then(function (value) {
        return { active: value, error: null };
      }).catch(function (error) {
        return { active: null, error: error };
      });
      // Start loading preferences concurrently, but establish the startup workspace
      // run before waiting for storage so workspace-switch events cannot be missed.
      const preferencesPromise = loadPreferences();
      const activeResult = await activePromise;
      if (activeResult.error) {
        await saveStartupStatus({ state: "skipped", message: "Startup auto-unload skipped because the active tab could not be read: " + errText(activeResult.error) });
        return;
      }
      const active = activeResult.active;
      if (active.currentWorkspaceId === null) {
        await saveStartupStatus({
          state: "skipped",
          message: "Startup auto-unload skipped: Opera GX did not expose a verifiable current workspace ID. No tabs were unloaded."
        });
        return;
      }

      const run = {
        id: ++startupSequence,
        workspaceId: active.currentWorkspaceId,
        candidates: new Set(),
        collecting: true,
        phase: "discovering",
        cancelled: false,
        cancelReason: "",
        updateGeneration: 0,
        wake: null,
        loadingWaitExpired: false,
        startedAt: startupStartedAt,
        lastActivityAt: Date.now(),
        deadlineAt: Number.POSITIVE_INFINITY
      };
      startupRun = run;

      try {
        const loaded = await awaitWithinDeadline(preferencesPromise, startupStartedAt + 10000, "loading startup settings");
        const preferences = loaded.preferences;
        run.deadlineAt = startupStartedAt + preferences.overallDeadlineSeconds * 1000;
        if (!preferences.autoUnloadOnStartup) {
          await setActionStatus("idle", "Startup auto-unload is disabled.");
          return;
        }
        if (run.cancelled) {
          await saveStartupStatus({
            state: "cancelled",
            message: run.cancelReason + " No tabs were unloaded."
          });
          return;
        }

        await saveStartupStatus({
          state: "running",
          message: "Startup auto-unload is checking tabs in the workspace that was current at startup."
        });

        try {
          (await awaitWithinDeadline(
            api.tabs.query({}),
            run.deadlineAt,
            "discovering restored tabs"
          )).forEach(function (tab) { addCandidate(run, tab); });
        } catch (error) {
          await saveStartupStatus({
            state: error && error.operationTimedOut ? "timeout" : "failed",
            message: "Startup auto-unload could not enumerate tabs: " + errText(error)
          });
          return;
        }

        // Include tabs that Opera restores shortly after the startup event.
        // Workspace activation events cancel this run rather than retargeting it.
        const discoveryMs = options && Number.isFinite(options.discoveryMs)
          ? options.discoveryMs
          : preferences.startupDiscoverySeconds * 1000;
        const discoveryWaitMs = Math.max(0, Math.min(discoveryMs, run.deadlineAt - Date.now()));
        if (discoveryWaitMs > 0) await waitForSignal(run, discoveryWaitMs);
        if (run.cancelled) {
          await saveStartupStatus({ state: "cancelled", message: run.cancelReason + " No further tabs were attempted." });
          return;
        }

        const latest = await startupContextStillCurrent(run);
        if (!latest.ok) {
          await saveStartupStatus({ state: "cancelled", message: run.cancelReason + " No further tabs were attempted." });
          return;
        }
        if (latest.context.unknownWorkspaceCount > 0) {
          await saveStartupStatus({
            state: "skipped",
            message: "Startup auto-unload skipped because " + latest.context.unknownWorkspaceCount +
              " tab(s) have unknown workspace identity. No tabs were unloaded."
          });
          return;
        }

        if (Date.now() >= run.deadlineAt) {
          await saveStartupStatus({
            state: "timeout",
            message: "The overall startup deadline expired during discovery. No unload attempts were started."
          });
          return;
        }
        latest.context.allTabs.forEach(function (tab) { addCandidate(run, tab); });

        // Keep collecting created/restored tabs through the loading grace period.
        // Even when loading-tab protection is off, allow a short quiet period to
        // catch session-restored tabs created just after the first query.
        const configuredLoadingWaitMs = options && Number.isFinite(options.loadingWaitMs)
          ? options.loadingWaitMs
          : preferences.startupLoadingWaitSeconds * 1000;
        if (run.candidates.size && Date.now() < run.deadlineAt) {
          if (preferences.skipLoadingTabs) {
            run.loadingWaitExpired = !(await waitForLoadingCandidates(
              run, Math.min(configuredLoadingWaitMs, run.deadlineAt - Date.now()), preferences, true
            ));
          } else {
            await waitForLoadingCandidates(
              run, Math.min(configuredLoadingWaitMs, 2000, run.deadlineAt - Date.now()), preferences, false
            );
          }
        }
        if (run.cancelled) {
          await saveStartupStatus({ state: "cancelled", message: run.cancelReason + " No further tabs were attempted." });
          return;
        }

        if (Date.now() >= run.deadlineAt) {
          await saveStartupStatus({
            state: "timeout",
            message: "The overall startup deadline expired during session restoration. No unload attempts were started."
          });
          return;
        }
        const finalSnapshot = await startupContextStillCurrent(run);
        if (!finalSnapshot.ok) {
          await saveStartupStatus({ state: "cancelled", message: run.cancelReason + " No further tabs were attempted." });
          return;
        }
        if (finalSnapshot.context.unknownWorkspaceCount > 0) {
          await saveStartupStatus({
            state: "skipped",
            message: "Startup auto-unload stopped because " + finalSnapshot.context.unknownWorkspaceCount +
              " tab(s) have unknown workspace identity. No tabs were unloaded from this final snapshot."
          });
          return;
        }
        finalSnapshot.context.allTabs.forEach(function (tab) { addCandidate(run, tab); });

        const summary = await withOperationLock(async function () {
          const result = { state: "completed", unloaded: 0, skipped: 0, failed: 0, aborted: false, messages: [] };
          const processed = new Set();
          while (true) {
            const nextTabId = Array.from(run.candidates)
              .filter(function (id) { return !processed.has(id); })
              .sort(function (a, b) { return a - b; })[0];
            if (!Number.isInteger(nextTabId)) break;
            const tabId = nextTabId;
            processed.add(tabId);
            if (Date.now() >= run.deadlineAt) {
              result.state = "timeout";
              result.aborted = true;
              result.messages.push("The overall startup deadline was reached. Remaining tabs were not attempted.");
              break;
            }
            if (run.cancelled) {
              result.state = "cancelled";
              result.aborted = true;
              result.messages.push(run.cancelReason || "Workspace changed during startup.");
              break;
            }
            const before = await startupContextStillCurrent(run);
            if (!before.ok) {
              result.state = "cancelled";
              result.aborted = true;
              result.messages.push(run.cancelReason || "Workspace changed during startup.");
              break;
            }
            if (before.context.unknownWorkspaceCount > 0) {
              result.state = "aborted";
              result.aborted = true;
              result.messages.push("Workspace identity became ambiguous. Remaining tabs were not attempted.");
              break;
            }
            const outcome = await inspectAndDiscard(tabId, run.workspaceId, preferences, true, run, {
              deadlineAt: run.deadlineAt
            });
            if (outcome.state === "success") result.unloaded += 1;
            else if (outcome.state === "skipped") result.skipped += 1;
            else if (outcome.state === "failure") result.failed += 1;
            else {
              if (outcome.state === "uncertain") result.failed += 1;
              result.state = run.cancelled ? "cancelled" : "aborted";
              result.aborted = true;
              result.messages.push(outcome.message);
              break;
            }
            if (result.messages.length < 2 && outcome.message) result.messages.push(outcome.message);
          }
          run.collecting = false;
          return result;
        });

        const message = "Startup auto-unload " + (summary.state === "completed" ? "finished" : "stopped") +
          ": " + summary.unloaded + " unloaded, " + summary.skipped + " skipped, " + summary.failed + " failed." +
          (run.loadingWaitExpired ? " Some tabs were still loading when the wait limit expired and remained protected." : "") +
          (summary.aborted && summary.messages.length ? " " + summary.messages.join(" ") : "");
        await saveStartupStatus({
          state: summary.state,
          message: message,
          unloaded: summary.unloaded,
          skipped: summary.skipped,
          failed: summary.failed
        });
      } catch (error) {
        await saveStartupStatus({
          state: run.cancelled ? "cancelled" : (error && error.operationTimedOut ? "timeout" : "failed"),
          message: (run.cancelReason ? run.cancelReason + " " : "") + "Startup auto-unload ended safely: " + errText(error)
        });
      } finally {
        run.collecting = false;
        if (startupRun === run) startupRun = null;
      }
    }

    async function handleMessage(message) {
      if (!message || typeof message.type !== "string") return null;
      if (message.type === "UNLOAD_ONE") return unloadOneMessage(message);
      if (message.type === "UNLOAD_BATCH") return unloadBatchMessage(message);
      if (message.type === "GET_STARTUP_STATUS") {
        try {
          const stored = await api.storage.local.get("startupStatus");
          return { state: "status", startupStatus: stored.startupStatus || null };
        } catch (_error) {
          return { state: "status", startupStatus: null };
        }
      }
      return null;
    }

    function install() {
      if (api.runtime && api.runtime.onMessage && api.runtime.onMessage.addListener) {
        api.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
          if (!message || !["UNLOAD_ONE", "UNLOAD_BATCH", "GET_STARTUP_STATUS"].includes(message.type)) return false;
          Promise.resolve(handleMessage(message)).then(function (result) {
            sendResponse({ ok: true, result: result });
          }).catch(function (error) {
            sendResponse({ ok: false, error: errText(error) });
          });
          return true;
        });
      }
      if (api.runtime && api.runtime.onStartup && api.runtime.onStartup.addListener) {
        api.runtime.onStartup.addListener(function () { runStartupAutoUnload().catch(function () {}); });
      }
      if (api.storage && api.storage.onChanged && api.storage.onChanged.addListener) {
        api.storage.onChanged.addListener(function (changes, areaName) {
          if (areaName === "local" && changes.showStatusIndicator) {
            statusEnabled = changes.showStatusIndicator.newValue !== false;
            setActionStatus("idle", statusEnabled ? "Ready." : "Status indicator disabled.").catch(function () {});
          }
        });
      }
      if (api.commands && api.commands.onCommand && api.commands.onCommand.addListener) {
        api.commands.onCommand.addListener(function (command) {
          if (command !== "bulk-unload-review") return;
          Promise.resolve().then(async function () {
            await api.storage.local.set({
              bulkReviewRequest: { id: Date.now(), createdAt: Date.now() }
            });
            if (api.action && typeof api.action.openPopup === "function") {
              try {
                await api.action.openPopup();
              } catch (_error) {
                await setActionStatus("idle", "Bulk review is queued; click the extension icon if it did not open.");
              }
            } else {
              await setActionStatus("error", "This browser cannot open the popup from a shortcut. Click the extension icon to review.");
            }
          }).catch(function (error) {
            setActionStatus("error", "Could not open bulk review: " + errText(error)).catch(function () {});
          });
        });
      }
      setActionStatus("idle", "Ready.").catch(function () {});
      if (api.tabs && api.tabs.onActivated && api.tabs.onActivated.addListener) {
        api.tabs.onActivated.addListener(function (info) { onTabActivated(info).catch(function () {}); });
      }
      if (api.tabs && api.tabs.onCreated && api.tabs.onCreated.addListener) api.tabs.onCreated.addListener(onTabCreated);
      if (api.tabs && api.tabs.onUpdated && api.tabs.onUpdated.addListener) api.tabs.onUpdated.addListener(onTabUpdated);
      if (api.tabs && api.tabs.onRemoved && api.tabs.onRemoved.addListener) api.tabs.onRemoved.addListener(onTabRemoved);
      if (api.tabs && api.tabs.onReplaced && api.tabs.onReplaced.addListener) {
        api.tabs.onReplaced.addListener(function (addedId, removedId) {
          const run = startupRun;
          if (!run || run.cancelled || !run.candidates.has(removedId)) return;
          run.candidates.delete(removedId);
          if (run.collecting) {
            api.tabs.get(addedId).then(function (tab) { addCandidate(run, tab); }).catch(function () {});
          } else {
            run.candidates.add(addedId);
          }
          run.updateGeneration += 1;
          run.lastActivityAt = Date.now();
          if (run.phase === "waiting-load") wakeRun(run);
        });
      }
    }

    return {
      install: install,
      handleMessage: handleMessage,
      runStartupAutoUnload: runStartupAutoUnload,
      unloadOneMessage: unloadOneMessage,
      unloadBatchMessage: unloadBatchMessage,
      inspectAndDiscard: inspectAndDiscard,
      getStartupRun: function () { return startupRun; }
    };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { createController: createController };
  if (typeof chrome !== "undefined" && chrome.runtime && policy) createController(chrome, policy).install();
})(typeof self !== "undefined" ? self : globalThis);
