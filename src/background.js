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
    let startupScopeProbe = null;
    let startupAttempted = false;
    let startupSequence = 0;
    let unresolvedDiscard = null;
    let statusEnabled = true;
    let manualAdaptiveRun = null;

    function timeoutError(operation) {
      const error = new Error(operation + " exceeded its configured time budget.");
      error.operationTimedOut = true;
      return error;
    }

    function errText(error) {
      if (error instanceof Error && typeof error.message === "string" && error.message.trim()) {
        return error.message;
      }
      if (typeof error === "string" && error.trim()) return error;
      if (error === null || error === undefined) return "Unknown error.";
      try {
        const serialized = JSON.stringify(error);
        if (serialized && serialized !== "{}") return serialized;
      } catch (_error) {}
      try {
        return String(error);
      } catch (_error) {
        return "Unknown error.";
      }
    }

    function normalizeId(value) {
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
      if (typeof value === "string" && value.trim()) return value.trim();
      return null;
    }

    function sameWorkspace(targetWorkspaceId, currentWorkspaceId) {
      return Boolean(tabPolicy && typeof tabPolicy.isSameWorkspace === "function" &&
        tabPolicy.isSameWorkspace(targetWorkspaceId, currentWorkspaceId));
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

    function observeUnresolvedDiscard(promise, updateStatusOnSettle) {
      let tracked;
      tracked = Promise.resolve(promise).then(function () {}, function () {}).then(function () {
        if (unresolvedDiscard === tracked) {
          unresolvedDiscard = null;
          if (updateStatusOnSettle) {
            setActionStatus("error", "A timed-out bulk discard request has settled; review tab state before retrying.");
          }
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

    let actionState = "idle";
    let actionMessage = DEFAULT_OPERATION_STATUS.message;
    let actionGeneration = 0;
    let blinkTimer = null;
    let successClearTimer = null;
    let blinkVisible = true;

    async function renderActionIconFrame(iconState) {
      if (!api.action) return;
      const visibleState = statusEnabled ? iconState : "off";
      try {
        if (typeof OffscreenCanvas === "function" && typeof api.action.setIcon === "function") {
          const imageData = {};
          [16, 32, 48].forEach(function (size) {
            imageData[size] = drawStatusIcon(visibleState, size);
          });
          await api.action.setIcon({ imageData: imageData });
          if (typeof api.action.setBadgeText === "function") await api.action.setBadgeText({ text: "" });
        } else if (typeof api.action.setBadgeText === "function") {
          const showDot = statusEnabled && visibleState !== "off" && visibleState !== "idle";
          await api.action.setBadgeText({ text: showDot ? "●" : "" });
          if (typeof api.action.setBadgeBackgroundColor === "function") {
            await api.action.setBadgeBackgroundColor({
              color: STATUS_COLORS[visibleState] || STATUS_COLORS.idle
            });
          }
        }
      } catch (_error) {
        try {
          if (typeof api.action.setBadgeText === "function") {
            const showDot = statusEnabled && visibleState !== "off" && visibleState !== "idle";
            await api.action.setBadgeText({ text: showDot ? "●" : "" });
            if (typeof api.action.setBadgeBackgroundColor === "function") {
              await api.action.setBadgeBackgroundColor({ color: STATUS_COLORS[visibleState] || STATUS_COLORS.idle });
            }
          }
        } catch (_ignored) {}
      }
    }

    async function renderCurrentActionStatus() {
      if (actionState === "working") {
        await renderActionIconFrame(blinkVisible ? "working" : "off");
      } else {
        await renderActionIconFrame(actionState === "idle" ? "off" : actionState);
      }
      try {
        if (api.action && typeof api.action.setTitle === "function") {
          await api.action.setTitle({
            title: "Workspace Tab Unloader · " + (statusEnabled ? actionMessage : "Status indicator disabled")
          });
        }
      } catch (_error) {}
    }

    function stopStatusTimers() {
      if (blinkTimer !== null) {
        clearInterval(blinkTimer);
        blinkTimer = null;
      }
      if (successClearTimer !== null) {
        clearTimeout(successClearTimer);
        successClearTimer = null;
      }
    }

    function startBlinkingStatus() {
      if (blinkTimer !== null) return;
      blinkVisible = true;
      blinkTimer = setInterval(function () {
        if (actionState !== "working") return;
        blinkVisible = !blinkVisible;
        renderActionIconFrame(blinkVisible ? "working" : "off").catch(function () {});
      }, 650);
    }

    async function setActionStatus(state, message) {
      const normalizedState = Object.prototype.hasOwnProperty.call(STATUS_COLORS, state) ? state : "idle";
      stopStatusTimers();
      actionState = normalizedState;
      actionMessage = typeof message === "string" && message ? message : DEFAULT_OPERATION_STATUS.message;
      const generation = ++actionGeneration;
      try {
        const stored = await api.storage.local.get("showStatusIndicator");
        statusEnabled = stored.showStatusIndicator !== false;
      } catch (_error) {}

      if (normalizedState === "working") {
        startBlinkingStatus();
      }
      await renderCurrentActionStatus();

      const status = {
        state: normalizedState,
        message: actionMessage,
        time: new Date().toISOString()
      };
      try { await api.storage.local.set({ operationStatus: status }); } catch (_error) {}

      // A successful bulk operation leaves a visible green dot briefly. It then
      // returns to idle; opening the popup can clear it earlier. Errors persist.
      if (normalizedState === "success") {
        successClearTimer = setTimeout(function () {
          if (actionGeneration === generation && actionState === "success") {
            setActionStatus("idle", "Ready.").catch(function () {});
          }
        }, 6500);
      }
      return status;
    }

    function withOperationLock(task, settings) {
      const showStatus = Boolean(settings && settings.indicator);
      const operation = operationQueue.catch(function () {}).then(async function () {
        if (showStatus) await setActionStatus("working", "A bulk unload operation is running.");
        try {
          const result = await task();
          if (showStatus) {
            let state = "idle";
            const message = result && typeof result.message === "string" ? result.message : "Operation completed.";
            if (result && (result.failed > 0 || result.aborted === true ||
                ["aborted", "cancelled", "uncertain", "failure", "timeout", "failed", "review-changed"].includes(result.state))) {
              state = "error";
            } else if (result && Number.isInteger(result.unloaded) && result.unloaded > 0) {
              state = "success";
            }
            await setActionStatus(state, message);
          }
          return result;
        } catch (error) {
          if (showStatus) await setActionStatus("error", errText(error));
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

    async function saveStartupStatus(status, options) {
      const value = {
        time: new Date().toISOString(),
        state: status.state || "unknown",
        message: status.message || "",
        unloaded: Number.isInteger(status.unloaded) ? status.unloaded : 0,
        skipped: Number.isInteger(status.skipped) ? status.skipped : 0,
        failed: Number.isInteger(status.failed) ? status.failed : 0
      };
      try { await api.storage.local.set({ startupStatus: value }); } catch (_error) {}
      if (!options || options.updateActionIcon !== false) {
        if (value.state === "running") {
          await setActionStatus("working", value.message);
        } else if (["completed", "success"].includes(value.state)) {
          if (value.unloaded > 0 && value.failed === 0) {
            await setActionStatus("success", value.message || "Startup operation completed.");
          } else if (value.failed > 0) {
            await setActionStatus("error", value.message || "Startup operation ended with errors.");
          } else {
            await setActionStatus("idle", value.message || "Startup auto-unload finished with no tabs unloaded.");
          }
        } else if (["cancelled", "failed", "aborted", "timeout", "error"].includes(value.state)) {
          await setActionStatus("error", value.message || "Startup operation stopped.");
        } else if (value.state !== "disabled" && value.state !== "skipped") {
          await setActionStatus("idle", value.message || "Startup auto-unload did not run.");
        }
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

    function cancelRun(run, reason) {
      if (!run || run.cancelled) return;
      run.cancelled = true;
      run.cancelReason = reason || "The active workspace changed.";
      wakeRun(run);
    }

    function cancelStartupRun(run, reason) {
      cancelRun(run, reason);
    }

    function getActiveRuns() {
      return [startupRun, manualAdaptiveRun].filter(function (run) {
        return run && !run.cancelled;
      });
    }

    function signalRunActivity(run) {
      if (!run || run.cancelled) return;
      run.updateGeneration += 1;
      run.lastActivityAt = Date.now();
      if (run.phase === "monitoring" || run.phase === "waiting-load") wakeRun(run);
    }

    function addCandidate(run, tab) {
      if (!run || run.cancelled || !run.collecting || !tab || !Number.isInteger(tab.id)) return;
      if (sameWorkspace(tab.workspaceId, run.workspaceId)) run.candidates.add(tab.id);
    }

    function onTabCreated(tab) {
      getActiveRuns().forEach(function (run) {
        if (!run.collecting) return;
        const wasCandidate = run.candidates.has(tab && tab.id);
        addCandidate(run, tab);
        if (!wasCandidate && tab && run.candidates.has(tab.id)) signalRunActivity(run);
      });
    }

    function onTabUpdated(tabId, _changeInfo, tab) {
      getActiveRuns().forEach(function (run) {
        const wasCandidate = run.candidates.has(tabId);
        if (run.collecting) addCandidate(run, tab);
        if (wasCandidate || sameWorkspace(tab && tab.workspaceId, run.workspaceId)) {
          signalRunActivity(run);
        }
      });
    }

    function onTabRemoved(tabId) {
      getActiveRuns().forEach(function (run) {
        if (!run.candidates.has(tabId)) return;
        run.candidates.delete(tabId);
        signalRunActivity(run);
      });
    }

    async function onTabActivated(_activeInfo) {
      const runs = getActiveRuns();
      const probe = startupScopeProbe && !startupScopeProbe.cancelled ? startupScopeProbe : null;
      if (!runs.length && !probe) return;

      // Only the currently active tab in the last-focused window is authoritative.
      // Events observed before startup preferences finish loading are also checked,
      // but restoration events alone do not imply a switch.
      let currentWorkspaceId = null;
      try {
        currentWorkspaceId = (await getActiveContext()).currentWorkspaceId;
      } catch (_error) {
        if (probe) {
          probe.cancelled = true;
          probe.cancelReason = "The active workspace could not be verified while startup settings were loading.";
        }
        runs.forEach(function (run) {
          cancelRun(run, run.kind === "startup"
            ? "The active workspace could not be verified during startup auto-unload. Remaining tabs were not attempted."
            : "The active workspace could not be verified during adaptive bulk unloading. Remaining tabs were not attempted.");
        });
        return;
      }

      if (probe && (currentWorkspaceId === null || !sameWorkspace(currentWorkspaceId, probe.workspaceId))) {
        probe.cancelled = true;
        probe.cancelReason = currentWorkspaceId === null
          ? "The current workspace became unverifiable while startup settings were loading. Startup auto-unload was cancelled."
          : "Workspace changed while startup settings were loading. Startup auto-unload was cancelled and will not retarget.";
      }

      runs.forEach(function (run) {
        if (run.cancelled) return;
        if (currentWorkspaceId === null) {
          cancelRun(run, run.kind === "startup"
            ? "The current workspace became unverifiable during startup auto-unload. Remaining tabs were not attempted."
            : "The current workspace became unverifiable during adaptive bulk unloading. Remaining tabs were not attempted.");
        } else if (!sameWorkspace(currentWorkspaceId, run.workspaceId)) {
          cancelRun(run, run.kind === "startup"
            ? "Workspace changed during startup auto-unload. Remaining tabs were not attempted."
            : "Workspace changed during adaptive bulk unloading. Remaining tabs were not attempted.");
        } else {
          signalRunActivity(run);
        }
      });
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
        if (run) cancelRun(run, run.kind === "startup"
          ? "Workspace changed during startup auto-unload. Remaining tabs were not attempted."
          : "Workspace changed during adaptive bulk unloading. Remaining tabs were not attempted.");
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
        if (run) cancelRun(run, run.kind === "startup"
          ? "Workspace changed during startup auto-unload. Remaining tabs were not attempted."
          : "Workspace changed during adaptive bulk unloading. Remaining tabs were not attempted.");
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
          observeUnresolvedDiscard(discardPromise, Boolean(run || operationOptions.updateStatusOnUnresolved));
          return {
            state: "uncertain",
            message: "The unload request for “" + (tab.title || "Tab") +
              "” exceeded its time budget. Its outcome is uncertain; no further tabs were attempted.",
            attempted: true
          };
        }
        discardError = error;
      }

      if (discardResult && discardResult.discarded === true) {
        return { state: "success", message: "\"" + (tab.title || "Tab") + "\" was unloaded.", attempted: true };
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
        return { state: "success", message: "\"" + (after.title || tab.title || "Tab") + "\" was unloaded.", attempted: true };
      }
      if (after && after.discarded === false) {
        return {
          state: "failure",
          attempted: true,
          message: "\"" + (after.title || tab.title || "Tab") + "\" was not discarded." +
            (discardError ? " Opera GX rejected the request: " + errText(discardError) : "")
        };
      }
      return {
        state: "uncertain",
        attempted: true,
        message: "Unload outcome for \"" + (tab.title || "Tab") + "\" is uncertain; the final discard state was not reported."
      };
    }

    async function unloadOneMessage(message) {
      const requestStartedAt = Date.now();
      return withOperationLock(async function () {
        const loaded = await loadPreferences(message.preferences);
        return inspectAndDiscard(message.tabId, message.workspaceId, tabPolicy.getPolicyPreferences(loaded.preferences, "manual"), false, null, {
          deadlineAt: requestStartedAt + loaded.preferences.overallDeadlineSeconds * 1000
        });
      });
    }

    async function runAdaptiveScan(run, preferences, settings) {
      const prefs = tabPolicy.normalizePreferences(preferences);
      const hardDeadlineAt = run.deadlineAt;
      const monitoringStartedAt = run.startedAt;
      const configuredWindowMs = Math.max(0, settings.scanWindowMs);
      const discoveryEndAt = Math.min(hardDeadlineAt, monitoringStartedAt + configuredWindowMs);
      let monitoringEndAt = discoveryEndAt;
      let startupGraceResolved = run.kind !== "startup";
      let firstSnapshotProcessed = false;
      let finalContext = null;
      let finalContextError = null;
      const attemptedIds = new Set();
      const countedSkippedIds = new Set();
      const summary = {
        state: "completed",
        unloaded: 0,
        skipped: 0,
        failed: 0,
        aborted: false,
        remainingEligible: null,
        loadingProtectedRemaining: 0,
        messages: []
      };

      run.collecting = true;
      run.phase = "monitoring";

      while (!run.cancelled && Date.now() < hardDeadlineAt) {
        let context;
        try {
          context = await getWorkspaceContext(hardDeadlineAt);
        } catch (error) {
          summary.state = error && error.operationTimedOut ? "timeout" : "aborted";
          summary.aborted = true;
          summary.messages.push(error && error.operationTimedOut
            ? "The overall deadline was reached while refreshing the tab snapshot."
            : "Could not refresh tab state: " + errText(error));
          break;
        }

        if (context.currentWorkspaceId === null) {
          summary.state = "aborted";
          summary.aborted = true;
          summary.messages.push("The current workspace could not be verified. Remaining tabs were not attempted.");
          break;
        }
        if (!sameWorkspace(run.workspaceId, context.currentWorkspaceId)) {
          cancelRun(run, run.kind === "startup"
            ? "Workspace changed during startup auto-unload. Remaining tabs were not attempted."
            : "Workspace changed during adaptive bulk unloading. Remaining tabs were not attempted.");
          summary.state = "cancelled";
          summary.aborted = true;
          summary.messages.push(run.cancelReason);
          break;
        }
        if (context.unknownWorkspaceCount > 0) {
          summary.state = "aborted";
          summary.aborted = true;
          summary.messages.push("Tab workspace identity is ambiguous. Remaining tabs were not attempted.");
          break;
        }

        context.allTabs.forEach(function (tab) { addCandidate(run, tab); });

        // Startup watches the full configured restoration window while unloading
        // eligible tabs along the way. If protected tabs are still loading when
        // that window ends, extend monitoring by a bounded grace period.
        if (run.kind === "startup" && !startupGraceResolved && Date.now() >= discoveryEndAt) {
          startupGraceResolved = true;
          const protectedLoadingExists = context.allTabs.some(function (tab) {
            return sameWorkspace(tab.workspaceId, run.workspaceId) &&
              tab.status === "loading" && prefs.skipLoadingTabs === true;
          });
          if (protectedLoadingExists && settings.loadingGraceMs > 0) {
            monitoringEndAt = Math.min(hardDeadlineAt, discoveryEndAt + settings.loadingGraceMs);
          } else {
            monitoringEndAt = discoveryEndAt;
          }
        }

        // Always process one fresh snapshot, even if browser startup or a slow
        // workspace query consumed the monitoring window before the first scan.
        // Later scans still stop at the configured window/deadline.
        const isFirstSnapshot = !firstSnapshotProcessed;
        if (Date.now() >= monitoringEndAt && !isFirstSnapshot) break;

        const candidates = context.allTabs.filter(function (tab) {
          return Number.isInteger(tab.id) &&
            sameWorkspace(tab.workspaceId, run.workspaceId) &&
            !attemptedIds.has(tab.id) &&
            tabPolicy.evaluateTab(tab, run.workspaceId, prefs).eligible;
        }).sort(function (a, b) { return a.id - b.id; });

        let issuedAttemptThisCycle = false;
        for (const candidate of candidates) {
          if (run.cancelled) break;
          if (Date.now() >= hardDeadlineAt) {
            summary.state = "timeout";
            summary.aborted = true;
            summary.messages.push("The overall deadline was reached. Remaining tabs were not attempted.");
            break;
          }
          if (Date.now() >= monitoringEndAt && !isFirstSnapshot) break;

          const outcome = await inspectAndDiscard(
            candidate.id,
            run.workspaceId,
            prefs,
            true,
            run,
            { deadlineAt: hardDeadlineAt }
          );

          if (outcome.attempted === true) {
            attemptedIds.add(candidate.id);
            issuedAttemptThisCycle = true;
          }
          if (outcome.state === "success") {
            summary.unloaded += 1;
          } else if (outcome.state === "skipped") {
            if (!countedSkippedIds.has(candidate.id)) {
              countedSkippedIds.add(candidate.id);
              summary.skipped += 1;
            }
          } else if (outcome.state === "failure") {
            summary.failed += 1;
          } else {
            if (outcome.state === "uncertain") summary.failed += 1;
            summary.state = run.cancelled ? "cancelled" :
              (outcome.state === "timeout" ? "timeout" : "aborted");
            summary.aborted = true;
            summary.messages.push(outcome.message || "The operation stopped before the remaining tabs were attempted.");
            break;
          }
        }

        firstSnapshotProcessed = true;
        if (summary.aborted || run.cancelled || Date.now() >= hardDeadlineAt) break;
        if (issuedAttemptThisCycle) {
          // Immediately resnapshot after any real discard attempt. This admits
          // newly eligible tabs and never relies on a frozen candidate count.
          continue;
        }
        if (Date.now() >= monitoringEndAt) break;

        const generation = run.updateGeneration;
        const waitMs = Math.max(1, Math.min(
          prefs.startupQuietPeriodSeconds * 1000,
          monitoringEndAt - Date.now(),
          20000
        ));
        // Tab create/update/remove/replace events wake the scan early. If Opera
        // emits no event, the quiet interval performs another fresh snapshot.
        await waitForSignal(run, waitMs, generation);
      }

      if (run.cancelled && !summary.aborted) {
        summary.state = "cancelled";
        summary.aborted = true;
        summary.messages.push(run.cancelReason || "The current workspace changed. Remaining tabs were not attempted.");
      } else if (Date.now() >= hardDeadlineAt && !summary.aborted) {
        summary.state = "timeout";
        summary.aborted = true;
        summary.messages.push("The overall deadline was reached. No new unload attempts were started.");
      }

      run.collecting = false;
      run.phase = "finished";

      // Final reporting uses a new snapshot. The remaining count is informational:
      // it never triggers more work after the monitoring window has ended.
      if (Date.now() < hardDeadlineAt) {
        try {
          finalContext = await getWorkspaceContext(hardDeadlineAt);
          if (finalContext.currentWorkspaceId === null ||
              !sameWorkspace(run.workspaceId, finalContext.currentWorkspaceId)) {
            cancelRun(run, run.kind === "startup"
              ? "Workspace changed during startup auto-unload. Remaining tabs were not attempted."
              : "Workspace changed during adaptive bulk unloading. Remaining tabs were not attempted.");
            summary.state = "cancelled";
            summary.aborted = true;
            if (!summary.messages.includes(run.cancelReason)) summary.messages.push(run.cancelReason);
          } else if (finalContext.unknownWorkspaceCount > 0) {
            summary.remainingEligible = null;
            summary.state = summary.state === "completed" ? "aborted" : summary.state;
            summary.aborted = true;
            summary.messages.push("Could not count remaining eligible tabs because some tabs have unknown workspace identity.");
          } else {
            const workspaceTabs = finalContext.allTabs.filter(function (tab) {
              return sameWorkspace(tab.workspaceId, run.workspaceId);
            });
            summary.remainingEligible = workspaceTabs.filter(function (tab) {
              return tabPolicy.evaluateTab(tab, run.workspaceId, prefs).eligible;
            }).length;
            summary.loadingProtectedRemaining = workspaceTabs.filter(function (tab) {
              return prefs.skipLoadingTabs && tab.status === "loading";
            }).length;
          }
        } catch (error) {
          finalContextError = error;
        }
      }

      const pieces = [];
      pieces.push((run.kind === "startup" ? "Startup auto-unload" : "Adaptive bulk unload") +
        (summary.state === "completed" ? " finished: " : " stopped: ") +
        summary.unloaded + " unloaded.");
      if (Number.isInteger(summary.remainingEligible)) {
        if (summary.remainingEligible > 0) {
          pieces.push(summary.remainingEligible + " currently eligible tab" +
            (summary.remainingEligible === 1 ? " remains" : "s remain") +
            "; run “Unload all eligible tabs” again to try them.");
        } else if (summary.unloaded === 0) {
          pieces.push("No tabs were eligible at the end of this scan. Tabs still loading or protected by your settings are not included and may become eligible later.");
        } else {
          pieces.push("No tabs are eligible right now. Tabs still loading or protected by your settings may become eligible later.");
        }
      } else {
        pieces.push("The remaining eligible count could not be verified.");
      }
      if (summary.failed > 0) {
        pieces.push(summary.failed + " tab attempt(s) failed or had an uncertain outcome.");
      }
      if (summary.loadingProtectedRemaining > 0) {
        pieces.push(summary.loadingProtectedRemaining + " tab(s) are still loading and remain protected.");
      }
      if (summary.state === "timeout") {
        pieces.push("The hard overall deadline stopped further attempts.");
      }
      if (summary.aborted && summary.messages.length) {
        pieces.push(summary.messages.join(" "));
      } else if (finalContextError) {
        pieces.push("Final counts could not be refreshed: " + errText(finalContextError));
      }
      summary.message = pieces.join(" ");
      return summary;
    }

    async function unloadAdaptiveMessage(message) {
      const requestStartedAt = Date.now();
      return withOperationLock(async function () {
        const loaded = await loadPreferences(message.preferences);
        const allPreferences = loaded.preferences;
        const preferences = tabPolicy.getPolicyPreferences(allPreferences, "manual");
        const deadlineAt = requestStartedAt + allPreferences.overallDeadlineSeconds * 1000;
        const workspaceId = normalizeId(message.workspaceId);
        if (workspaceId === null) {
          return { state: "aborted", aborted: true, unloaded: 0, failed: 0, message: "The current workspace could not be verified. No tabs were unloaded." };
        }
        const run = {
          id: ++startupSequence,
          kind: "manual-adaptive",
          workspaceId: workspaceId,
          candidates: new Set(),
          collecting: true,
          phase: "monitoring",
          cancelled: false,
          cancelReason: "",
          updateGeneration: 0,
          wake: null,
          startedAt: requestStartedAt,
          lastActivityAt: Date.now(),
          deadlineAt: deadlineAt
        };
        manualAdaptiveRun = run;
        try {
          return await runAdaptiveScan(run, preferences, {
            scanWindowMs: options && Number.isFinite(options.adaptiveScanMs)
              ? options.adaptiveScanMs
              : allPreferences.adaptiveBulkScanSeconds * 1000,
            loadingGraceMs: 0
          });
        } finally {
          run.collecting = false;
          if (manualAdaptiveRun === run) manualAdaptiveRun = null;
        }
      }, { indicator: true });
    }

    async function unloadBatchMessage(message) {
      const requestStartedAt = Date.now();
      return withOperationLock(async function () {
        const loaded = await loadPreferences(message.preferences);
        const preferences = tabPolicy.getPolicyPreferences(loaded.preferences, "manual");
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
          const result = await inspectAndDiscard(tabId, message.workspaceId, preferences, true, null, {
            deadlineAt: deadlineAt,
            updateStatusOnUnresolved: true
          });
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
      }, { indicator: true });
    }

    async function runStartupAutoUnload() {
      if (startupAttempted) return;
      startupAttempted = true;
      const startupStartedAt = Date.now();
      const initializationDeadline = startupStartedAt + 10000;
      const preferencesPromise = awaitWithinDeadline(
        loadPreferences(), initializationDeadline, "loading startup settings"
      );

      let active = null;
      let activeError = null;
      try {
        // Capture the current workspace as early as possible. Once this baseline
        // is known, changes are watched while Settings storage is still loading.
        active = await awaitWithinDeadline(
          getActiveContext(), initializationDeadline, "reading the initial workspace"
        );
      } catch (error) {
        activeError = error;
      }

      const probe = active && active.currentWorkspaceId !== null ? {
        workspaceId: active.currentWorkspaceId,
        cancelled: false,
        cancelReason: ""
      } : null;
      if (probe) startupScopeProbe = probe;

      try {
        let loaded;
        try {
          loaded = await preferencesPromise;
        } catch (error) {
          await saveStartupStatus({
            state: error && error.operationTimedOut ? "timeout" : "failed",
            message: "Startup settings could not be read: " + errText(error)
          });
          return;
        }

        const allPreferences = loaded.preferences;
        if (!allPreferences.autoUnloadOnStartup) {
          await saveStartupStatus({
            state: "disabled",
            message: "Startup auto-unload is off. No tabs were unloaded."
          }, { updateActionIcon: false });
          return;
        }

        if (activeError) {
          await saveStartupStatus({
            state: activeError && activeError.operationTimedOut ? "timeout" : "failed",
            message: "Startup auto-unload could not establish the initial workspace: " + errText(activeError) + " No tabs were unloaded."
          });
          return;
        }
        if (!active || active.currentWorkspaceId === null || !probe) {
          await saveStartupStatus({
            state: "skipped",
            message: "Startup auto-unload skipped because Opera GX has not exposed a verifiable current workspace yet. No tabs were unloaded."
          }, { updateActionIcon: false });
          return;
        }

        const deadlineAt = startupStartedAt + allPreferences.overallDeadlineSeconds * 1000;
        if (probe.cancelled) {
          await saveStartupStatus({
            state: "cancelled",
            message: probe.cancelReason + " No tabs were unloaded."
          });
          return;
        }

        // Final initialization check closes the storage-read gap. If a switch
        // happened and then switched back, the probe remains cancelled.
        let verifiedActive;
        try {
          verifiedActive = await awaitWithinDeadline(
            getActiveContext(deadlineAt), deadlineAt, "confirming the startup workspace"
          );
        } catch (error) {
          await saveStartupStatus({
            state: error && error.operationTimedOut ? "timeout" : "failed",
            message: "Startup auto-unload could not recheck the initial workspace: " + errText(error) + " No tabs were unloaded."
          });
          return;
        }

        if (verifiedActive.currentWorkspaceId === null ||
            !sameWorkspace(verifiedActive.currentWorkspaceId, probe.workspaceId)) {
          probe.cancelled = true;
          probe.cancelReason = verifiedActive.currentWorkspaceId === null
            ? "The current workspace became unverifiable during startup initialization."
            : "Workspace changed during startup initialization. Startup auto-unload will not retarget.";
        }
        if (probe.cancelled) {
          await saveStartupStatus({
            state: "cancelled",
            message: probe.cancelReason + " No tabs were unloaded."
          });
          return;
        }

        const run = {
          id: ++startupSequence,
          kind: "startup",
          workspaceId: probe.workspaceId,
          candidates: new Set(),
          collecting: true,
          phase: "monitoring",
          cancelled: false,
          cancelReason: "",
          updateGeneration: 0,
          wake: null,
          startedAt: startupStartedAt,
          lastActivityAt: Date.now(),
          deadlineAt: deadlineAt
        };
        startupRun = run;
        const preferences = tabPolicy.getPolicyPreferences(allPreferences, "startup");

        try {
          await saveStartupStatus({
            state: "running",
            message: "Startup auto-unload is monitoring the workspace that was current at browser startup."
          });

          const summary = await withOperationLock(async function () {
            return runAdaptiveScan(run, preferences, {
              // These millisecond overrides are for deterministic tests only;
              // real browser behavior always uses the values shown in Settings.
              scanWindowMs: options && Number.isFinite(options.discoveryMs)
                ? options.discoveryMs
                : allPreferences.startupDiscoverySeconds * 1000,
              loadingGraceMs: options && Number.isFinite(options.loadingWaitMs)
                ? options.loadingWaitMs
                : allPreferences.startupLoadingWaitSeconds * 1000
            });
          }, { indicator: true });

          await saveStartupStatus({
            state: summary.state,
            message: summary.message,
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
      } finally {
        if (startupScopeProbe === probe) startupScopeProbe = null;
      }
    }

    async function handleMessage(message) {
      if (!message || typeof message.type !== "string") return null;
      if (message.type === "UNLOAD_ONE") return unloadOneMessage(message);
      if (message.type === "UNLOAD_BATCH") return unloadBatchMessage(message);
      if (message.type === "UNLOAD_ADAPTIVE") return unloadAdaptiveMessage(message);
      if (message.type === "POPUP_OPENED") {
        try {
          const stored = await api.storage.local.get("operationStatus");
          if (stored.operationStatus && stored.operationStatus.state === "success") {
            await setActionStatus("idle", "Ready.");
          }
        } catch (_error) {}
        return { state: "popup-opened" };
      }
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

    async function restoreActionStatus() {
      let stored = {};
      try {
        stored = await api.storage.local.get(["operationStatus", "showStatusIndicator"]);
      } catch (_error) {}
      statusEnabled = stored.showStatusIndicator !== false;
      const previous = stored.operationStatus;
      if (!previous || typeof previous.state !== "string") {
        await setActionStatus("idle", "Ready.");
        return;
      }
      if (previous.state === "error") {
        await setActionStatus("error", previous.message || "The previous bulk operation ended with an error.");
        return;
      }
      if (previous.state === "success") {
        const previousTime = Date.parse(previous.time || "");
        if (Number.isFinite(previousTime) && Date.now() - previousTime < 6500) {
          await setActionStatus("success", previous.message || "The last bulk operation succeeded.");
        } else {
          await setActionStatus("idle", "Ready.");
        }
        return;
      }
      if (previous.state === "working") {
        await setActionStatus("error", "A previous bulk operation did not record a final result. Check the popup before retrying.");
        return;
      }
      await setActionStatus("idle", "Ready.");
    }

    function install() {
      if (api.runtime && api.runtime.onMessage && api.runtime.onMessage.addListener) {
        api.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
          if (!message || !["UNLOAD_ONE", "UNLOAD_BATCH", "UNLOAD_ADAPTIVE", "POPUP_OPENED", "GET_STARTUP_STATUS"].includes(message.type)) return false;
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
            renderCurrentActionStatus().catch(function () {});
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
      restoreActionStatus().catch(function () {});
      if (api.tabs && api.tabs.onActivated && api.tabs.onActivated.addListener) {
        api.tabs.onActivated.addListener(function (info) { onTabActivated(info).catch(function () {}); });
      }
      if (api.tabs && api.tabs.onCreated && api.tabs.onCreated.addListener) api.tabs.onCreated.addListener(onTabCreated);
      if (api.tabs && api.tabs.onUpdated && api.tabs.onUpdated.addListener) api.tabs.onUpdated.addListener(onTabUpdated);
      if (api.tabs && api.tabs.onRemoved && api.tabs.onRemoved.addListener) api.tabs.onRemoved.addListener(onTabRemoved);
      if (api.tabs && api.tabs.onReplaced && api.tabs.onReplaced.addListener) {
        api.tabs.onReplaced.addListener(function (addedId, removedId) {
          getActiveRuns().forEach(function (run) {
            if (!run.candidates.has(removedId)) return;
            run.candidates.delete(removedId);
            if (run.collecting) {
              api.tabs.get(addedId).then(function (tab) {
                const wasCandidate = run.candidates.has(addedId);
                addCandidate(run, tab);
                if (!wasCandidate && run.candidates.has(addedId)) signalRunActivity(run);
              }).catch(function () {});
            }
            // Do not treat a replacement after collection has ended as a new candidate.
            signalRunActivity(run);
          });
        });
      }
    }

    return {
      install: install,
      handleMessage: handleMessage,
      runStartupAutoUnload: runStartupAutoUnload,
      unloadOneMessage: unloadOneMessage,
      unloadBatchMessage: unloadBatchMessage,
      unloadAdaptiveMessage: unloadAdaptiveMessage,
      inspectAndDiscard: inspectAndDiscard,
      getStartupRun: function () { return startupRun; }
    };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { createController: createController };
  if (typeof chrome !== "undefined" && chrome.runtime && policy) createController(chrome, policy).install();
})(typeof self !== "undefined" ? self : globalThis);
