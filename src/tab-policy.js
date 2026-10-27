(function (root) {
  "use strict";

  const DEFAULT_PREFERENCES = Object.freeze({
    // Legacy unprefixed keys are the manual-operation profile.
    skipPinnedTabs: true,
    skipAudibleTabs: true,
    skipNonAutoDiscardableTabs: true,
    skipLoadingTabs: true,
    loadingUrlFallback: "skip",

    // Startup has an independent protection profile.
    startupSkipPinnedTabs: true,
    startupSkipAudibleTabs: true,
    startupSkipNonAutoDiscardableTabs: true,
    startupSkipLoadingTabs: true,
    startupLoadingUrlFallback: "skip",

    autoUnloadOnStartup: false,
    bulkUnloadMode: "adaptive",
    confirmBulkUnload: true,
    adaptiveBulkScanSeconds: 45,
    startupDiscoverySeconds: 90,
    startupLoadingWaitSeconds: 20,
    startupQuietPeriodSeconds: 2,
    overallDeadlineSeconds: 180,
    perTabTimeoutSeconds: 5,
    showStatusIndicator: true
  });

  const BOOLEAN_PREFERENCES = Object.freeze([
    "skipPinnedTabs",
    "skipAudibleTabs",
    "skipNonAutoDiscardableTabs",
    "skipLoadingTabs",
    "startupSkipPinnedTabs",
    "startupSkipAudibleTabs",
    "startupSkipNonAutoDiscardableTabs",
    "startupSkipLoadingTabs",
    "autoUnloadOnStartup",
    "confirmBulkUnload",
    "showStatusIndicator"
  ]);

  const INTEGER_PREFERENCE_RANGES = Object.freeze({
    adaptiveBulkScanSeconds: Object.freeze({ min: 5, max: 180 }),
    startupDiscoverySeconds: Object.freeze({ min: 10, max: 240 }),
    startupLoadingWaitSeconds: Object.freeze({ min: 0, max: 120 }),
    startupQuietPeriodSeconds: Object.freeze({ min: 1, max: 10 }),
    overallDeadlineSeconds: Object.freeze({ min: 30, max: 300 }),
    perTabTimeoutSeconds: Object.freeze({ min: 2, max: 30 })
  });

  const STARTUP_PROFILE_KEYS = Object.freeze([
    "startupSkipPinnedTabs",
    "startupSkipAudibleTabs",
    "startupSkipNonAutoDiscardableTabs",
    "startupSkipLoadingTabs",
    "startupLoadingUrlFallback"
  ]);

  function validatePreferences(value) {
    const input = value && typeof value === "object" ? value : {};
    const errors = [];
    BOOLEAN_PREFERENCES.forEach(function (key) {
      if (typeof input[key] !== "boolean") errors.push(key + " must be a boolean.");
    });
    Object.entries(INTEGER_PREFERENCE_RANGES).forEach(function (entry) {
      const key = entry[0];
      const range = entry[1];
      if (!Number.isInteger(input[key]) || input[key] < range.min || input[key] > range.max) {
        errors.push(key + " must be an integer between " + range.min + " and " + range.max + ".");
      }
    });
    if (input.loadingUrlFallback !== "skip" && input.loadingUrlFallback !== "lastCommitted") {
      errors.push("loadingUrlFallback must be skip or lastCommitted.");
    }
    if (input.startupLoadingUrlFallback !== "skip" && input.startupLoadingUrlFallback !== "lastCommitted") {
      errors.push("startupLoadingUrlFallback must be skip or lastCommitted.");
    }
    if (input.bulkUnloadMode !== "adaptive" && input.bulkUnloadMode !== "exact-review") {
      errors.push("bulkUnloadMode must be adaptive or exact-review.");
    }
    if (Number.isInteger(input.startupDiscoverySeconds) &&
        Number.isInteger(input.startupLoadingWaitSeconds) &&
        Number.isInteger(input.startupQuietPeriodSeconds) &&
        Number.isInteger(input.perTabTimeoutSeconds) &&
        Number.isInteger(input.overallDeadlineSeconds) &&
        input.startupDiscoverySeconds + input.startupLoadingWaitSeconds +
          input.startupQuietPeriodSeconds + input.perTabTimeoutSeconds > input.overallDeadlineSeconds) {
      errors.push("The startup monitoring window, loading grace period, quiet interval, and one tab attempt must fit within the overall deadline.");
    }
    if (Number.isInteger(input.adaptiveBulkScanSeconds) &&
        Number.isInteger(input.perTabTimeoutSeconds) &&
        Number.isInteger(input.overallDeadlineSeconds) &&
        input.adaptiveBulkScanSeconds + input.perTabTimeoutSeconds > input.overallDeadlineSeconds) {
      errors.push("The adaptive bulk scan window plus one tab attempt must fit within the overall deadline.");
    }
    if (Number.isInteger(input.perTabTimeoutSeconds) &&
        Number.isInteger(input.overallDeadlineSeconds) &&
        input.perTabTimeoutSeconds > input.overallDeadlineSeconds) {
      errors.push("Per-tab timeout must not exceed the overall deadline.");
    }
    return errors;
  }

  function normalizePreferences(value) {
    const input = value && typeof value === "object" ? value : {};
    const result = { ...DEFAULT_PREFERENCES };
    BOOLEAN_PREFERENCES.forEach(function (key) {
      if (typeof input[key] === "boolean") result[key] = input[key];
    });
    Object.entries(INTEGER_PREFERENCE_RANGES).forEach(function (entry) {
      const key = entry[0];
      const range = entry[1];
      if (Number.isInteger(input[key]) && input[key] >= range.min && input[key] <= range.max) {
        result[key] = input[key];
      }
    });
    if (input.loadingUrlFallback === "skip" || input.loadingUrlFallback === "lastCommitted") {
      result.loadingUrlFallback = input.loadingUrlFallback;
    }
    if (input.startupLoadingUrlFallback === "skip" || input.startupLoadingUrlFallback === "lastCommitted") {
      result.startupLoadingUrlFallback = input.startupLoadingUrlFallback;
    }
    if (input.bulkUnloadMode === "adaptive" || input.bulkUnloadMode === "exact-review") {
      result.bulkUnloadMode = input.bulkUnloadMode;
    }

    // Existing installations only have the old shared protection keys. On their
    // first upgrade, copy those values into the startup profile as well so the
    // change does not silently alter an existing user's startup policy. Once any
    // startup-specific key has been persisted, the profiles are independent.
    const hasStoredStartupProfile = STARTUP_PROFILE_KEYS.some(function (key) {
      return Object.prototype.hasOwnProperty.call(input, key);
    });
    if (!hasStoredStartupProfile) {
      result.startupSkipPinnedTabs = typeof input.skipPinnedTabs === "boolean"
        ? input.skipPinnedTabs : DEFAULT_PREFERENCES.startupSkipPinnedTabs;
      result.startupSkipAudibleTabs = typeof input.skipAudibleTabs === "boolean"
        ? input.skipAudibleTabs : DEFAULT_PREFERENCES.startupSkipAudibleTabs;
      result.startupSkipNonAutoDiscardableTabs = typeof input.skipNonAutoDiscardableTabs === "boolean"
        ? input.skipNonAutoDiscardableTabs : DEFAULT_PREFERENCES.startupSkipNonAutoDiscardableTabs;
      result.startupSkipLoadingTabs = typeof input.skipLoadingTabs === "boolean"
        ? input.skipLoadingTabs : DEFAULT_PREFERENCES.startupSkipLoadingTabs;
      result.startupLoadingUrlFallback =
        input.loadingUrlFallback === "skip" || input.loadingUrlFallback === "lastCommitted"
          ? input.loadingUrlFallback : DEFAULT_PREFERENCES.startupLoadingUrlFallback;
    }

    if (validatePreferences(result).length > 0) {
      result.adaptiveBulkScanSeconds = DEFAULT_PREFERENCES.adaptiveBulkScanSeconds;
      result.startupDiscoverySeconds = DEFAULT_PREFERENCES.startupDiscoverySeconds;
      result.startupLoadingWaitSeconds = DEFAULT_PREFERENCES.startupLoadingWaitSeconds;
      result.startupQuietPeriodSeconds = DEFAULT_PREFERENCES.startupQuietPeriodSeconds;
      result.overallDeadlineSeconds = DEFAULT_PREFERENCES.overallDeadlineSeconds;
      result.perTabTimeoutSeconds = DEFAULT_PREFERENCES.perTabTimeoutSeconds;
    }
    return result;
  }

  function getPolicyPreferences(value, profile) {
    const normalized = normalizePreferences(value);
    if (profile !== "startup") return normalized;
    return {
      ...normalized,
      skipPinnedTabs: normalized.startupSkipPinnedTabs,
      skipAudibleTabs: normalized.startupSkipAudibleTabs,
      skipNonAutoDiscardableTabs: normalized.startupSkipNonAutoDiscardableTabs,
      skipLoadingTabs: normalized.startupSkipLoadingTabs,
      loadingUrlFallback: normalized.startupLoadingUrlFallback
    };
  }

  function normalizeWorkspaceId(value) {
    if (typeof value !== "string" && typeof value !== "number") return null;
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    const normalized = String(value);
    return normalized.length > 0 ? normalized : null;
  }

  function getIneligibilityReasons(tab, targetWorkspaceId, preferences) {
    const reasons = [];
    const prefs = normalizePreferences(preferences);
    const expectedWorkspaceId = normalizeWorkspaceId(targetWorkspaceId);

    if (!tab || typeof tab !== "object") return ["The browser did not provide tab metadata."];
    if (!Number.isInteger(tab.id) || tab.id < 0) reasons.push("The browser did not provide a usable tab ID.");

    const actualWorkspaceId = normalizeWorkspaceId(tab.workspaceId);
    if (expectedWorkspaceId === null || actualWorkspaceId === null) {
      reasons.push("Workspace identity is missing or invalid.");
    } else if (actualWorkspaceId !== expectedWorkspaceId) {
      reasons.push("This tab belongs to a different workspace.");
    }

    if (tab.active === true) reasons.push("The tab is active in its window.");
    else if (tab.active !== false) reasons.push("The browser did not confirm that this tab is inactive.");

    if (tab.discarded === true) reasons.push("The tab is already discarded.");
    else if (tab.discarded !== false) reasons.push("The browser did not report the tab's discard state.");

    if (tab.status === "loading") {
      if (prefs.skipLoadingTabs !== false) {
        reasons.push("The tab is still loading. Turn off the loading-tab protection to allow unload attempts.");
      }
    } else if (tab.status !== "complete") {
      reasons.push("The browser did not confirm that the page has finished loading.");
    }

    if (prefs.skipPinnedTabs) {
      if (tab.pinned === true) reasons.push("Pinned tabs are protected by the current preference.");
      else if (tab.pinned !== false) reasons.push("The browser did not report the tab's pinned state.");
    }

    if (prefs.skipAudibleTabs) {
      if (tab.audible === true) reasons.push("The tab is currently audible.");
      else if (tab.audible !== false) reasons.push("The browser did not confirm the tab's audio state.");
    }

    if (prefs.skipNonAutoDiscardableTabs) {
      if (tab.autoDiscardable === false) reasons.push("The tab is marked non-auto-discardable.");
      else if (tab.autoDiscardable !== true) reasons.push("The browser did not confirm the tab's auto-discardable state.");
    }

    if (tab.incognito === true) reasons.push("Private-window tabs are protected.");
    else if (tab.incognito !== false) reasons.push("The browser did not confirm whether this tab is in a private window.");

    const loadingAttemptAllowed = tab.status === "loading" && prefs.skipLoadingTabs === false;
    const hasPendingUrl = typeof tab.pendingUrl === "string" && tab.pendingUrl.length > 0;
    const usePendingUrl = loadingAttemptAllowed && hasPendingUrl;
    let candidateUrl = usePendingUrl ? tab.pendingUrl : tab.url;
    if (loadingAttemptAllowed && !hasPendingUrl && prefs.loadingUrlFallback === "skip") {
      reasons.push("The pending navigation URL is unavailable; this tab is skipped by the current URL fallback preference.");
      candidateUrl = null;
    }
    if (typeof candidateUrl !== "string" || candidateUrl.length === 0) {
      if (!(loadingAttemptAllowed && !hasPendingUrl && prefs.loadingUrlFallback === "skip")) {
        reasons.push(usePendingUrl
          ? "The browser did not provide a navigation URL to classify safely."
          : "The browser did not provide a URL to classify safely.");
      }
    } else {
      try {
        const parsedUrl = new URL(candidateUrl);
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          reasons.push(usePendingUrl
            ? "The pending navigation is not an ordinary HTTP or HTTPS page."
            : "Only ordinary HTTP and HTTPS pages can be discarded by this extension.");
        }
        if (parsedUrl.username || parsedUrl.password) {
          reasons.push("URLs containing embedded credentials are protected.");
        }
      } catch (_error) {
        reasons.push("The tab URL is invalid or unavailable.");
      }
    }

    return reasons;
  }

  function evaluateTab(tab, targetWorkspaceId, preferences) {
    const reasons = getIneligibilityReasons(tab, targetWorkspaceId, preferences);
    return { eligible: reasons.length === 0, reasons };
  }

  function isSameWorkspace(targetWorkspaceId, currentWorkspaceId) {
    const targetId = normalizeWorkspaceId(targetWorkspaceId);
    const currentId = normalizeWorkspaceId(currentWorkspaceId);
    return targetId !== null && currentId !== null && targetId === currentId;
  }

  function sortEvaluatedTabs(items, mode) {
    const indexedItems = items.map((item, index) => ({
      item,
      originalIndex: Number.isInteger(item.index) ? item.index : index
    }));

    indexedItems.sort((a, b) => {
      const aEligible = a.item.evaluation && a.item.evaluation.eligible === true;
      const bEligible = b.item.evaluation && b.item.evaluation.eligible === true;

      if (mode === "eligible-first" && aEligible !== bEligible) {
        return aEligible ? -1 : 1;
      }
      if (mode === "eligible-last" && aEligible !== bEligible) {
        return aEligible ? 1 : -1;
      }
      return a.originalIndex - b.originalIndex;
    });

    return indexedItems.map((entry) => entry.item);
  }

  const api = {
    DEFAULT_PREFERENCES,
    BOOLEAN_PREFERENCES,
    INTEGER_PREFERENCE_RANGES,
    validatePreferences,
    normalizePreferences,
    getPolicyPreferences,
    normalizeWorkspaceId,
    getIneligibilityReasons,
    evaluateTab,
    isSameWorkspace,
    sortEvaluatedTabs
  };
  root.TabPolicy = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
