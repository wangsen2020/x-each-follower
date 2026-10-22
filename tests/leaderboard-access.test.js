import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canUseLeaderboardAction} from '../src/features/leaderboard/leaderboard-access.js';

const runtimeId = 'extension-id';
const panelUrl = `chrome-extension://${runtimeId}/panel.html`;
const allowed = (sender, action) => canUseLeaderboardAction({runtimeId, panelUrl, sender, action});

test('settings are writable from the panel but not from X content or unrelated pages', () => {
  assert.equal(allowed({id:runtimeId,url:panelUrl}, 'settings'), true);
  assert.equal(allowed({id:runtimeId,url:`${panelUrl}?tab=leaderboard`}, 'settings'), true);
  assert.equal(allowed({id:runtimeId,url:'https://x.com/home',tab:{id:42}}, 'settings'), false);
  assert.equal(allowed({id:'another-extension',url:panelUrl}, 'settings'), false);
  assert.equal(allowed({id:runtimeId,url:`chrome-extension://${runtimeId}/popup.html`}, 'settings'), false);
});

test('X content may change membership while panel-only scan and settings stay protected', () => {
  const content={id:runtimeId,url:'https://x.com/writer/status/123',tab:{id:42}};
  assert.equal(allowed(content, 'membership'), true);
  assert.equal(allowed(content, 'add'), true);
  assert.equal(allowed(content, 'remove'), true);
  assert.equal(allowed(content, 'scan'), false);
  assert.equal(allowed({...content,tab:undefined}, 'add'), false);
  assert.equal(allowed({...content,url:'https://example.com/x.com/writer'}, 'add'), false);
});
