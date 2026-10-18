# Opera GX Workspace Tab Unloader

A small, local-only Manifest V3 extension for inspecting tabs across Opera GX workspaces and discarding eligible tabs individually or in bulk in the current workspace. A discarded tab stays in the tab strip and reloads when activated.

## Features

- **Clear workspace error state:** If workspace detection fails, the popup clears stale tab counts/actions, shows the underlying error, and exposes a retry control. It never leaves old unload controls visible beside an error.

- **Workspace selector with read-only previews:** The popup defaults to the current workspace. Other detected workspaces remain inspectable, with eligible/skipped tabs and counts visible, but all unload actions stay disabled until that workspace is made current in Opera GX.
- **Workspace-specific targeting:** Tabs are selected by Opera's `workspaceId`, not by window ID.
- **Immediate individual unloading:** Clicking **Unload tab** runs the safety preflight again and discards that tab without a separate confirmation.
- **Confirmed bulk unloading:** Review and confirm the batch. Every tab is checked again immediately before the discard attempt.
- **Configurable preferences:** Skip pinned tabs, audible tabs, and tabs marked `autoDiscardable: false`. Preference buttons show green ON and red OFF states.
- **Persistent sorting:** Choose **Eligible first**, **Eligible last**, or **Tab order**. The choice is saved locally and restored the next time the popup opens.
- **Conservative scope checks:** Tabs without a verifiable workspace identity are not guessed into a workspace. If any tab has unknown workspace identity, bulk unloading is blocked. Fresh preflight checks prevent unloading when the active workspace has changed.
- **Readable popup:** One overall scroll area, separated sections, larger typography, status above the tab list, and collapsible Preferences.
- No content scripts, website host permissions, remote code, external services, telemetry, analytics, or runtime dependencies.

> **State limitation:** Extension APIs cannot reliably detect every kind of unsaved state inside arbitrary websites. The preflight checks browser-visible metadata and conservative exclusions, but cannot guarantee that application state held only in a page's memory will be restored after discard. Save important work before discarding tabs.

## Safety policy

The extension always skips:
- The active tab, loading tabs, already-discarded tabs, and tabs whose critical metadata is unknown.
- Private-window tabs.
- Non-HTTP(S) pages such as browser-internal pages.
- URLs that contain embedded credentials.
- Tabs that do not belong to the selected workspace.

By default it also skips pinned tabs, audible tabs, and tabs marked non-auto-discardable; these three protections can be switched off in Preferences.

Individual unloads in the current workspace do not show a confirmation dialog, as requested, but revalidate workspace identity and tab eligibility immediately before calling `chrome.tabs.discard()`. Bulk unloads require confirmation, verify the target remains the active workspace, compare the eligible set against the reviewed set, and stop if an error makes the remaining operation uncertain. The extension verifies the browser-reported discard state and does not report success when that state cannot be confirmed.

Tabs in other workspaces are read-only previews. Changing the selector does not switch Opera GX's active workspace; switch in the browser itself before unloading those tabs. The stable build does not maintain diagnostic event logs or expose a diagnostics panel.

## Compatibility notes

Opera documents `workspaceId` and `workspaceName` on its Tabs API from Opera 77 onward. This project targets Opera GX, including its Flatpak distribution. Workspace IDs must be present and consistent in the exact installed GX build; when the active workspace cannot be identified, the extension refuses to guess based on window identity.

The extension runs inside the browser and does not require host OS integration. The Flatpak installation does not require copying files into Flatpak's internal directories.

## Install in Opera GX Flatpak on Linux

1. Download or clone this repository into a normal folder in your home directory.
2. Open `opera://extensions` in Opera GX.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the repository folder containing `manifest.json`.
5. Pin the extension to the toolbar and open it.

## Tests

Node.js 18 or later is required only for tests, not for the extension itself.

```bash
npm test
```

The suite checks JavaScript syntax and the pure tab eligibility/sorting policy. Automated tests do not replace live integration testing in Opera GX.

## Manual integration test checklist

- Verify workspace IDs are returned for tabs in all open browser windows.
- Create two GX workspaces and ensure the selector can inspect either without switching the browser's active workspace.
- Confirm non-current workspace counts and eligible/skipped tabs remain visible, while individual and bulk unload controls stay disabled even after preference changes or refreshes.
- Switch the browser to that workspace and reopen the popup; confirm unload controls become available only for the now-current workspace.
- Confirm opening the popup defaults the workspace selector to the current workspace.
- Confirm eligible-first, eligible-last and tab-order sorting persist when the popup is reopened.
- Test individual unload: a fresh preflight occurs and no confirmation is shown.
- Test bulk unload: confirmation appears, stale candidates or a changed active workspace abort safely, and each tab is rechecked immediately before discard.
- Confirm unload API rejection or failure to retrieve the final tab state produces an error/uncertain result rather than a false success.
- Test active tabs, pinned tabs, audible tabs, loading tabs, private windows, internal pages and already-discarded tabs.
- Test tabs being closed or moved between review and confirmation.
- Confirm discarded tabs remain visible and reload when activated.
- Test a website with unsaved form state and record actual behavior; generic extension APIs cannot guarantee protection for every web app.

## Permissions

- `tabs`: read tab metadata, inspect workspace IDs, enumerate tabs, and request native discard.
- `storage`: save local preferences and tab-sort order.

No website host permissions or content scripts are declared. Tab-supplied text is inserted using `textContent`, not interpreted as HTML.
