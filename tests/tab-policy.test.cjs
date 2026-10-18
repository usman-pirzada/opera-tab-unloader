const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/tab-policy.js');
const fs = require('node:fs');
const path = require('node:path');
const popupSource = fs.readFileSync(path.join(__dirname, '../src/popup.js'), 'utf8');
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
  assert.equal(policy.evaluateTab(safeTab({ status: 'loading' }), '3', { skipLoadingTabs: false }).eligible, true);
  assert.equal(policy.evaluateTab(safeTab({ status: 'loading', pendingUrl: 'opera://settings' }), '3', { skipLoadingTabs: false }).eligible, false);
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

test('non-current workspace rows remain disabled through control refreshes', () => {
  assert.match(popupSource, /button\.dataset\.requiresCurrentWorkspace = String\(!workspaceIsCurrent\)/);
  assert.match(popupSource, /button\.disabled = busy \|\| button\.dataset\.requiresCurrentWorkspace === "true"/);
  assert.match(popupSource, /Read-only preview\. Switch to this workspace in Opera GX before unloading tabs\./);
  assert.match(popupSource, /Read-only: switch workspace to unload/);
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
  assert.match(backgroundSource, /latestWorkspaceId = \(await getActiveContext\(\)\)\.currentWorkspaceId/);
  assert.match(backgroundSource, /if \(!sameWorkspace\(targetWorkspaceId, latestWorkspaceId\)\)/);
  assert.match(backgroundSource, /await api\.tabs\.discard\(tabId\)/);
});

test('background startup run is cancelled when a different workspace becomes active', () => {
  assert.match(backgroundSource, /cancelStartupRun\(run, activeWorkspaceId === null/);
  assert.match(backgroundSource, /Workspace changed during startup auto-unload/);
  assert.match(backgroundSource, /if \(run\.cancelled\)/);
  assert.match(backgroundSource, /loadingWaitMs/);
});
