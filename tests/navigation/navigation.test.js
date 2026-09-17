import test from 'node:test';
import assert from 'node:assert';
import {
  PageCapability,
  classifyPageCapability,
  resolveNavigationTarget,
  validateNavigationUrl,
  urlsMatchForVerification,
  isPureNavigateTask,
  getNavigationGoal,
  getSiteHomepage
} from '../../extension/navigation/navigation.js';
import { AgentController } from '../../extension/background/agent-controller.js';
import { taskManager } from '../../extension/background/task-manager.js';
import { TaskState, localInterpretTask } from '../../extension/reasoning/task-understanding.js';
import { ActionType } from '../../extension/shared/constants.js';
import { defaultActionExecutor } from '../../extension/executor/action-executor.js';

// ---------- tiny chrome stub harness ----------

const realChrome = globalThis.chrome;

function stubChrome(tabsById, hooks = {}) {
  const calls = { update: [], sendMessage: [], executeScript: 0, sessionSet: 0 };
  globalThis.chrome = {
    tabs: {
      get: async (id) => {
        if (hooks.get) return hooks.get(id);
        const t = tabsById[id];
        if (!t) throw new Error('No tab with id ' + id);
        return { ...t };
      },
      update: async (id, props) => {
        calls.update.push([id, props]);
        if (hooks.update) return hooks.update(id, props);
        if (tabsById[id] && props?.url) tabsById[id] = { ...tabsById[id], url: props.url };
        return { ...(tabsById[id] || { id }) };
      },
      onUpdated: {
        addListener: () => {},
        removeListener: () => {}
      },
      sendMessage: (id, msg, cb) => {
        calls.sendMessage.push([id, msg]);
        if (typeof cb === 'function') cb({ success: false, error: 'no content script' });
      }
    },
    runtime: {},
    scripting: {
      executeScript: async () => {
        calls.executeScript++;
        throw new Error('Cannot access a chrome:// URL');
      }
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: { set: () => { calls.sessionSet++; return { catch() {} }; } }
    }
  };
  return calls;
}

