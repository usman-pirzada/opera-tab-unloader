# Opera GX Workspace Tab Unloader

A small, local-only Manifest V3 extension that reviews tabs assigned to the active **Opera GX workspace** and lets you discard eligible tabs individually or in bulk. A discarded tab stays in the tab strip and reloads when activated.

> **Important limitation:** Chromium/Opera extension APIs do not expose a universal "safe to unload" property and cannot reliably detect every kind of unsaved state held inside arbitrary websites. This extension uses conservative checks for browser-visible conditions, but cannot guarantee that a website will restore all application-only state after a discard. Save important work before discarding tabs.

## Scope and behavior

- Determines the active workspace from the active tab's Opera-specific `workspaceId` property.
- Selects tabs by workspace ID, **not by window ID**. This is intended to include tabs with the same workspace ID across browser windows.
- Fails closed when the active workspace cannot be identified. Tabs without a workspace ID are not guessed into a workspace; their presence blocks bulk unloading.
- Supports an individual two-step review/confirm action and a two-step bulk review/confirm action.
- Re-checks each tab's current metadata and workspace identity immediately before calling `chrome.tabs.discard()`.
- Verifies that the browser reports a discarded tab after the operation.
- By default, skips pinned tabs, audible tabs, and tabs marked `autoDiscardable: false`.
- Always skips the active tab, loading or unknown-status tabs, already-discarded tabs, private tabs, non-HTTP(S) URLs, and URLs containing embedded credentials.
- Uses no content scripts, host permissions, external services, telemetry, analytics or runtime dependencies.

## Compatibility notes

Opera documents `workspaceId` and `workspaceName` on its Tabs API from Opera 77 onward. This project targets Opera GX, including the Flatpak distribution, but the workspace fields must still be tested in the exact installed GX build. If they are missing, the extension refuses to infer workspace membership from the current window.

The extension runs inside the browser; it does not depend on whether Opera GX was installed using Flatpak, `.deb`, or `.rpm`. No host OS integration is required.

## Install in Opera GX Flatpak on Linux

1. Download or clone this repository into a normal folder in your home directory.
2. Open `opera://extensions` in Opera GX.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the repository folder containing `manifest.json`.
5. Pin the extension to the toolbar, open it, and inspect the detected workspace and tab preflight results.

The Flatpak package does not change the extension API. Choose the folder using Opera GX's file picker rather than trying to copy the extension into the browser's internal Flatpak directories.

## Tests

Node.js 18 or later is required only to run the unit tests; it is not required for the extension itself.

```bash
npm test
```

The unit tests cover the pure safety policy. They do not substitute for manual integration testing in Opera GX.

## Manual integration test checklist

- Verify workspace IDs are returned for tabs in all open browser windows.
- Create at least two GX workspaces with several tabs each and ensure only tabs matching the active tab's `workspaceId` are listed.
- Verify a workspace's tabs are found across windows if GX shares that workspace identity across windows.
- Ensure missing workspace IDs block bulk unloading rather than falling back to window-based selection.
- Test active tabs, pinned tabs, audible tabs, loading tabs, private windows, internal pages, and already-discarded tabs.
- Test individual and bulk operations while moving/closing tabs or changing workspaces between review and confirmation.
- Confirm discarded tabs remain visible and are reloaded when activated.
- Test a website with unsaved form state. Record the observed behavior; do not assume every site can be protected by generic preflight checks.

## Permissions

- `tabs`: needed to read tab metadata, identify Opera workspace IDs, list tabs and request native discard.
- `storage`: saves the user's local safety preferences.

No website host permissions or content scripts are declared. The UI uses `textContent` when displaying tab-supplied strings, rather than inserting titles or URLs as HTML.

## Development

No build step is needed. The manifest points directly at the source files.
