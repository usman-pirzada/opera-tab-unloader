# Opera GX Workspace Tab Unloader

A local-only Manifest V3 extension for inspecting tabs across Opera GX workspaces and unloading eligible tabs individually, in confirmed batches, or automatically at browser startup. Discarded tabs remain visible in the tab strip and are reloaded when activated.

## Features

- **Live tab counts:** the popup listens for tab creation, navigation/status updates, removal, replacement, and activation. Events are debounced; an explicit Refresh button remains available.
- **Stale-refresh protection:** overlapping snapshots cannot overwrite newer results. Refreshes defer while an unload operation is running.
- **Workspace previews:** workspaces are identified by Opera's `workspaceId`. Other workspaces remain read-only until made current in Opera GX.
- **Safe manual unload:** individual and confirmed bulk operations are coordinated by a background service worker, recheck the current workspace and policy, and serialize native discard operations.
- **Honest outcome handling:** the native discard result is used when it confirms success. Fallback verification distinguishes confirmed failure from an uncertain result; an uncertain result stops the rest of a batch.
- **Configurable loading-tab protection:** loading tabs are skipped by default. Turning off **Skip tabs that are currently loading** allows attempts only when the other metadata and URL checks pass; where available, `pendingUrl` is checked as the navigation target.
- **Optional startup auto-unload:** opt in through Preferences. The extension captures the workspace that is current at startup, waits a bounded period for session restoration/loading tabs, and applies the same safety checks. Switching to a different workspace cancels the run; it never retargets the batch to the new workspace.
- **Persistent status:** the popup displays the latest startup-auto-unload result. The extension does not store full URLs or page contents for diagnostics.
- No content scripts, website host permissions, remote code, external services, telemetry, analytics, or runtime dependencies.

> **State limitation:** Extension APIs cannot detect every unsaved state inside arbitrary websites. Discarding a page can lose state held only in page memory. Save important work before unloading tabs.

## Safety policy

The extension always skips:
- The active tab, already-discarded tabs, tabs whose critical metadata is unknown, and non-loading tabs whose status is not confirmed complete.
- Loading tabs by default; the user may disable that protection explicitly.
- Private-window tabs.
- Non-HTTP(S) pages such as browser-internal pages and URLs containing embedded credentials.
- Tabs without a verifiable workspace ID or tabs belonging to a different workspace.

By default, the extension also skips pinned tabs, audible tabs, and tabs marked non-auto-discardable. These three protections can be switched off in Preferences.

Bulk manual unloading requires confirmation. The background coordinator rechecks the reviewed candidate set before the operation and checks workspace identity and eligibility before every attempt. It stops when an outcome is uncertain or the active workspace changes. Startup auto-unload is disabled by default and uses a shared operation queue with manual actions.

Startup automation only targets tabs assigned to the workspace captured at startup. If the current workspace cannot be identified, if workspace identity becomes ambiguous, or if the workspace differs from the last observed identity, startup auto-unload fails closed. Loading tabs are allowed time to finish; after the bounded wait, tabs still loading remain protected when the loading-tab preference is ON. The operation does not switch workspaces.

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

- Confirm the popup counts update while tabs are created, loading, completed, removed, activated, and discarded.
- Confirm a burst of tab events does not leave a stale snapshot visible after newer data arrives.
- Test the Refresh button after startup and after changing workspaces.
- Test loading-tab protection ON and OFF, including a known HTTP(S) pending navigation and an internal pending URL.
- Test individual unloads and bulk operations where discard returns a discarded tab, returns no tab, rejects, or the tab disappears during verification.
- Confirm an uncertain result stops the batch and is not reported as a successful unload.
- Enable startup auto-unload; close and reopen Opera GX with a workspace containing several loading tabs.
- During startup restoration, switch to another workspace and confirm no further attempts are made against the old workspace and no attempts start in the new workspace during that run.
- Test a tab that remains loading past the wait limit and verify it remains protected while loading-tab protection is ON.
- Confirm auto-unload does not run by default and that its latest result is shown in the popup.
- Test pinned tabs, audible tabs, non-auto-discardable tabs, private windows, internal pages, already-discarded tabs, missing workspace IDs, and tabs with unsaved form state.

## Permissions

- `tabs`: read tab metadata, inspect workspace IDs, enumerate tabs, subscribe to tab lifecycle events, and request native discard.
- `storage`: save preferences, sorting, startup workspace consistency data, and a summary of the latest startup operation.

No website host permissions or content scripts are declared. Tab-supplied text is inserted using `textContent`, not interpreted as HTML.
