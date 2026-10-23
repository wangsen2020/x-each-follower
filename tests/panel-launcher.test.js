import test from 'node:test';
import assert from 'node:assert/strict';
import {createPanelLauncher} from '../src/platform/panel-launcher.js';

function fixture({windows = [{id:7, focused:true}], tabs = [], create, send} = {}) {
  const calls = [], messages = [], warnings = [];
  const api = {
    runtime:{getURL:path => `chrome-extension://test/${path}`},
    windows:{getAll:async () => windows},
    tabs:{query:async () => tabs, create:async options => {
      calls.push(options);
      return create ? create(options) : {id:99};
    }}
  };
  const launcher = createPanelLauncher({api, makeToken:() => 'unique-token',
    warn:(...args) => warnings.push(args),
    sendToPanel:async message => { messages.push(message); return send ? send(message) : {ok:true}; }
  });
  return {api, launcher, calls, messages, warnings};
}

test('no browser window: scan defers without creating a tab or sending a task', async () => {
  const f = fixture({windows:[]});
  assert.deepEqual(await f.launcher.runScheduledScan(), {ok:false, reason:'no_window'});
  assert.equal(f.calls.length, 0);
  assert.equal(f.messages.length, 0);
  assert.equal(f.warnings.length, 1);
  assert.equal((await f.launcher.openPanel()).reason, 'no_window');
});

test('scan targets an explicit normal window and remains in the background', async () => {
  const f = fixture();
  assert.equal((await f.launcher.runScheduledScan()).ok, true);
  assert.deepEqual(f.calls, [{url:'chrome-extension://test/panel.html?scheduledFollowers=unique-token',active:false,windowId:7}]);
});

test('window closes during tab creation: failure is handled and never retried', async () => {
  const f = fixture({create:async () => { throw Error('No current window'); }});
  assert.equal((await f.launcher.runScheduledScan()).reason, 'open_failed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.messages.length, 0);
});

test('overlapping alarm handlers create only one scan tab', async () => {
  let release;
  const f = fixture({create:() => new Promise(resolve => { release = resolve; })});
  const first = f.launcher.runScheduledScan();
  const second = f.launcher.runScheduledScan();
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  release({id:99});
  await Promise.all([first, second]);
  assert.equal(f.calls.length, 1);
});

test('an existing scheduled scan is not started again', async () => {
  const f = fixture({tabs:[{id:2,url:'chrome-extension://test/panel.html?scheduledFollowers=old'}]});
  assert.equal((await f.launcher.runScheduledScan()).existing, true);
  assert.equal(f.messages.length, 0);
  assert.equal(f.calls.length, 0);
});

test('existing panel with a missing or rejected response never causes fallback execution', async () => {
  for (const send of [async () => null, async () => { throw Error('port closed'); }]) {
    const f = fixture({tabs:[{id:2,url:'chrome-extension://test/panel.html'}],send});
    await Promise.all([f.launcher.runScheduledScan(), f.launcher.runScheduledScan()]);
    assert.equal(f.messages.length, 1);
    assert.equal(f.calls.length, 0);
  }
});

test('a later alarm can proceed after the browser is reopened', async () => {
  const windows = [];
  const f = fixture({windows});
  await f.launcher.runScheduledScan();
  windows.push({id:8});
  assert.equal((await f.launcher.runScheduledScan()).ok, true);
  assert.equal(f.calls.length, 1);
});

test('manual opening uses the clicked window and handles create rejection', async () => {
  const f = fixture({windows:[{id:7,focused:true},{id:8}], create:async () => { throw Error('window closed'); }});
  assert.equal((await f.launcher.openPanel(8)).reason, 'open_failed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].windowId, 8);
  assert.equal(f.calls[0].active, true);
});

test('window and tab enumeration failures are contained', async () => {
  const f = fixture();
  f.api.windows.getAll = async () => { throw Error('windows unavailable'); };
  assert.equal((await f.launcher.openPanel()).ok, false);
  f.api.tabs.query = async () => { throw Error('tabs unavailable'); };
  assert.equal((await f.launcher.runScheduledScan()).ok, false);
  assert.equal(f.calls.length, 0);
});
