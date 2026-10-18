# Opera GX Workspace Tab Unloader

A local-only Manifest V3 extension for inspecting tabs across Opera GX workspaces and unloading eligible tabs individually, with adaptive bulk scans and optional startup auto-unload. Discarded tabs remain visible in the tab strip and are reloaded when activated.

## Features

- **Live tab counts:** the popup listens for tab creation, navigation/status updates, removal, replacement, and activation. Events are debounced; the header Refresh button spins and switches the cursor to a busy indicator during a manual refresh.
- **Stale-refresh protection:** overlapping snapshots cannot overwrite newer results. Refreshes defer while an unload operation is running.
- **Workspace previews:** workspaces are identified by Opera's `workspaceId`. Other workspaces remain read-only until made current in Opera GX.
- **Safe manual unload:** individual unloads use the manual protection profile. Adaptive bulk mode repeatedly refreshes the current workspace throughout a bounded scan window, unloading newly eligible tabs without relying on a frozen count. Advanced exact-review mode keeps the fixed-list behavior. Bulk confirmation is configurable.
- **Honest outcome handling:** the native discard result is used when it confirms success. Fallback verification distinguishes confirmed failure from an uncertain result; an uncertain result stops the rest of a batch.
- **Separate protection profiles:** manual unloading and startup auto-unload have independent pinned, audible, non-auto-discardable, and loading-tab protections. Existing shared settings are migrated to both profiles on upgrade. Missing pending URLs default to skipping the tab in both profiles.
- **Dedicated Settings page:** configure all preferences with automatic saving, recommended defaults, numeric validation, custom confirmation dialogs for safety-reducing changes, and reset to defaults.
- **Timing limits:** startup monitoring (default 90 seconds), extra startup grace for loading tabs (20 seconds), empty-scan interval (2 seconds), manual adaptive scan window (45 seconds), per-tab budget (5 seconds), and hard overall deadline (180 seconds) are configurable in Settings. The overall deadline applies to startup and manual operations. A timed-out discard is treated as uncertain and blocks further attempts until it settles.
- **Optional startup auto-unload:** opt in through Settings. The extension captures a verifiable startup workspace, repeatedly unloads newly eligible tabs throughout the monitoring window, and cancels when the actual current workspace is observed to change.
- **Toolbar status indicator:** no dot while idle, blinking blue during bulk/startup work, green briefly after success, and red retained after an error/cancellation. Opening the popup clears green immediately. Individual tab unloads never change the dot. The status dot is drawn only on the toolbar action icon; the Options tab's favicon uses a plain icon.
- **Keyboard bulk unload:** use `Ctrl+Shift+U` (suggested default) to open the popup and start the selected bulk mode. Confirmation is controlled by Settings. Change the shortcut in Opera's extension-shortcuts page.
- No content scripts, website host permissions, remote code, external services, telemetry, analytics, or runtime dependencies.

> **State limitation:** Extension APIs cannot detect every unsaved state inside arbitrary websites. Discarding a page can lose state held only in page memory. Save important work before unloading tabs.

## Safety policy

The extension always skips:
- The active tab, already-discarded tabs, tabs whose critical metadata is unknown, and non-loading tabs whose status is not confirmed complete.
- Loading tabs by default; the user may disable that protection explicitly.
- Private-window tabs.
- Non-HTTP(S) pages such as browser-internal pages and URLs containing embedded credentials.
- Tabs without a verifiable workspace ID or tabs belonging to a different workspace.

By default, the extension also skips pinned tabs, audible tabs, and tabs marked non-auto-discardable. The full Settings page explains these preferences and asks for confirmation before disabling protections. When loading-tab protection is OFF, tabs with no pending URL are still skipped by default; the advanced last-committed-URL fallback is explicitly warned about.

