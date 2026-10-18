(function (root) {
  "use strict";
  if (typeof importScripts === "function" && !root.TabPolicy) importScripts("tab-policy.js");
  const policy = root.TabPolicy || (typeof require === "function" ? require("./tab-policy.js") : null);
  const PREF_KEYS = policy ? Object.keys(policy.DEFAULT_PREFERENCES) : [];
  const DEFAULT_DISCOVERY_MS = 8000;
  const DEFAULT_LOADING_WAIT_MS = 20000;

  function createController(api, tabPolicy, options) {
    const discoveryMs = options && Number.isFinite(options.discoveryMs) ? options.discoveryMs : DEFAULT_DISCOVERY_MS;
    const loadingWaitMs = options && Number.isFinite(options.loadingWaitMs) ? options.loadingWaitMs : DEFAULT_LOADING_WAIT_MS;
    let operationQueue = Promise.resolve();
    let startupRun = null;
    let startupAttempted = false;
    let startupSequence = 0;

    const normalizeId = (value) => tabPolicy.normalizeWorkspaceId(value);
    const sameWorkspace = (left, right) => tabPolicy.isSameWorkspace(left, right);
    const errText = (error) => error && typeof error.message === "string" && error.message
      ? error.message : "The browser returned an unknown API error.";

    function withOperationLock(task) {
      const operation = operationQueue.catch(function () {}).then(task);
      operationQueue = operation.catch(function () {});
      return operation;
    }

    async function loadPreferences(override) {
      let stored = {};
      try {
        stored = await api.storage.local.get(PREF_KEYS);
      } catch (_error) {}
      const preferences = { ...tabPolicy.DEFAULT_PREFERENCES };
      PREF_KEYS.forEach(function (key) {
        if (typeof stored[key] === "boolean") preferences[key] = stored[key];
      });
      if (override && typeof override === "object") {
        PREF_KEYS.forEach(function (key) {
          if (typeof override[key] === "boolean") preferences[key] = override[key];
        });
      }
      return { preferences: preferences, stored: stored };
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
      return value;
    }

    async function getActiveContext() {
      const activeTabs = await api.tabs.query({ active: true, lastFocusedWindow: true });
      const activeTab = activeTabs.find(function (tab) { return Number.isInteger(tab.id); }) || null;
      return {
        activeTab: activeTab,
        currentWorkspaceId: activeTab ? normalizeId(activeTab.workspaceId) : null
      };
    }

    async function getWorkspaceContext() {
      const active = await getActiveContext();
      const allTabs = await api.tabs.query({});
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

    async function onTabActivated(_activeInfo) {
      const run = startupRun;
      if (!run || run.cancelled) return;

      // Use the current tab in the last-focused window, not merely the tab ID
      // from this event. Activation events can also originate in another window.
      let currentWorkspaceId = null;
      try {
        currentWorkspaceId = (await getActiveContext()).currentWorkspaceId;
      } catch (_error) {}

      if (currentWorkspaceId === null) {
        cancelStartupRun(run, "The current workspace became unverifiable during startup auto-unload. Remaining tabs were not attempted.");
      } else if (!sameWorkspace(currentWorkspaceId, run.workspaceId)) {
        cancelStartupRun(run, "Workspace changed during startup auto-unload. Remaining tabs were not attempted.");
      } else {
        run.updateGeneration += 1;
        run.lastActivityAt = Date.now();
        if (run.phase === "waiting-load") wakeRun(run);
      }
    }

    async function inspectAndDiscard(tabId, targetWorkspaceId, preferences, requireCompleteMap, run) {
      if (run && run.cancelled) {
        return { state: "aborted", message: run.cancelReason || "Startup auto-unload was cancelled." };
      }

      let context;
      try { context = await getWorkspaceContext(); } catch (error) {
        return { state: "aborted", message: "Could not verify the active workspace: " + errText(error) };
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
      try { tab = await api.tabs.get(tabId); } catch (_error) {
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
      try { latestWorkspaceId = (await getActiveContext()).currentWorkspaceId; } catch (error) {
        return { state: "aborted", message: "Could not recheck workspace before unloading: " + errText(error) };
      }
      if (run && run.cancelled) {
        return { state: "aborted", message: run.cancelReason || "Startup auto-unload was cancelled." };
      }
      if (!sameWorkspace(targetWorkspaceId, latestWorkspaceId)) {
        if (run) cancelStartupRun(run, "Workspace changed during startup auto-unload. Remaining tabs were not attempted.");
        return { state: "aborted", message: "The active workspace changed immediately before unloading. Remaining tabs were not attempted." };
      }

      let discardResult;
      let discardError = null;
      try { discardResult = await api.tabs.discard(tabId); } catch (error) { discardError = error; }

      if (discardResult && discardResult.discarded === true) {
        return { state: "success", message: "\"" + (tab.title || "Tab") + "\" was unloaded." };
      }

      let after;
      try { after = await api.tabs.get(tabId); } catch (error) {
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
      return withOperationLock(async function () {
        const loaded = await loadPreferences(message.preferences);
        return inspectAndDiscard(message.tabId, message.workspaceId, loaded.preferences, false, null);
      });
    }

    async function unloadBatchMessage(message) {
      return withOperationLock(async function () {
        const loaded = await loadPreferences(message.preferences);
        const preferences = loaded.preferences;
        const ids = Array.from(new Set((Array.isArray(message.tabIds) ? message.tabIds : [])
          .filter(function (id) { return Number.isInteger(id) && id >= 0; }))).sort(function (a, b) { return a - b; });
        if (!ids.length) return { state: "aborted", message: "No reviewed tab IDs were supplied. Nothing was unloaded." };

        let context;
        try { context = await getWorkspaceContext(); } catch (error) {
          return { state: "aborted", message: "Could not verify workspace before bulk unloading: " + errText(error) };
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
          const result = await inspectAndDiscard(tabId, message.workspaceId, preferences, true, null);
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
      const context = await getWorkspaceContext();
      if (run.cancelled) return { ok: false, context: context };
      if (!sameWorkspace(run.workspaceId, context.currentWorkspaceId)) {
        cancelStartupRun(run, "Workspace changed during startup auto-unload. Tabs in the old workspace will not be attempted further.");
        return { ok: false, context: context };
      }
      return { ok: true, context: context };
    }

    async function waitForLoadingCandidates(run, timeoutMs, preferences, waitForLoads) {
      const deadline = Date.now() + timeoutMs;
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
              const tab = await api.tabs.get(tabId);
              const couldBecomeEligible = tabPolicy.evaluateTab(
                tab, run.workspaceId, readinessPreferences
              ).eligible;
              if (sameWorkspace(tab.workspaceId, run.workspaceId) &&
                  tab.status === "loading" && couldBecomeEligible) {
                loadingFound = true;
                break;
              }
            } catch (_error) {
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
      // Start reading the active workspace immediately, before storage latency can
      // delay the startup scope snapshot.
      const activePromise = getActiveContext().then(function (value) {
        return { active: value, error: null };
      }).catch(function (error) {
        return { active: null, error: error };
      });
      const loaded = await loadPreferences();
      const preferences = loaded.preferences;
      if (!preferences.autoUnloadOnStartup) return;

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
        startedAt: Date.now(),
        lastActivityAt: Date.now()
      };
      startupRun = run;

      try {
        await saveStartupStatus({
          state: "running",
          message: "Startup auto-unload is checking tabs in the workspace that was current at startup."
        });

        try {
          (await api.tabs.query({})).forEach(function (tab) { addCandidate(run, tab); });
        } catch (error) {
          await saveStartupStatus({ state: "failed", message: "Startup auto-unload could not enumerate tabs: " + errText(error) });
          return;
        }

        // Include tabs that Opera restores shortly after the startup event.
        // Workspace activation events cancel this run rather than retargeting it.
        await waitForSignal(run, discoveryMs);
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

        latest.context.allTabs.forEach(function (tab) { addCandidate(run, tab); });

        // Keep collecting created/restored tabs through the loading grace period.
        // Even when loading-tab protection is off, allow a short quiet period to
        // catch session-restored tabs created just after the first query.
        if (run.candidates.size) {
          if (preferences.skipLoadingTabs) {
            run.loadingWaitExpired = !(await waitForLoadingCandidates(run, loadingWaitMs, preferences, true));
          } else {
            await waitForLoadingCandidates(run, Math.min(loadingWaitMs, 2000), preferences, false);
          }
        }
        if (run.cancelled) {
          await saveStartupStatus({ state: "cancelled", message: run.cancelReason + " No further tabs were attempted." });
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
            const outcome = await inspectAndDiscard(tabId, run.workspaceId, preferences, true, run);
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
          state: run.cancelled ? "cancelled" : "failed",
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
