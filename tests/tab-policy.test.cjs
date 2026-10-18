const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/tab-policy.js');
const fs = require('node:fs');
const path = require('node:path');
const popupSource = fs.readFileSync(path.join(__dirname, '../src/popup.js'), 'utf8');
const optionsSource = fs.readFileSync(path.join(__dirname, '../src/options.js'), 'utf8');
const optionsHtml = fs.readFileSync(path.join(__dirname, '../options.html'), 'utf8');
const optionsCss = fs.readFileSync(path.join(__dirname, '../options.css'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8'));
const backgroundSource = fs.readFileSync(path.join(__dirname, '../src/background.js'), 'utf8');

function safeTab(overrides = {}) {
  return {
    id: 12,
    workspaceId: '3',
    workspaceName: 'Work',
    active: false,
    discarded: false,
    status: 'complete',
    pinned: false,
    audible: false,
    autoDiscardable: true,
    incognito: false,
    url: 'https://example.com/docs',
    title: 'Example docs',
    ...overrides
  };
}

test('allows a complete eligible HTTP page in the requested workspace', () => {
  assert.deepEqual(policy.evaluateTab(safeTab(), '3', {}), { eligible: true, reasons: [] });
});

test('normalizes numeric and string workspace IDs consistently', () => {
  assert.equal(policy.evaluateTab(safeTab({ workspaceId: 3 }), '3', {}).eligible, true);
});

test('does not use window ID as the workspace boundary', () => {
  assert.equal(policy.evaluateTab(safeTab({ windowId: 101 }), '3', {}).eligible, true);
});

test('rejects a tab assigned to a different workspace', () => {
  const result = policy.evaluateTab(safeTab({ workspaceId: '4' }), '3', {});
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join(' '), /different workspace/i);
});

test('fails closed when workspace identity is missing', () => {
  const result = policy.evaluateTab(safeTab({ workspaceId: undefined }), '3', {});
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join(' '), /workspace identity/i);
});

test('skips active tabs', () => {
  assert.match(policy.evaluateTab(safeTab({ active: true }), '3', {}).reasons.join(' '), /active/i);
});

test('protects loading tabs by default but allows an explicit loading-tab opt-out', () => {
  assert.match(policy.evaluateTab(safeTab({ status: 'loading' }), '3', {}).reasons.join(' '), /loading/i);
  assert.equal(policy.evaluateTab(safeTab({ status: 'loading', pendingUrl: 'https://example.com/next' }), '3', { skipLoadingTabs: false }).eligible, true);
  assert.equal(policy.evaluateTab(safeTab({ status: 'loading', pendingUrl: 'opera://settings' }), '3', { skipLoadingTabs: false }).eligible, false);
  assert.equal(policy.evaluateTab(safeTab({ status: 'loading', pendingUrl: undefined }), '3', { skipLoadingTabs: false }).eligible, false);
  assert.equal(policy.evaluateTab(safeTab({ status: 'loading', pendingUrl: undefined }), '3', { skipLoadingTabs: false, loadingUrlFallback: 'lastCommitted' }).eligible, true);
  assert.match(policy.evaluateTab(safeTab({ status: undefined }), '3', { skipLoadingTabs: false }).reasons.join(' '), /finished loading/i);
});

test('skips tabs already discarded', () => {
  assert.match(policy.evaluateTab(safeTab({ discarded: true }), '3', {}).reasons.join(' '), /already discarded/i);
});

test('skips pinned tabs by default but permits them when the preference is off', () => {
  assert.equal(policy.evaluateTab(safeTab({ pinned: true }), '3', {}).eligible, false);
  assert.equal(policy.evaluateTab(safeTab({ pinned: true }), '3', { skipPinnedTabs: false }).eligible, true);
});

test('skips audible tabs by default and fails closed when audio state is unknown', () => {
  assert.equal(policy.evaluateTab(safeTab({ audible: true }), '3', {}).eligible, false);
  assert.equal(policy.evaluateTab(safeTab({ audible: undefined }), '3', {}).eligible, false);
  assert.equal(policy.evaluateTab(safeTab({ audible: undefined }), '3', { skipAudibleTabs: false }).eligible, true);
});

test('skips tabs marked non-auto-discardable by default', () => {
  assert.equal(policy.evaluateTab(safeTab({ autoDiscardable: false }), '3', {}).eligible, false);
  assert.equal(policy.evaluateTab(safeTab({ autoDiscardable: false }), '3', { skipNonAutoDiscardableTabs: false }).eligible, true);
});

