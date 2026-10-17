(function (root) {
  "use strict";

  const DEFAULT_PREFERENCES = Object.freeze({
    skipPinnedTabs: true,
    skipAudibleTabs: true,
    skipNonAutoDiscardableTabs: true
  });

  function normalizeWorkspaceId(value) {
    if (typeof value !== "string" && typeof value !== "number") return null;
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    const normalized = String(value);
    return normalized.length > 0 ? normalized : null;
  }

  function getIneligibilityReasons(tab, targetWorkspaceId, preferences) {
    const reasons = [];
    const prefs = { ...DEFAULT_PREFERENCES, ...(preferences || {}) };
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

    if (tab.status !== "complete") {
      reasons.push(tab.status === "loading"
        ? "The tab is still loading."
        : "The browser did not confirm that the page has finished loading.");
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

    if (typeof tab.url !== "string" || tab.url.length === 0) {
      reasons.push("The browser did not provide a URL to classify safely.");
    } else {
      try {
        const parsedUrl = new URL(tab.url);
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          reasons.push("Only ordinary HTTP and HTTPS pages can be discarded by this extension.");
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

  const api = { DEFAULT_PREFERENCES, normalizeWorkspaceId, getIneligibilityReasons, evaluateTab };
  root.TabPolicy = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
