import test from 'node:test';
import assert from 'node:assert/strict';
import {notificationSource, panelSourcePath, panelSourceTab, createNotificationClickHandler} from '../src/shared/notification-source.js';

test('notification IDs resolve without in-memory state and routes reject unknown targets', () => {
  for (const [prefix, tab] of [['xf-health-logs','followQueue'],['xf-health-unfollow','unreciprocated'],['follow-queue-', 'followQueue'], ['x-comment-auto-', 'comments'], ['x-mutual-auto-', 'candidates'], ['x-unreciprocated-', 'unreciprocated']]) {
    assert.equal(notificationSource(prefix + '123').tab, tab);
    assert.equal(panelSourceTab(new URL(panelSourcePath(tab), 'https://test/').search), tab);
  }
  assert.equal(notificationSource('foreign-id'), null);
  assert.equal(panelSourceTab('?tab=javascript:alert(1)'), null);
  assert.equal(panelSourcePath('https://evil.test'), 'panel.html');
});

test('click opens the source and clears only after successful navigation', async () => {
  const calls = [];
  let success = true;
  const handler = createNotificationClickHandler({
    api: {notifications:{clear:async id => calls.push(['clear', id])}},
    launcher:{openPanel:async (window, tab) => {calls.push(['open', window, tab]); return {ok:success};}},
    openVerification:async () => {calls.push(['verification']); return {ok:true};},
    openGrok:async () => {calls.push(['grok']); return {ok:true};}
  });
  await handler('follow-queue-123');
  assert.deepEqual(calls, [['open', undefined, 'followQueue'], ['clear', 'follow-queue-123']]);
  calls.length = 0; success = false;
  await handler('x-comment-auto-123');
  assert.deepEqual(calls, [['open', undefined, 'comments']]);
  calls.length = 0;
  await handler('xf-grok-verification'); await handler('xf-grok-intervention');
  assert.deepEqual(calls, [['verification'], ['clear','xf-grok-verification'], ['grok'], ['clear','xf-grok-intervention']]);
  calls.length = 0;
  await handler('unknown'); assert.deepEqual(calls, []);
});

test('click contains open errors and preserves the notification', async () => {
  let warned = false;
  const handler = createNotificationClickHandler({
    api:{notifications:{clear:async () => assert.fail('must retain notification')}},
    launcher:{openPanel:async () => {throw Error('window closed');}}, warn:() => {warned = true;}
  });
  await handler('follow-queue-123'); assert.equal(warned, true);
});
