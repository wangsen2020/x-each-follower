import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createProfileTab} from '../src/platform/x/profile-access.js';

const source = readFileSync(new URL('../src/entries/background/background.js', import.meta.url), 'utf8');
const collector = source.slice(source.indexOf('async function collectTweetReplies('), source.indexOf('export const BACKGROUND_BUILD_VERSION'));

for (const sourceTab of [{windowId:42}, {windowId:0}, undefined]) {
  test(`comment collector creates a valid inactive tab with source ${JSON.stringify(sourceTab)}`, async () => {
    const jobs = new Map(), calls = [], removed = [], statuses = [];
    const url = 'https://x.com/writer/status/123';
    const api = {tabs:{
      create:async options => {
        assert.deepEqual(Object.keys(options).sort(), sourceTab ? ['active','url','windowId'] : ['active','url']);
        assert.equal(options.active, false);
        assert.equal(options.url, url);
        assert.equal(options.windowId, sourceTab?.windowId);
        return {id:91};
      },
      remove:async id => removed.push(id)
    }};
    const context = vm.createContext({
      chrome:api, commentJobs:jobs,
      createProfileTab:async (chrome, options, source) => { calls.push(source); return createProfileTab(chrome, options, source); },
      updateCommentStatus:async status => statuses.push(status),
      waitForTweetTemplate:async id => { assert.equal(id,91); throw new Error('template sentinel'); }
    });
    vm.runInContext(collector, context);
    await context.collectTweetReplies('123', url, 'writer', sourceTab);
    await jobs.get('123');
    assert.deepEqual(calls, ['comment-tracking']);
    assert.equal(statuses.at(-1).message, 'template sentinel');
    assert.deepEqual(removed, [91]);
    assert.equal(jobs.size, 0);
  });
}
