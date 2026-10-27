# Opera GX Workspace Tab Unloader

Unload eligible tabs in Opera GX to help free up memory while keeping those tabs in your tab bar. Inspect tabs across workspaces, unload one tab at a time or in bulk, and adjust protections to fit your workflow.

## Features

- **Workspace-aware tab list:** View eligible and skipped tabs in detected Opera GX workspaces. Other workspaces are previews until you switch to them in Opera GX.
- **Unload one tab:** Unload an eligible tab without a separate confirmation dialog. The extension checks it again immediately before the action.
- **Bulk unloading:** Choose adaptive scanning to look for newly eligible tabs during a limited scan window, or exact-review mode to work from a reviewed list. Confirmation behavior can be configured in Settings.
- **Optional startup auto-unload:** When enabled, the extension monitors the startup workspace and unloads eligible tabs during a configurable window. This feature is off by default.
- **Separate protection profiles:** Configure protections for manual unloading and startup auto-unload independently, including pinned, audible, non-auto-discardable, and loading tabs.
- **Settings page:** Preferences save automatically. Timing values are validated, settings that reduce protections ask for confirmation, and defaults can be restored.
- **Operation status:** A toolbar indicator shows bulk/startup activity and recent outcomes. The popup displays current counts and the latest startup result.
- **Keyboard shortcut:** `Ctrl+Shift+U` is the suggested shortcut for opening the popup and starting the selected bulk mode. You can change it in Opera GX's extension-shortcuts settings.
- **Privacy-conscious design:** No content scripts, website host permissions, remote code, external services, telemetry, analytics, or runtime dependencies.

## Before unloading a tab

Unloading uses Opera's built-in tab-discarding feature to free memory while **keeping the tab in your tab bar**. The tab is not deleted; when you select it again, Opera reloads the page.

As with any page reload, a website might not restore changes that you haven't saved on that website yet (for example, text typed into a form but not submitted). Save important changes before unloading a tab.

## Install on Opera GX

This project targets Opera GX, including its Linux Flatpak distribution. Workspace features depend on the version of Opera GX installed.

