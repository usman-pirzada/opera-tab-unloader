(function () {
  "use strict";

  const policy = window.TabPolicy;
  const $ = (selector) => document.querySelector(selector);
  const numericKeys = [
    "adaptiveBulkScanSeconds",
    "startupDiscoverySeconds",
    "startupLoadingWaitSeconds",
    "startupQuietPeriodSeconds",
    "overallDeadlineSeconds",
    "perTabTimeoutSeconds"
  ];
  const booleanKeys = [
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
  ];
  const sortModes = ["eligible-first", "eligible-last", "tab-order"];
  const ui = {
    form: $("#settings-form"),
    reset: $("#reset-button"),
    status: $("#settings-status"),
    validation: $("#validation-error"),
    loadingDialog: $("#loading-dialog"),
    loadingMessage: $("#loading-message"),
    dialog: $("#confirm-dialog"),
    confirmTitle: $("#confirm-title"),
    confirmMessage: $("#confirm-message"),
    confirmDetails: $("#confirm-details"),
    confirmCancel: $("#confirm-cancel"),
    confirmProceed: $("#confirm-proceed"),
    confirmIcon: $("#confirm-icon"),
    bulkUnloadMode: $("#bulkUnloadMode"),
    exactReviewWarning: $("#exact-review-warning"),
    navItems: Array.from(document.querySelectorAll(".nav-item"))
  };

  let savedPreferences = { ...policy.DEFAULT_PREFERENCES };
  let savedSortMode = "eligible-first";
  let saveTimer = null;
  let saving = false;
  let pendingSave = false;
  let focusAfterSave = null;
  let loadingDialogTimer = null;
  let confirmationResolver = null;

  function setStatus(message, state) {
    const statusState = state || "saved";
    ui.status.dataset.state = statusState;
    ui.status.classList.toggle("error-feedback", statusState === "error");
    ui.status.replaceChildren();
    if (statusState === "saving") {
      const spinner = document.createElement("span");
      spinner.className = "feedback-spinner";
      spinner.setAttribute("aria-hidden", "true");
      ui.status.appendChild(spinner);
    }
    ui.status.appendChild(document.createTextNode(message));
  }

  function showValidation(errors) {
    ui.validation.hidden = !errors.length;
    ui.validation.textContent = errors.join(" ");
    if (errors.length) {
      ui.status.dataset.state = "warning";
      ui.status.classList.add("error-feedback");
    } else {
      ui.status.classList.remove("error-feedback");
    }
  }

  function fillControls(preferences, sortMode) {
    booleanKeys.forEach((key) => { $("#" + key).checked = preferences[key] === true; });
    numericKeys.forEach((key) => { $("#" + key).value = String(preferences[key]); });
    $("#loadingUrlFallback").value = preferences.loadingUrlFallback;
    $("#startupLoadingUrlFallback").value = preferences.startupLoadingUrlFallback;
    $("#bulkUnloadMode").value = preferences.bulkUnloadMode;
    $("#tabSortMode").value = sortModes.includes(sortMode) ? sortMode : "eligible-first";
    updateModeExplanation();
  }

  function readControls() {
    const value = {};
    booleanKeys.forEach((key) => { value[key] = $("#" + key).checked; });
    numericKeys.forEach((key) => {
      const raw = $("#" + key).value.trim();
      value[key] = raw === "" ? Number.NaN : Number(raw);
    });
    value.loadingUrlFallback = $("#loadingUrlFallback").value;
    value.startupLoadingUrlFallback = $("#startupLoadingUrlFallback").value;
    value.bulkUnloadMode = $("#bulkUnloadMode").value;
    return value;
  }

  function updateModeExplanation() {
    ui.exactReviewWarning.hidden = $("#bulkUnloadMode").value !== "exact-review";
  }

  function setFormDisabled(disabled) {
    ui.form.querySelectorAll("input, select, button").forEach((control) => {
      control.disabled = Boolean(disabled);
    });
    ui.reset.disabled = Boolean(disabled);
  }

  function showLoadingDialogAfterDelay(message) {
    hideLoadingDialog();
    ui.loadingMessage.textContent = message;
    loadingDialogTimer = setTimeout(() => {
      loadingDialogTimer = null;
      if (!ui.loadingDialog.open) ui.loadingDialog.showModal();
    }, 180);
  }

  function hideLoadingDialog() {
    if (loadingDialogTimer !== null) {
      clearTimeout(loadingDialogTimer);
      loadingDialogTimer = null;
    }
    if (ui.loadingDialog.open) ui.loadingDialog.close();
  }

  function riskyChanges(next) {
    const reasons = [];
    [
      ["skipPinnedTabs", "Turning OFF manual pinned-tab protection may unload pages you deliberately pinned."],
      ["skipAudibleTabs", "Turning OFF manual audible-tab protection may interrupt audio or media."],
      ["skipNonAutoDiscardableTabs", "Turning OFF manual browser-protection respect may unload tabs the browser marked as protected."],
      ["startupSkipPinnedTabs", "Turning OFF startup pinned-tab protection may unload pinned pages automatically during startup."],
      ["startupSkipAudibleTabs", "Turning OFF startup audible-tab protection may interrupt media automatically during startup."],
      ["startupSkipNonAutoDiscardableTabs", "Turning OFF startup browser-protection respect may unload tabs the browser marked as protected."]
    ].forEach(([key, message]) => {
      if (savedPreferences[key] === true && next[key] === false) reasons.push(message);
    });
    if (savedPreferences.skipLoadingTabs === true && next.skipLoadingTabs === false) {
      reasons.push("Manual loading-tab protection will be disabled. A discard may interrupt navigation.");
    }
    if (savedPreferences.startupSkipLoadingTabs === true && next.startupSkipLoadingTabs === false) {
      reasons.push("Startup loading-tab protection will be disabled. Automatic unloading may interrupt in-progress navigation.");
    }
    if (savedPreferences.autoUnloadOnStartup === false && next.autoUnloadOnStartup === true) {
      reasons.push("Startup auto-unload will run automatically against the workspace captured at startup, stopping if the actual current workspace changes.");
    }
    if (savedPreferences.confirmBulkUnload === true && next.confirmBulkUnload === false) {
      reasons.push("Bulk unloading will start immediately on click without a confirmation step. Adaptive mode can unload tabs that become eligible during its scan window.");
    }
    if (savedPreferences.bulkUnloadMode === "adaptive" && next.bulkUnloadMode === "exact-review") {
      reasons.push("Exact list review is an advanced mode. It lets you review a fixed count and candidate list, but if loading state changes before confirmation the operation cancels instead of adapting. During browser startup this can be confusing because eligibility grows over time.");
    }
    if (savedPreferences.loadingUrlFallback === "skip" && next.loadingUrlFallback === "lastCommitted") {
      reasons.push("For manual unloading, if pendingUrl is missing, the last committed URL may refer to an older page rather than the in-progress destination.");
    }
    if (savedPreferences.startupLoadingUrlFallback === "skip" && next.startupLoadingUrlFallback === "lastCommitted") {
      reasons.push("For startup unloading, the last committed URL may refer to an older page rather than the in-progress destination.");
    }
    return reasons;
  }

  function askConfirmation({ title, message, details, confirmText, danger }) {
    ui.confirmTitle.textContent = title;
    ui.confirmMessage.textContent = message;
    ui.confirmProceed.textContent = confirmText || "Confirm";
    ui.confirmProceed.classList.toggle("danger-button", Boolean(danger));
    ui.confirmIcon.textContent = danger ? "!" : "?";
    ui.confirmDetails.replaceChildren();
    (details || []).forEach((detail) => {
      const item = document.createElement("li");
      item.textContent = detail;
      ui.confirmDetails.appendChild(item);
    });
    ui.confirmDetails.hidden = !(details && details.length);
    return new Promise((resolve) => {
      confirmationResolver = resolve;
      ui.dialog.showModal();
    });
  }

  function closeConfirmation(accepted) {
    if (ui.dialog.open) ui.dialog.close(accepted ? "confirm" : "cancel");
    const resolve = confirmationResolver;
    confirmationResolver = null;
    if (resolve) resolve(Boolean(accepted));
  }

  ui.confirmCancel.addEventListener("click", () => closeConfirmation(false));
  ui.confirmProceed.addEventListener("click", () => closeConfirmation(true));
  ui.dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeConfirmation(false);
  });

  async function persistSettings({ isReset = false } = {}) {
    if (saving) {
      pendingSave = true;
      return;
    }
    saving = true;
    document.body.classList.add("is-saving");
    setFormDisabled(true);
    try {
      do {
        pendingSave = false;
        const next = isReset ? { ...policy.DEFAULT_PREFERENCES } : readControls();
        const nextSortMode = isReset ? "eligible-first" : $("#tabSortMode").value;
        const errors = policy.validatePreferences(next);
        if (errors.length) {
          showValidation(errors);
          setStatus("Not saved. Correct the highlighted settings before trying again.", "warning");
          focusAfterSave = numericKeys.find((key) => !Number.isInteger(next[key])) || null;
          return;
        }
        if (next.bulkUnloadMode !== "adaptive" && next.bulkUnloadMode !== "exact-review") {
          showValidation(["Choose either Adaptive scanning or Exact list review."]);
          setStatus("Not saved. Choose a valid bulk unload mode.", "warning");
          return;
        }
        if (!sortModes.includes(nextSortMode)) {
          showValidation(["Choose a valid tab sorting mode."]);
          setStatus("Not saved. Choose a valid sorting mode.", "warning");
          return;
        }

        const warnings = isReset ? [] : riskyChanges(next);
        if (warnings.length) {
          setStatus("Waiting for confirmation…", "saving");
          const accepted = await askConfirmation({
            title: "Confirm safety-related changes",
            message: "These changes reduce one or more protections or enable automatic unloading.",
            details: warnings,
            confirmText: "Apply changes",
            danger: true
          });
          if (!accepted) {
            fillControls(savedPreferences, savedSortMode);
            showValidation([]);
            setStatus("Changes cancelled. Your previous settings remain active.", "saved");
            return;
          }
        }

        setStatus(isReset ? "Restoring recommended defaults…" : "Saving settings…", "saving");
        showLoadingDialogAfterDelay(isReset ? "Restoring recommended settings." : "Applying your settings.");
        try {
          await chrome.storage.local.set({ ...next, tabSortMode: nextSortMode });
          savedPreferences = { ...next };
          savedSortMode = nextSortMode;
          fillControls(savedPreferences, savedSortMode);
          showValidation([]);
          updateModeExplanation();
          setStatus(isReset
            ? "Recommended defaults restored and saved."
            : "Saved automatically. These settings are now active.", "saved");
        } catch (error) {
          setStatus("Could not save settings: " + (error && error.message ? error.message : "local storage is unavailable."), "error");
          return;
        }
      } while (pendingSave);
    } finally {
      hideLoadingDialog();
      saving = false;
      document.body.classList.remove("is-saving");
      setFormDisabled(false);
      if (focusAfterSave) {
        $("#" + focusAfterSave).focus();
        focusAfterSave = null;
      }
      if (pendingSave && !ui.validation.hidden) pendingSave = false;
    }
  }

  function queueSave(delay) {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistSettings().catch((error) => {
        setStatus("Settings could not be saved: " + (error && error.message ? error.message : "unknown error."), "error");
      });
    }, Math.max(0, delay));
  }

  function handleInput(event) {
    const target = event.target;
    if (!target || !target.id) return;
    showValidation([]);
    if (numericKeys.includes(target.id)) {
      queueSave(550);
    }
  }

  function handleChange(event) {
    const target = event.target;
    if (!target || (!booleanKeys.includes(target.id) &&
        !numericKeys.includes(target.id) &&
        !["loadingUrlFallback", "startupLoadingUrlFallback", "bulkUnloadMode", "tabSortMode"].includes(target.id))) return;
    showValidation([]);
    queueSave(numericKeys.includes(target.id) ? 250 : 80);
  }

  async function resetSettings() {
    if (saving) return;
    const accepted = await askConfirmation({
      title: "Reset to recommended defaults?",
      message: "This replaces every saved preference with the recommended default values.",
      details: [
        "Startup auto-unload will be OFF.",
        "Loading-tab protection will be ON.",
        "Missing pendingUrl behavior will be Skip this tab.",
        "Timing values and tab sorting will return to their recommended defaults."
      ],
      confirmText: "Reset settings",
      danger: true
    });
    if (!accepted) return;
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await persistSettings({ isReset: true });
  }

  async function init() {
    try {
      const stored = await chrome.storage.local.get([...Object.keys(policy.DEFAULT_PREFERENCES), "tabSortMode"]);
      savedPreferences = policy.normalizePreferences(stored);
      savedSortMode = sortModes.includes(stored.tabSortMode) ? stored.tabSortMode : "eligible-first";
      fillControls(savedPreferences, savedSortMode);
      showValidation([]);
      setStatus("Settings loaded. Changes save automatically.", "saved");
    } catch (error) {
      savedPreferences = { ...policy.DEFAULT_PREFERENCES };
      savedSortMode = "eligible-first";
      fillControls(savedPreferences, savedSortMode);
      setStatus("Could not read saved settings. Changes will not be saved until storage is available.", "error");
    }
  }

  ui.form.addEventListener("submit", (event) => event.preventDefault());
  ui.form.addEventListener("input", handleInput);
  ui.form.addEventListener("change", handleChange);
  ui.reset.addEventListener("click", () => resetSettings().catch((error) => {
    setStatus("Could not reset settings: " + (error && error.message ? error.message : "unknown error."), "error");
  }));

  function selectActiveNavigation(activeItem) {
    ui.navItems.forEach((item) => {
      const isActive = item === activeItem;
      item.classList.toggle("is-active", isActive);
      if (isActive) item.setAttribute("aria-current", "location");
      else item.removeAttribute("aria-current");
    });
  }

  function setupScrollNavigation() {
    const sectionMap = ui.navItems.map((item) => ({
      item: item,
      section: $(item.getAttribute("href"))
    })).filter((entry) => entry.section);
    let scheduled = false;
    const updateFromScroll = () => {
      scheduled = false;
      const marker = window.scrollY + Math.min(160, Math.max(90, window.innerHeight * 0.22));
      let active = sectionMap[0];
      for (const entry of sectionMap) {
        if (entry.section.getBoundingClientRect().top + window.scrollY <= marker) active = entry;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
        active = sectionMap[sectionMap.length - 1] || active;
      }
      if (active) selectActiveNavigation(active.item);
    };
    const scheduleUpdate = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(updateFromScroll);
    };
    ui.navItems.forEach((item) => {
      item.addEventListener("click", () => selectActiveNavigation(item));
    });
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate, { passive: true });
    updateFromScroll();
  }

  function initNavigationOnReady() {
    setupScrollNavigation();
  }

  initNavigationOnReady();
  init();
})();
