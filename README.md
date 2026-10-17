# Opera GX Workspace Tab Unloader

A small, local-only Manifest V3 extension for reviewing tabs in Opera GX workspaces and discarding eligible tabs individually or in bulk. A discarded tab stays in the tab strip and reloads when activated.

## Features

- **Workspace selector:** The popup defaults to the current workspace each time it opens, but you can select another detected workspace without switching to it in Opera GX.
- **Workspace-specific targeting:** Tabs are selected by Opera's `workspaceId`, not by window ID.
- **Immediate individual unloading:** Clicking **Unload tab** runs the safety preflight again and discards that tab without a separate confirmation.
- **Confirmed bulk unloading:** Review and confirm the batch. Every tab is checked again immediately before the discard attempt.
- **Configurable preferences:** Skip pinned tabs, audible tabs, and tabs marked `autoDiscardable: false`. Preference buttons show green ON and red OFF states.
- **Persistent sorting:** Choose **Eligible first**, **Eligible last**, or **Tab order**. The choice is saved locally and restored the next time the popup opens.
- **Conservative scope checks:** Tabs without a verifiable workspace identity are not guessed into a workspace. If any tab has unknown workspace identity, bulk unloading is blocked.
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

Individual unloads do not show a confirmation dialog, as requested, but they always revalidate tab eligibility before calling `chrome.tabs.discard()`. Bulk unloads require confirmation and compare the eligible set against the reviewed set before processing sequentially. The extension also verifies the browser's reported discard state after each attempt.

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
- Create two GX workspaces and ensure the selector can target either without switching the browser's active workspace.
- Confirm opening the popup defaults the workspace selector to the current workspace.
- Confirm eligible-first, eligible-last and tab-order sorting persist when the popup is reopened.
- Test individual unload: a fresh preflight occurs and no confirmation is shown.
- Test bulk unload: confirmation appears, stale candidates abort safely, and each tab is rechecked immediately before discard.
- Test active tabs, pinned tabs, audible tabs, loading tabs, private windows, internal pages and already-discarded tabs.
- Test tabs being closed or moved between review and confirmation.
- Confirm discarded tabs remain visible and reload when activated.
- Test a website with unsaved form state and record actual behavior; generic extension APIs cannot guarantee protection for every web app.

## Permissions

- `tabs`: read tab metadata, inspect workspace IDs, enumerate tabs, and request native discard.
- `storage`: save local preferences and tab-sort order.

No website host permissions or content scripts are declared. Tab-supplied text is inserted using `textContent`, not interpreted as HTML.