1. Download and extract the source from the [repository](https://github.com/usman-pirzada/opera-tab-unloader), or clone it:

   ```bash
   git clone https://github.com/usman-pirzada/opera-tab-unloader.git
   ```

2. Open `opera://extensions` in Opera GX.
3. Turn on **Developer mode**.
4. Select **Load unpacked** and choose the project folder containing `manifest.json`.
5. Pin **Workspace Tab Unloader** to the toolbar for easy access.

To update an unpacked installation, update the project files and select **Reload** on the extension's card in `opera://extensions`. The `staged` branch may contain features that have not yet been included in a published release.

## How to use it

### Inspect and unload tabs

1. Open the extension from the toolbar. The popup defaults to the current workspace.
2. Use the workspace selector to inspect a workspace.
3. Review the eligible/skipped labels and counts. The sorting preference can show eligible tabs first, eligible tabs last, or browser tab order.
4. Select **Unload tab** beside an eligible tab, or start the configured bulk-unload action.
5. Review and confirm a bulk action when confirmation is enabled in Settings.

A discarded tab remains visible in the tab bar and normally reloads when you select it again.

**Workspace behavior:** Tabs in other workspaces are read-only previews. The extension does not switch workspaces for you. Switch to the target workspace in Opera GX, then reopen the popup before unloading tabs there. If workspace identity cannot be verified, the extension refuses to guess.

### Configure Settings

Open the extension's **Settings** page from the extension details page or menu. Changes save automatically. Settings include:

- Separate manual-unload and startup-auto-unload protection profiles.
- Protections for pinned, audible, non-auto-discardable, and loading tabs.
- Bulk mode and confirmation preferences.
- Optional startup auto-unload, disabled by default.
- Startup monitoring, loading grace, scan intervals, adaptive scan window, per-tab time budget, and overall time limit.
- Reset to recommended defaults.

Read the explanation next to each setting before reducing a protection. Some changes require confirmation. If a tab's pending URL cannot be verified, the extension skips it by default rather than guessing.

### Toolbar status indicator

The toolbar indicator communicates bulk or startup activity and its latest outcome. Individual tab unloads do not change it. If an operation reports an error or cancellation, review the details in the popup rather than assuming all tabs were unloaded.

## Safety and limitations

The extension uses conservative checks before attempting to unload tabs. It skips or blocks operations involving the active tab, already-discarded tabs, private-window tabs, browser-internal pages, URLs containing embedded credentials, tabs with unknown critical metadata, and tabs without a verifiable workspace identity. It also avoids unloading tabs whose loading/status state cannot be evaluated safely.

Pinned, audible, non-auto-discardable, and loading-tab protections can be configured separately for manual and startup operations. Disabling a protection can make more tabs eligible, so read the warning shown in Settings.

Bulk operations recheck eligibility and workspace identity before each attempt. Adaptive mode takes fresh snapshots during its scan window; exact-review mode uses a fixed candidate list and may cancel if that list changes. Operations have time limits. If the extension cannot confirm whether a discard succeeded, it stops further attempts rather than reporting an unverified success.

Startup auto-unload only targets the workspace captured at startup. It does not switch workspaces and stops safely if workspace identity is ambiguous or the active workspace changes. If Opera ends the extension's background process, a startup run may end early.

## Compatibility

Opera exposes `workspaceId` and `workspaceName` in its Tabs API from Opera 77 onward. Your installed Opera GX build must return consistent workspace IDs for workspace-aware behavior to work. If the extension cannot verify workspace identity, it avoids unloading tabs based on window identity alone.

The extension runs inside the browser. On Linux Flatpak, there is no need to copy files into Flatpak's internal directories.

## Privacy and permissions

The extension requests only these permissions:

- `tabs` — read tab metadata, inspect workspace IDs, enumerate tabs, observe tab lifecycle events, and request tab discarding.
- `storage` — save preferences, sorting choices, and a summary of the latest startup operation.

There are no website host permissions or content scripts. Preferences are stored locally. Tab-supplied text is displayed as text, not interpreted as HTML. The extension does not include telemetry, analytics, or remote services.

## Troubleshooting

- **Workspace list or counts look wrong:** Confirm your Opera GX version supports workspace metadata, then close and reopen the popup.
- **Unload controls are disabled:** The selected workspace may not be the current workspace, or its identity may be unavailable. Switch workspaces in Opera GX itself.
- **A tab is skipped:** Check the reason shown in the popup and review the related protections in Settings. Some pages and tab states are intentionally ineligible.
- **An operation stops early or reports an uncertain result:** The extension could not safely confirm the browser's result. Check the tab and retry after the browser settles.
- **The keyboard shortcut does not work:** Open Opera GX's extension-shortcuts settings and check the shortcut assigned to the extension.
- **A page does not restore unsaved input:** Save important changes before unloading. This is a limitation of page reloads in general, not a sign that the tab itself was deleted.

## For contributors

Bug reports and contributions are welcome. For a useful report, include your Opera GX version, installation type, exact steps to reproduce, expected behavior, and observed behavior. Do not include passwords, private browsing data, or sensitive page contents.

### Development requirements

- Node.js 18 or later for automated tests.
- Opera GX for live integration testing, especially workspace identity, native tab discarding, startup restoration, and keyboard shortcuts.

### Run automated tests

```bash
npm test
```

The test suite covers eligibility/sorting rules and mocked asynchronous background operations. Passing automated tests does not replace live testing in Opera GX.

### Useful integration checks

- Workspace previews and read-only behavior for workspaces that are not current.
- Individual unloads and both bulk modes while tabs open, close, move, or change eligibility.
- Loading-tab, pinned-tab, audible-tab, and non-auto-discardable protections in each profile.
- Startup auto-unload being off by default, tracking the startup workspace, and stopping on workspace changes.
- Timeout and uncertain-discard handling; unconfirmed outcomes must never be reported as success.
- Settings validation, reset-to-defaults, protection-change confirmations, and shortcut configuration.
- Website form state and other unsaved changes, recording actual behavior without assuming every web app handles reloads identically.

## Project structure

- `manifest.json` — extension metadata, permissions, Settings page, and keyboard shortcut.
- `popup.html`, `src/popup.js`, `styles.css` — toolbar popup and tab list.
- `options.html`, `src/options.js`, `options.css` — Settings interface.
- `src/background.js` — background operations, startup monitoring, and tab lifecycle handling.
- `src/tab-policy.js` — shared eligibility and sorting rules.
- `tests/` — automated tests.
- `.github/workflows/` — automated test and packaging workflow.

## License

This project is licensed under the MIT License.
See [LICENSE](LICENSE) for the full license text.
