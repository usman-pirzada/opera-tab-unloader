const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/tab-policy.js');
const { createController } = require('../src/background.js');

function makeEvent() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    fire(...args) { listeners.forEach((listener) => listener(...args)); },
    listeners
  };
}

function tab(overrides = {}) {
  return {
    id: 1,
    windowId: 1,
    workspaceId: 'A',
    workspaceName: 'Alpha',
    active: false,
    discarded: false,
    status: 'complete',
    pinned: false,
    audible: false,
    autoDiscardable: true,
    incognito: false,
    url: 'https://example.com/',
    title: 'Example',
    ...overrides
  };
}

function mockBrowser(initialTabs, savedPrefs = {}, discardImpl) {
  const tabsById = new Map(initialTabs.map((value) => [value.id, { ...value }]));
  let activeTabId = initialTabs.find((value) => value.active)?.id ?? initialTabs[0]?.id ?? null;
  const store = { ...savedPrefs };
  const calls = { discard: [], get: [] };
  const events = {
    runtimeMessage: makeEvent(),
    startup: makeEvent(),
    activated: makeEvent(),
    created: makeEvent(),
    updated: makeEvent(),
    removed: makeEvent(),
    replaced: makeEvent()
  };

  function clone(value) { return value ? { ...value } : value; }
  const api = {
    runtime: {
      onMessage: events.runtimeMessage,
      onStartup: events.startup
    },
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === 'string') return { [keys]: store[keys] };
          const result = {};
          for (const key of Array.isArray(keys) ? keys : Object.keys(store)) {
            if (Object.prototype.hasOwnProperty.call(store, key)) result[key] = store[key];
          }
          return result;
        },
        async set(values) { Object.assign(store, values); }
      }
    },
    tabs: {
      onActivated: events.activated,
      onCreated: events.created,
      onUpdated: events.updated,
      onRemoved: events.removed,
      onReplaced: events.replaced,
      async query(queryInfo = {}) {
        if (queryInfo.active && queryInfo.lastFocusedWindow) {
          const selected = tabsById.get(activeTabId);
          return selected ? [clone(selected)] : [];
        }
        return Array.from(tabsById.values(), clone);
      },
      async get(id) {
        calls.get.push(id);
        const value = tabsById.get(id);
        if (!value) throw new Error('No tab with id: ' + id);
        return clone(value);
      },
      async discard(id) {
        calls.discard.push(id);
        if (discardImpl) return discardImpl(id, tabsById, calls);
        const value = tabsById.get(id);
        if (!value) throw new Error('No tab with id: ' + id);
        value.discarded = true;
        value.status = 'complete';
        return clone(value);
      }
    }
  };

  return {
    api,
    events,
    calls,
    store,
    tabsById,
    activate(id) {
      if (!tabsById.has(id)) throw new Error('Cannot activate unknown tab ' + id);
      for (const [tabId, value] of tabsById) {
        if (value.windowId === tabsById.get(id).windowId) value.active = tabId === id;
      }
      activeTabId = id;
      events.activated.fire({ tabId: id, windowId: tabsById.get(id).windowId });
    },
    update(id, changes) {
      const value = tabsById.get(id);
      if (!value) throw new Error('Cannot update unknown tab ' + id);
      Object.assign(value, changes);
      events.updated.fire(id, changes, clone(value));
    },
    create(value) {
      tabsById.set(value.id, { ...value });
      events.created.fire(clone(value));
    }
  };
}

test('uses tabs.discard result without an unnecessary verification lookup', async () => {
  const browser = mockBrowser([
    tab({ id: 1, active: true }),
    tab({ id: 2, title: 'Target tab' })
  ]);
  const controller = createController(browser.api, policy, { discoveryMs: 5, loadingWaitMs: 20 });
  const result = await controller.inspectAndDiscard(2, 'A', policy.DEFAULT_PREFERENCES, true, null);
  assert.equal(result.state, 'success');
  assert.deepEqual(browser.calls.discard, [2]);
  assert.equal(browser.calls.get.filter((id) => id === 2).length, 1);
});