Bulk confirmation is controlled by Settings. Adaptive mode is the default: it unloads tabs eligible now, then keeps taking fresh snapshots during the configured scan window so tabs that become eligible later can also be unloaded. It reports how many were unloaded and how many remain eligible for another attempt. Exact list review is an advanced mode that keeps a fixed candidate set and cancels if that list changes. Both modes recheck workspace identity and eligibility immediately before each attempt. Each operation has a hard deadline and each tab has a bounded time budget. If a native discard request times out, its outcome is uncertain and later unload attempts remain blocked until that request settles. Startup auto-unload is disabled by default and uses the same serialized operation queue as manual actions.

Startup automation only targets tabs assigned to the workspace captured at startup. If the current workspace cannot be identified, if workspace identity becomes ambiguous, or if the workspace differs from the last observed identity, startup auto-unload fails closed. Loading tabs are allowed time to finish; after the bounded wait, tabs still loading remain protected when the loading-tab preference is ON. Startup monitoring, loading grace, and the interval between empty scans are configurable and share the overall operation deadline. The operation does not switch workspaces. If the service worker is terminated, the in-memory run may end early; the extension must not resume an old run against a different workspace.

## Compatibility notes

Opera exposes `workspaceId` and `workspaceName` on its Tabs API from Opera 77 onward. Workspace IDs must be present and consistent in the exact installed GX build; if the active workspace cannot be identified, the extension refuses to guess from window identity.

The extension runs inside the browser and does not require host OS integration. The Flatpak installation does not require copying files into Flatpak's internal directories.

## Install in Opera GX Flatpak on Linux

1. Download or clone this repository into a normal folder in your home directory.
2. Open `opera://extensions` in Opera GX.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the repository folder containing `manifest.json`.
5. Pin the extension to the toolbar and open it.

## Tests

Node.js 18 or later is required for automated tests, not for using the extension.

```bash
npm test
```

The suite checks policy rules and mocked asynchronous background operations. These tests do not replace manual integration testing in the installed Opera GX build.

## Manual integration test checklist

- Confirm Adaptive mode keeps its confirmation open when eligibility changes, updates the count during a running scan, and stops permanently if the actual active workspace changes.
- Confirm a burst of tab events does not leave a stale snapshot visible after newer data arrives.
- Test the Refresh button after startup and after changing workspaces.
- Test loading-tab protection ON and OFF, including a known HTTP(S) pending navigation, an internal pending URL, and a missing pending URL under each fallback policy.
- Test invalid, decimal, out-of-range, and cross-setting-incompatible timing values. Confirm they are rejected without saving.
- Confirm risky setting changes require confirmation and Reset to defaults restores the documented values.
- Test the keyboard shortcut starts the selected bulk mode and respects the confirmation preference.
- Confirm the status dot is absent while idle, blinks blue during bulk/startup operations, stays green briefly after success (or disappears when the popup opens), stays red after errors until the next bulk operation, and is unchanged by individual tab unloads.
- Test individual unloads and bulk operations where discard returns a discarded tab, returns no tab, rejects, or the tab disappears during verification.
- Confirm an uncertain result stops the batch and is not reported as a successful unload.
- Enable startup auto-unload; close and reopen Opera GX with a workspace containing several loading tabs.
- During startup restoration, switch to another workspace and confirm no further attempts are made against the old workspace and no attempts start in the new workspace during that run.
- Test a tab that remains loading past the wait limit and verify it remains protected while loading-tab protection is ON.
- Confirm auto-unload does not run by default and that its latest result is shown in the popup.
- Test pinned tabs, audible tabs, non-auto-discardable tabs, private windows, internal pages, already-discarded tabs, missing workspace IDs, and tabs with unsaved form state.

## Permissions

- `tabs`: read tab metadata, inspect workspace IDs, enumerate tabs, subscribe to tab lifecycle events, and request native discard.
- `storage`: save preferences, sorting, shortcut review requests, and a summary of the latest startup operation.

No website host permissions or content scripts are declared. Settings are stored locally. Tab-supplied text is inserted using `textContent`, not interpreted as HTML.