test('skips unknown auto-discardable state when that protection is enabled', () => {
  assert.equal(policy.evaluateTab(safeTab({ autoDiscardable: undefined }), '3', {}).eligible, false);
});

test('skips private tabs', () => {
  assert.match(policy.evaluateTab(safeTab({ incognito: true }), '3', {}).reasons.join(' '), /private/i);
});

test('only permits normal HTTP and HTTPS URLs', () => {
  for (const url of ['opera://settings', 'chrome://extensions', 'file:///tmp/example.html', 'javascript:alert(1)', 'data:text/html,hello']) {
    assert.equal(policy.evaluateTab(safeTab({ url }), '3', {}).eligible, false, url);
  }
  assert.equal(policy.evaluateTab(safeTab({ url: 'http://example.com' }), '3', {}).eligible, true);
});

test('skips URLs with embedded credentials', () => {
  assert.match(policy.evaluateTab(safeTab({ url: 'https://user:secret@example.com/' }), '3', {}).reasons.join(' '), /embedded credentials/i);
});

test('rejects unknown critical browser metadata', () => {
  const tab = safeTab({ active: undefined, discarded: undefined, pinned: undefined, incognito: undefined });
  const result = policy.evaluateTab(tab, '3', {});
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.length >= 4);
});

test('rejects missing or invalid tab identifiers', () => {
  assert.equal(policy.evaluateTab(safeTab({ id: undefined }), '3', {}).eligible, false);
  assert.equal(policy.evaluateTab(null, '3', {}).eligible, false);
});

test('sorts eligible tabs first while preserving relative order within groups', () => {
  const items = [
    { tab: { id: 1 }, index: 0, evaluation: { eligible: false } },
    { tab: { id: 2 }, index: 1, evaluation: { eligible: true } },
    { tab: { id: 3 }, index: 2, evaluation: { eligible: false } },
    { tab: { id: 4 }, index: 3, evaluation: { eligible: true } }
  ];
  assert.deepEqual(policy.sortEvaluatedTabs(items, 'eligible-first').map((item) => item.tab.id), [2, 4, 1, 3]);
});

test('sorts eligible tabs last while preserving relative order within groups', () => {
  const items = [
    { tab: { id: 1 }, index: 0, evaluation: { eligible: true } },
    { tab: { id: 2 }, index: 1, evaluation: { eligible: false } },
    { tab: { id: 3 }, index: 2, evaluation: { eligible: true } }
  ];
  assert.deepEqual(policy.sortEvaluatedTabs(items, 'eligible-last').map((item) => item.tab.id), [2, 1, 3]);
});

test('tab-order sorting preserves browser query order', () => {
  const items = [
    { tab: { id: 1 }, index: 2, evaluation: { eligible: true } },
    { tab: { id: 2 }, index: 0, evaluation: { eligible: false } },
    { tab: { id: 3 }, index: 1, evaluation: { eligible: true } }
  ];
  assert.deepEqual(policy.sortEvaluatedTabs(items, 'tab-order').map((item) => item.tab.id), [2, 3, 1]);
});

test('same-workspace comparison normalizes IDs and fails closed on missing identity', () => {
  assert.equal(policy.isSameWorkspace('3', '3'), true);
  assert.equal(policy.isSameWorkspace(3, '3'), true);
  assert.equal(policy.isSameWorkspace('4', '3'), false);
  assert.equal(policy.isSameWorkspace(undefined, '3'), false);
  assert.equal(policy.isSameWorkspace('3', null), false);
});

test('non-current workspace rows remain disabled during busy operations and pending review', () => {
  assert.match(popupSource, /button\.dataset\.requiresCurrentWorkspace = String\(!workspaceIsCurrent\)/);
  assert.match(popupSource, /button\.disabled = controlsBusy \|\| Boolean\(pendingBulk\) \|\| button\.dataset\.requiresCurrentWorkspace === "true"/);
  assert.match(popupSource, /Read-only preview\. Switch to this workspace in Opera GX before unloading tabs\./);
  assert.match(popupSource, /Read-only: switch workspace to unload/);
  assert.match(popupSource, /reviewingBulk = true/);
});