function restoreChrome() {
  if (realChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = realChrome;
}

/** Build a controller-ready task without touching the network/backend. */
function makeTask(prompt, tabId) {
  const task = taskManager.createTask(prompt, tabId);
  task.taskState = new TaskState(prompt);
  task.taskState.updateFromModel(localInterpretTask(prompt));
  return task;
}

// ---------- 1-3: pure NAVIGATE from internal pages ----------

test('1. "open youtube" from chrome://newtab navigates and completes', async () => {
  const tabs = { 10: { id: 10, url: 'chrome://newtab', windowId: 1 } };
  const calls = stubChrome(tabs);
  try {
    const c = new AgentController();
    const task = makeTask('open youtube', 10);
    const cont = await c.runSingleStep(task);
    assert.strictEqual(cont, false, 'pure NAVIGATE should finish the loop');
    assert.strictEqual(taskManager.getTask().state, 'COMPLETED');
    assert.strictEqual(calls.update.length, 1);
    assert.strictEqual(calls.update[0][0], 10);
    assert.ok(String(calls.update[0][1].url).includes('youtube.com'), 'must navigate to YouTube');
    assert.strictEqual(tabs[10].url.includes('youtube.com'), true);
  } finally {
    restoreChrome();
  }
});

test('2. "open youtube" from chrome://extensions navigates and completes', async () => {
  const tabs = { 11: { id: 11, url: 'chrome://extensions', windowId: 1 } };
  const calls = stubChrome(tabs);
  try {
    const c = new AgentController();
    const task = makeTask('open youtube', 11);
    const cont = await c.runSingleStep(task);
    assert.strictEqual(cont, false);
    assert.strictEqual(taskManager.getTask().state, 'COMPLETED');
    assert.strictEqual(calls.update[0][0], 11);
    assert.ok(String(calls.update[0][1].url).includes('youtube.com'));
  } finally {
    restoreChrome();
  }
});

test('3. "open google" from about:blank navigates and completes', async () => {
  const tabs = { 12: { id: 12, url: 'about:blank', windowId: 1 } };
  const calls = stubChrome(tabs);
  try {
    const c = new AgentController();
    const task = makeTask('open google', 12);
    const cont = await c.runSingleStep(task);
    assert.strictEqual(cont, false);
    assert.strictEqual(taskManager.getTask().state, 'COMPLETED');
    assert.ok(String(calls.update[0][1].url).includes('google.com'));
  } finally {
    restoreChrome();
  }
});

// ---------- 4: NAVIGATE from a normal page ----------

test('4. "go to github.com" from a normal webpage navigates via task.tabId', async () => {
  const tabs = { 20: { id: 20, url: 'https://example.com/', windowId: 1 } };
  const calls = stubChrome(tabs);
  try {
    const c = new AgentController();
    const task = makeTask('go to github.com', 20);
    const cont = await c.runSingleStep(task);
    assert.strictEqual(cont, false);
    assert.strictEqual(calls.update[0][0], 20);
    assert.ok(String(calls.update[0][1].url).includes('github.com'));
    assert.strictEqual(taskManager.getTask().state, 'COMPLETED');
  } finally {
    restoreChrome();
  }
});

// ---------- 5: compound task bootstraps then continues ----------

test('5. "search youtube for cats" from chrome://newtab navigates first and continues', async () => {
  const tabs = { 30: { id: 30, url: 'chrome://newtab', windowId: 1 } };
  const calls = stubChrome(tabs);
  try {
    const c = new AgentController();
    const task = makeTask('search youtube for cats', 30);
    const cont = await c.runSingleStep(task);
    assert.strictEqual(cont, true, 'compound task must continue after bootstrap navigation');
    assert.strictEqual(calls.update.length, 1);
    assert.ok(String(calls.update[0][1].url).includes('youtube.com'), 'must hop to YouTube first');
    assert.notStrictEqual(taskManager.getTask().state, 'COMPLETED', 'must not complete before interacting');
    assert.strictEqual(calls.executeScript, 0, 'must never inject scripts into internal pages');
    assert.ok(
      calls.sendMessage.every(([, msg]) => msg?.type !== 'EXTRACT_DOM'),
      'must not DOM-extract the internal page'
    );
  } finally {
    restoreChrome();
  }
});

// ---------- 6: interaction on internal page is refused cleanly ----------

test('6. "click button on current page" from chrome://extensions is refused without injection', async () => {
  const tabs = { 40: { id: 40, url: 'chrome://extensions', windowId: 1 } };
  const calls = stubChrome(tabs);
  try {
    const c = new AgentController();
    const task = makeTask('click the settings button on this page', 40);
    await assert.rejects(() => c.runSingleStep(task), /browser internal page/);
    assert.strictEqual(calls.update.length, 0, 'must not navigate away');
    assert.strictEqual(calls.executeScript, 0, 'must not inject scripts');
    assert.ok(
      calls.sendMessage.every(([, msg]) => msg?.type !== 'EXTRACT_DOM'),
      'must not DOM-extract the internal page'
    );
  } finally {
    restoreChrome();
  }
});

// ---------- 7-9: dangerous schemes rejected ----------

test('7. javascript: URL is rejected', () => {
  assert.strictEqual(validateNavigationUrl('javascript:alert(1)').valid, false);
});

test('8. data: URL is rejected', () => {
  assert.strictEqual(validateNavigationUrl('data:text/html,<h1>x</h1>').valid, false);
});

test('9. file: URL is rejected', () => {
  assert.strictEqual(validateNavigationUrl('file:///etc/passwd').valid, false);
});

test('executor never navigates to blocked schemes', async () => {
  const tabs = { 50: { id: 50, url: 'https://example.com/', windowId: 1 } };
  const calls = stubChrome(tabs);
  try {
    await assert.rejects(
      () => defaultActionExecutor.execute(50, { action: ActionType.NAVIGATE, target: { url: 'javascript:alert(1)' } }),
      /Navigation blocked/
    );
    await assert.rejects(
      () => defaultActionExecutor.execute(50, { action: ActionType.NAVIGATE, target: { url: 'data:text/html,x' } }),
      /Navigation blocked/
    );
    assert.strictEqual(calls.update.length, 0, 'blocked URLs must never reach tabs.update');
  } finally {
    restoreChrome();
  }
});

// ---------- 10: tab identity preserved ----------

test('10. navigation uses task.tabId even when another tab is focused', async () => {
  const tabs = {
    21: { id: 21, url: 'chrome://newtab', windowId: 1 },
    99: { id: 99, url: 'https://example.com/', windowId: 1 }
  };
  const calls = stubChrome(tabs);
  try {
    const c = new AgentController();
    const task = makeTask('open youtube', 21);
    await c.runSingleStep(task);
    assert.strictEqual(calls.update.length, 1);
    assert.strictEqual(calls.update[0][0], 21, 'must navigate Tab A, not the focused Tab B');
    assert.ok(tabs[21].url.includes('youtube.com'));
    assert.strictEqual(tabs[99].url, 'https://example.com/', 'focused tab must be untouched');
  } finally {
    restoreChrome();
  }
});

// ---------- 11: redirect tolerance ----------

test('11. youtube.com → www.youtube.com redirect verifies as success', async () => {
  const tabs = { 60: { id: 60, url: 'chrome://newtab', windowId: 1 } };
  stubChrome(tabs, {
    update: async (id, props) => {
      // Simulate a redirect to the www host after navigation.
      tabs[id] = { ...tabs[id], url: 'https://www.youtube.com/' };
      return { ...tabs[id] };
    }
  });
  try {
    const c = new AgentController();
    const task = makeTask('open https://youtube.com', 60);
    const cont = await c.runSingleStep(task);
    assert.strictEqual(cont, false);
    assert.strictEqual(taskManager.getTask().state, 'COMPLETED');
    assert.ok(urlsMatchForVerification('https://youtube.com/', 'https://www.youtube.com/'));
    assert.ok(!urlsMatchForVerification('https://www.youtube.com/', 'https://www.google.com/'));
  } finally {
    restoreChrome();
  }
});

// ---------- capability + goal unit coverage ----------

test('page capability classification', () => {
  assert.strictEqual(classifyPageCapability('chrome://newtab'), PageCapability.BROWSER_INTERNAL);
  assert.strictEqual(classifyPageCapability('chrome://extensions'), PageCapability.BROWSER_INTERNAL);
  assert.strictEqual(classifyPageCapability('edge://settings'), PageCapability.BROWSER_INTERNAL);
  assert.strictEqual(classifyPageCapability('about:blank'), PageCapability.ABOUT_BLANK);
  assert.strictEqual(classifyPageCapability('chrome-extension://abc/sidepanel/index.html'), PageCapability.EXTENSION_INTERNAL);
  assert.strictEqual(classifyPageCapability('https://www.youtube.com/'), PageCapability.AUTOMATABLE_WEB);
  assert.strictEqual(classifyPageCapability('http://localhost:5000/'), PageCapability.AUTOMATABLE_WEB);
});

test('navigation goal resolution is deterministic', () => {
  assert.deepStrictEqual(getNavigationGoal('open youtube'), { url: 'https://www.youtube.com/', site: 'youtube', isPure: true });
  assert.strictEqual(getNavigationGoal('search youtube for cats'), null);
  assert.strictEqual(getNavigationGoal('find the cheapest laptop under 60000'), null);
  assert.strictEqual(isPureNavigateTask('open youtube'), true);
  assert.strictEqual(isPureNavigateTask('search youtube for cats'), false);
  assert.strictEqual(resolveNavigationTarget('open youtube videos daily'), null);
  assert.strictEqual(getSiteHomepage('youtube'), 'https://www.youtube.com/');
});

// ---------- 12: navigation timeout is an honest failure ----------

test('12. navigation timeout records failure instead of fake success', async () => {
  const tabs = { 70: { id: 70, url: 'chrome://newtab', windowId: 1 } };
  // tabs.update pretends to navigate but the URL never actually changes.
  const calls = stubChrome(tabs, {
    update: async (id) => ({ ...(tabs[id] || { id }) })
  });
  try {
    const c = new AgentController();
    // Shrink the verify window for this test via a short monkey-patch.
    const task = makeTask('open youtube', 70);
    const origVerify = c._verifyNavigation.bind(c);
    c._verifyNavigation = async (tabId, expected) => {
      void expected;
      const tab = await globalThis.chrome.tabs.get(tabId);
      return { ok: false, actualUrl: tab?.url || '' };
    };
    const cont = await c.runSingleStep(task);
    c._verifyNavigation = origVerify;
    assert.strictEqual(cont, true, 'timeout must recover, not complete');
    const stored = taskManager.getTask();
    assert.notStrictEqual(stored.state, 'COMPLETED', 'must never complete unverified navigation');
    const last = stored.steps[stored.steps.length - 1];
    assert.strictEqual(last.success, false, 'timeout step must be recorded as failed');
    void calls;
  } finally {
    restoreChrome();
  }
});

// ---------- 13: crash mid-navigation leaves no corrupted state ----------

test('13. executor crash during navigation leaves an honest recoverable task', async () => {
  const tabs = { 80: { id: 80, url: 'chrome://newtab', windowId: 1 } };
  const calls = stubChrome(tabs, {
    update: async () => { throw new Error('Service worker restarted mid-navigation'); }
  });
  try {
    const c = new AgentController();
    const task = makeTask('open youtube', 80);
    const cont = await c.runSingleStep(task);
    assert.strictEqual(cont, true, 'crashed navigation must stay recoverable');
    const stored = taskManager.getTask();
    assert.strictEqual(stored.state, 'EXECUTING', 'task must remain honestly in-flight, not COMPLETED/FAILED');
    assert.strictEqual(stored.steps.length, 1);
    assert.strictEqual(stored.steps[0].success, false);
    assert.ok(calls.sessionSet >= 1, 'pre-navigation state must have been persisted');
  } finally {
    restoreChrome();
  }
});