test('reports a missing post-discard tab as uncertain, never as success', async () => {
  const browser = mockBrowser(
    [tab({ id: 1, active: true }), tab({ id: 2, title: 'Closing tab' })],
    {},
    async (id, tabs) => { tabs.delete(id); return undefined; }
  );
  const controller = createController(browser.api, policy);
  const result = await controller.inspectAndDiscard(2, 'A', policy.DEFAULT_PREFERENCES, true, null);
  assert.equal(result.state, 'uncertain');
  assert.match(result.message, /uncertain/i);
});

test('bulk unloading stops after an uncertain outcome instead of attempting later tabs', async () => {
  const browser = mockBrowser(
    [tab({ id: 1, active: true }), tab({ id: 2 }), tab({ id: 3, title: 'Later tab' })],
    {},
    async (id, tabs) => {
      if (id === 2) {
        tabs.delete(id);
        return undefined;
      }
      const value = tabs.get(id);
      value.discarded = true;
      return { ...value };
    }
  );
  const controller = createController(browser.api, policy);
  const result = await controller.unloadBatchMessage({ workspaceId: 'A', tabIds: [2, 3], preferences: {} });
  assert.equal(result.state, 'aborted');
  assert.equal(result.failed, 1);
  assert.deepEqual(browser.calls.discard, [2]);
  assert.equal(browser.tabsById.get(3).discarded, false);
});

test('startup auto-unload cancels when the user switches workspaces during restoration', async () => {
  const browser = mockBrowser([
    tab({ id: 1, active: true }),
    tab({ id: 2, status: 'loading', title: 'Restoring tab' }),
    tab({ id: 3, workspaceId: 'B', workspaceName: 'Beta', active: false, title: 'Other workspace' })
  ], {
    autoUnloadOnStartup: true,
    skipLoadingTabs: true,
    lastActiveWorkspaceId: 'A'
  });
  const controller = createController(browser.api, policy, { discoveryMs: 10, loadingWaitMs: 500 });
  controller.install();

  const run = controller.runStartupAutoUnload();
  let switchedDuringLoadingWait = false;
  setTimeout(() => {
    switchedDuringLoadingWait = controller.getStartupRun()?.phase === 'waiting-load';
    browser.activate(3);
  }, 50);
  await run;

  assert.equal(switchedDuringLoadingWait, true);
  assert.deepEqual(browser.calls.discard, []);
  assert.equal(browser.store.startupStatus.state, 'cancelled');
  assert.match(browser.store.startupStatus.message, /workspace changed/i);
});

test('startup waits for loading tabs to complete before attempting them by default', async () => {
  const browser = mockBrowser([
    tab({ id: 1, active: true }),
    tab({ id: 2, status: 'loading', title: 'Restoring tab' })
  ], {
    autoUnloadOnStartup: true,
    skipLoadingTabs: true,
    lastActiveWorkspaceId: 'A'
  });
  const controller = createController(browser.api, policy, { discoveryMs: 5, loadingWaitMs: 200 });
  controller.install();

  setTimeout(() => browser.update(2, { status: 'complete' }), 35);
  await controller.runStartupAutoUnload();

  assert.deepEqual(browser.calls.discard, [2]);
  assert.equal(browser.tabsById.get(2).discarded, true);
  assert.equal(browser.store.startupStatus.state, 'completed');
});


test('startup collects tabs created late during the loading wait', async () => {
  const browser = mockBrowser([
    tab({ id: 1, active: true }),
    tab({ id: 2, status: 'loading', title: 'First restoring tab' })
  ], {
    autoUnloadOnStartup: true,
    skipLoadingTabs: true,
    lastActiveWorkspaceId: 'A'
  });
  const controller = createController(browser.api, policy, { discoveryMs: 5, loadingWaitMs: 250 });
  controller.install();

  setTimeout(() => browser.create(tab({ id: 3, status: 'complete', title: 'Late restored tab' })), 25);
  setTimeout(() => browser.update(2, { status: 'complete' }), 45);
  await controller.runStartupAutoUnload();

  assert.deepEqual(browser.calls.discard, [2, 3]);
  assert.equal(browser.tabsById.get(2).discarded, true);
  assert.equal(browser.tabsById.get(3).discarded, true);
});