test('popup delegates discards to the background coordinator and listens for live tab changes', () => {
  assert.doesNotMatch(popupSource, /await chrome\.tabs\.discard\(/);
  assert.match(popupSource, /requestBackground\("UNLOAD_ONE"/);
  assert.match(popupSource, /requestBackground\("UNLOAD_BATCH"/);
  assert.match(popupSource, /refreshSequence/);
  assert.match(popupSource, /\["onUpdated", "onCreated", "onRemoved", "onActivated", "onReplaced"\]/);
  assert.match(popupSource, /refreshTimer/);
  assert.doesNotMatch(popupSource, /recordDiagnostic|diagnosticEvents|DIAGNOSTIC_KEY|export-diagnostics-button/);
});

test('background coordinator checks the active workspace before every discard attempt', () => {
  assert.match(backgroundSource, /async function inspectAndDiscard/);
  assert.match(backgroundSource, /latestWorkspaceId = \(await getActiveContext\(tabDeadlineAt\)\)\.currentWorkspaceId/);
  assert.match(backgroundSource, /if \(!sameWorkspace\(targetWorkspaceId, latestWorkspaceId\)\)/);
  assert.match(backgroundSource, /api\.tabs\.discard\(tabId\)/);
});

test('background startup cancellation verifies the actual current workspace', () => {
  assert.match(backgroundSource, /async function onTabActivated\(_activeInfo\)/);
  assert.match(backgroundSource, /currentWorkspaceId = \(await getActiveContext\(\)\)\.currentWorkspaceId/);
  assert.doesNotMatch(backgroundSource, /startupCapturingWorkspace|startupPreRunWorkspaceIds|activationIsInFocusedWindow/);
  assert.ok(backgroundSource.includes('if (currentWorkspaceId === null)'));
  assert.ok(backgroundSource.includes('if (!sameWorkspace(currentWorkspaceId, run.workspaceId))'));
  assert.match(backgroundSource, /Workspace changed during startup auto-unload/);
  assert.match(backgroundSource, /if \(run\.cancelled\)/);
  assert.match(backgroundSource, /loadingWaitMs/);
  assert.doesNotMatch(backgroundSource, /tab\.active === true && !sameWorkspace\(tab\.workspaceId, run\.workspaceId\)/);
});;


test('validates numeric settings and enforces the overall deadline relationship', () => {
  const settings = { ...policy.DEFAULT_PREFERENCES };
  assert.deepEqual(policy.validatePreferences(settings), []);
  assert.ok(policy.validatePreferences({ ...settings, startupDiscoverySeconds: -1 }).some((message) => /startupDiscoverySeconds/.test(message)));
  assert.ok(policy.validatePreferences({ ...settings, startupDiscoverySeconds: 30, startupLoadingWaitSeconds: 120, overallDeadlineSeconds: 60 }).some((message) => /must fit within the overall deadline/.test(message)));
  assert.ok(policy.validatePreferences({ ...settings, startupDiscoverySeconds: 8, startupLoadingWaitSeconds: 0, startupQuietPeriodSeconds: 2, perTabTimeoutSeconds: 5, overallDeadlineSeconds: 10 }).some((message) => /at least one per-tab attempt/.test(message)));
  assert.equal(policy.normalizePreferences({ startupDiscoverySeconds: 30, startupLoadingWaitSeconds: 120, overallDeadlineSeconds: 60 }).startupDiscoverySeconds, policy.DEFAULT_PREFERENCES.startupDiscoverySeconds);
});

test('normalizes only recognized preference value types and safe URL fallback choices', () => {
  const normalized = policy.normalizePreferences({ skipLoadingTabs: false, autoUnloadOnStartup: true, loadingUrlFallback: 'unsafe', overallDeadlineSeconds: -20 });
  assert.equal(normalized.skipLoadingTabs, false);
  assert.equal(normalized.autoUnloadOnStartup, true);
  assert.equal(normalized.loadingUrlFallback, 'skip');
  assert.equal(normalized.overallDeadlineSeconds, policy.DEFAULT_PREFERENCES.overallDeadlineSeconds);
});


test('dedicated settings page validates values, confirms risky changes, and restores defaults', () => {
  assert.match(optionsSource, /policy\.validatePreferences\(next\)/);
  assert.match(optionsSource, /askConfirmation\(/);
  assert.match(optionsSource, /ui\.dialog\.showModal\(\)/);
  assert.match(optionsSource, /queueSave\(550\)/);
  assert.match(optionsSource, /showLoadingDialogAfterDelay\(/);
  assert.match(optionsSource, /hideLoadingDialog\(\)/);
  assert.match(optionsHtml, /id="loading-dialog"/);
  assert.match(optionsCss, /\.loading-dialog::backdrop/);
  assert.match(optionsCss, /\.loading-spinner/);
  assert.doesNotMatch(optionsSource, /window\.confirm/);
  assert.match(optionsSource, /policy\.DEFAULT_PREFERENCES/);
  assert.match(optionsSource, /savedSortMode = "eligible-first"/);
  assert.match(optionsSource, /fillControls\(savedPreferences, savedSortMode\)/);
  assert.match(optionsHtml, /Maximum time for one tab attempt/);
  assert.match(optionsHtml, /Missing pending URL fallback/);
  assert.match(optionsHtml, /startupSkipLoadingTabs/);
  assert.match(optionsHtml, /bulkUnloadMode/);
  assert.match(optionsHtml, /confirmBulkUnload/);
  assert.match(optionsHtml, /Reset to defaults/);
  assert.match(optionsHtml, /settings-nav/);
  assert.match(optionsSource, /setupScrollNavigation/);
  assert.match(optionsHtml, /startupQuietPeriodSeconds/);
  assert.match(optionsHtml, /Manual adaptive scan window/);
  assert.doesNotMatch(optionsHtml, /Save settings/);
});

test('status indicators are toolbar-only and do not appear in the Options tab favicon', () => {
  assert.equal(manifest.icons['16'], 'icons/base16.png');
  assert.equal(manifest.icons['32'], 'icons/base32.png');
  assert.equal(manifest.icons['48'], 'icons/base48.png');
  assert.equal(manifest.action.default_icon['16'], 'icons/base16.png');
  assert.doesNotMatch(JSON.stringify(manifest.icons), /idle16|working16|success16|error16/);
});

test('popup refresh button provides visible rotating busy feedback', () => {
  assert.match(popupSource, /body\.classList\.add\("is-refreshing"\)/);
  assert.match(popupSource, /ui\.refresh\.setAttribute\("aria-busy", "true"\)/);
  assert.match(popupSource, /body\.classList\.remove\("is-refreshing"\)/);
});

test('defaults to adaptive bulk unloading with confirmation and independent protection profiles', () => {
  const defaults = policy.DEFAULT_PREFERENCES;
  assert.equal(defaults.bulkUnloadMode, 'adaptive');
  assert.equal(defaults.confirmBulkUnload, true);
  assert.equal(defaults.skipLoadingTabs, true);
  assert.equal(defaults.startupSkipLoadingTabs, true);
  assert.equal(defaults.adaptiveBulkScanSeconds, 45);
});

test('migrates legacy shared protection values to the startup profile on upgrade', () => {
  const normalized = policy.normalizePreferences({
    skipPinnedTabs: false,
    skipAudibleTabs: true,
    skipNonAutoDiscardableTabs: true,
    skipLoadingTabs: false,
    loadingUrlFallback: 'lastCommitted'
  });
  assert.equal(normalized.skipPinnedTabs, false);
  assert.equal(normalized.startupSkipPinnedTabs, false);
  assert.equal(normalized.skipLoadingTabs, false);
  assert.equal(normalized.startupSkipLoadingTabs, false);
  assert.equal(normalized.startupLoadingUrlFallback, 'lastCommitted');
});

test('keeps manually configured and startup protection profiles independent after migration', () => {
  const normalized = policy.normalizePreferences({
    skipLoadingTabs: false,
    startupSkipPinnedTabs: true,
    startupSkipAudibleTabs: true,
    startupSkipNonAutoDiscardableTabs: true,
    startupSkipLoadingTabs: true,
    startupLoadingUrlFallback: 'skip'
  });
  const manual = policy.getPolicyPreferences(normalized, 'manual');
  const startup = policy.getPolicyPreferences(normalized, 'startup');
  assert.equal(manual.skipLoadingTabs, false);
  assert.equal(startup.skipLoadingTabs, true);
});

test('validates adaptive scan windows and exact-review mode values', () => {
  const defaults = { ...policy.DEFAULT_PREFERENCES };
  assert.deepEqual(policy.validatePreferences(defaults), []);
  assert.ok(policy.validatePreferences({ ...defaults, bulkUnloadMode: 'surprise' }).some((message) => /bulkUnloadMode/.test(message)));
  assert.ok(policy.validatePreferences({ ...defaults, adaptiveBulkScanSeconds: 180, perTabTimeoutSeconds: 30, overallDeadlineSeconds: 180 }).some((message) => /adaptive bulk scan window/.test(message)));
  assert.ok(policy.validatePreferences({ ...defaults, startupDiscoverySeconds: 240, startupLoadingWaitSeconds: 120, startupQuietPeriodSeconds: 10, perTabTimeoutSeconds: 30, overallDeadlineSeconds: 300 }).some((message) => /startup monitoring window/.test(message)));
});
