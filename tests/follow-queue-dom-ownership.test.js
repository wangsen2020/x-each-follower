import test from 'node:test';
import assert from 'node:assert/strict';
import { openFollowQueue } from '../src/entries/panel/follow-queue-entry.js';

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.isConnected = true;
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  addEventListener() {}
}

function fixture(identity) {
  const host = new FakeNode('div');
  const load = new FakeNode('div');
  const error = new FakeNode('div');
  const root = {
    children: [load, error, host],
    querySelector: selector => selector === '#followQueueContent' ? host : null,
    replaceChildren: () => { throw new Error('Vue-owned section must not be replaced'); }
  };
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;
  globalThis.document = {
    createElement: tag => new FakeNode(tag),
    createTextNode: text => ({textContent: text})
  };
  globalThis.chrome = {runtime: {sendMessage: async () => identity}};
  return {
    root, host, load, error,
    restore() {
      globalThis.document = originalDocument;
      globalThis.chrome = originalChrome;
    }
  };
}

test('follow queue renders into its content host and preserves Vue load/error nodes', async () => {
  const view = fixture({ok:true, handle:'owner', accountId:'owner', binding:{activated:false}});
  try {
    assert.equal((await openFollowQueue(view.root)).ok, true);
    assert.deepEqual(view.root.children, [view.load, view.error, view.host]);
    assert.equal(view.host.children.length, 4);
    assert.equal(view.host.children[0].className, 'follow-queue-setup');
  } finally { view.restore(); }
});

test('follow queue identity errors preserve Vue nodes and show retry in the content host', async () => {
  const view = fixture({ok:false, error:'账号未识别'});
  try {
    assert.deepEqual(await openFollowQueue(view.root), {ok:false, error:'账号未识别'});
    assert.deepEqual(view.root.children, [view.load, view.error, view.host]);
    assert.equal(view.host.children[0].className, 'queue-onboarding');
  } finally { view.restore(); }
});
