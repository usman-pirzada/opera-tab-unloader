(function () {
  "use strict";
  const policy = window.TabPolicy;
  const $ = (selector) => document.querySelector(selector);
  const numericKeys = ["startupDiscoverySeconds", "startupLoadingWaitSeconds", "overallDeadlineSeconds", "perTabTimeoutSeconds"];
  const booleanKeys = ["skipPinnedTabs", "skipAudibleTabs", "skipNonAutoDiscardableTabs", "skipLoadingTabs", "autoUnloadOnStartup", "showStatusIndicator"];
  const sortModes = ["eligible-first", "eligible-last", "tab-order"];
  const ui = { form: $("#settings-form"), reset: $("#reset-button"), resetBottom: $("#reset-bottom-button"), status: $("#settings-status"), validation: $("#validation-error") };
  let savedPreferences = { ...policy.DEFAULT_PREFERENCES };
  let savedSortMode = "eligible-first";
  function setStatus(message, isError) {
    ui.status.textContent = message;
    ui.status.classList.toggle("error-feedback", Boolean(isError));
  }
  function showValidation(errors) {
    ui.validation.hidden = !errors.length;
    ui.validation.textContent = errors.join(" ");
  }
  function fillControls(preferences, sortMode) {
    booleanKeys.forEach((key) => { $("#" + key).checked = preferences[key] === true; });
    numericKeys.forEach((key) => { $("#" + key).value = String(preferences[key]); });
    $("#loadingUrlFallback").value = preferences.loadingUrlFallback;
    $("#tabSortMode").value = sortModes.includes(sortMode) ? sortMode : "eligible-first";
  }
  function readControls() {
    const value = {};
    booleanKeys.forEach((key) => { value[key] = $("#" + key).checked; });
    numericKeys.forEach((key) => {
      const raw = $("#" + key).value.trim();
      value[key] = raw === "" ? Number.NaN : Number(raw);
    });
    value.loadingUrlFallback = $("#loadingUrlFallback").value;
    return value;
  }
  function riskyChanges(next) {
    const reasons = [];
    [
      ["skipPinnedTabs", "Turning OFF pinned-tab protection may unload tabs you intentionally kept pinned."],
      ["skipAudibleTabs", "Turning OFF audible-tab protection may interrupt audio or media."],
      ["skipNonAutoDiscardableTabs", "Turning OFF browser auto-discard protection may override the browser's own caution flag."]
    ].forEach(([key, message]) => { if (savedPreferences[key] === true && next[key] === false) reasons.push(message); });
    if (savedPreferences.skipLoadingTabs === true && next.skipLoadingTabs === false) reasons.push("Loading-tab protection will be disabled. A discard may interrupt an in-progress navigation.");
    if (savedPreferences.autoUnloadOnStartup === false && next.autoUnloadOnStartup === true) reasons.push("Startup auto-unload will run automatically. It uses the workspace current at startup and cancels if you switch away.");
    if (savedPreferences.loadingUrlFallback === "skip" && next.loadingUrlFallback === "lastCommitted") reasons.push("If pendingUrl is missing, a previous committed URL may not match the navigation currently in progress.");
    return reasons;
  }
  async function saveSettings(event) {
    if (event) event.preventDefault();
    showValidation([]);
    const next = readControls();
    const errors = policy.validatePreferences(next);
    if (errors.length) {
      showValidation(errors);
      setStatus("Settings were not saved. Correct the invalid values and try again.", true);
      const firstInvalid = numericKeys.find((key) => !Number.isInteger(next[key]));
      if (firstInvalid) $("#" + firstInvalid).focus();
      return;
    }
    const nextSortMode = $("#tabSortMode").value;
    if (!sortModes.includes(nextSortMode)) {
      showValidation(["Choose a valid tab sorting mode."]);
      setStatus("Settings were not saved.", true);
      return;
    }
    const warnings = riskyChanges(next);
    if (warnings.length && !window.confirm(
      "These changes reduce protection or enable automatic unloading:\n\n" +
      warnings.map((message) => "• " + message).join("\n") + "\n\nSave these changes?"
    )) {
      fillControls(savedPreferences, savedSortMode);
      setStatus("No changes were saved. Existing settings remain active.");
      return;
    }
    try {
      await chrome.storage.local.set({ ...next, tabSortMode: nextSortMode });
      savedPreferences = { ...next };
      savedSortMode = nextSortMode;
      setStatus("Settings saved. The popup and background coordinator will use the new values.");
    } catch (error) {
      setStatus("Could not save settings: " + (error && error.message ? error.message : "storage is unavailable."), true);
    }
  }
  async function resetSettings() {
    const defaults = { ...policy.DEFAULT_PREFERENCES };
    if (!window.confirm(
      "Reset every extension setting to its recommended default?\n\nStartup auto-unload will be OFF, loading-tab protection will be ON, the missing-pending-URL policy will skip the tab, and tab sorting will return to Eligible first."
    )) return;
    try {
      await chrome.storage.local.set({ ...defaults, tabSortMode: "eligible-first" });
      savedPreferences = defaults;
      savedSortMode = "eligible-first";
      fillControls(savedPreferences, savedSortMode);
      showValidation([]);
      setStatus("All settings were reset to their recommended defaults.");
    } catch (error) {
      setStatus("Could not reset settings: " + (error && error.message ? error.message : "storage is unavailable."), true);
    }
  }
  async function init() {
    try {
      const stored = await chrome.storage.local.get([...Object.keys(policy.DEFAULT_PREFERENCES), "tabSortMode"]);
      savedPreferences = policy.normalizePreferences(stored);
      savedSortMode = sortModes.includes(stored.tabSortMode) ? stored.tabSortMode : "eligible-first";
      fillControls(savedPreferences, savedSortMode);
      setStatus("Loaded saved settings. Recommended defaults are shown next to each option.");
    } catch (error) {
      savedPreferences = { ...policy.DEFAULT_PREFERENCES };
      savedSortMode = "eligible-first";
      fillControls(savedPreferences, savedSortMode);
      setStatus("Could not read saved settings. Defaults are displayed but have not been written: " +
        (error && error.message ? error.message : "storage is unavailable."), true);
    }
  }
  ui.form.addEventListener("submit", saveSettings);
  ui.reset.addEventListener("click", resetSettings);
  ui.resetBottom.addEventListener("click", resetSettings);
  ui.form.addEventListener("input", () => showValidation([]));
  init();
})();
