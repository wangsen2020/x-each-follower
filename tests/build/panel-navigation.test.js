import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { usePanelNavigation, TAB_TITLES, NAV_TABS } from '../../src/entries/panel/composables/usePanelNavigation.js';
import {logsModalController} from '../../src/entries/panel/composables/useExecutionLogs.js';

test('switching modules closes logs and ignores a pending response from the previous module',async()=>{
 const previous=globalThis.chrome;let finish;
 globalThis.chrome={runtime:{sendMessage:()=>new Promise(resolve=>{finish=resolve})}};
 const nav=usePanelNavigation();
 try{
  nav.setTab('unreciprocated');
  const opening=logsModalController.open('unreciprocated');
  while(!finish)await Promise.resolve();
  assert.equal(logsModalController.isOpen.value,true);
  nav.setTab('postTracking');
  assert.equal(logsModalController.isOpen.value,false);
  finish({ok:true,kind:'unfollow',presentationVersion:2,entries:[{id:'late-log'}],total:1});await opening;
  assert.equal(logsModalController.isOpen.value,false);
  assert.equal(logsModalController.rawEntries.value.length,0);
  await logsModalController.refreshIfOpen('unreciprocated');
  assert.equal(logsModalController.isOpen.value,false);
 }finally{logsModalController.close();globalThis.chrome=previous;}
});

test('same-module selection and invalid navigation preserve deliberately opened logs',()=>{
 const nav=usePanelNavigation();nav.setTab('unreciprocated');logsModalController.isOpen.value=true;
 try{
  nav.setTab('unreciprocated');assert.equal(logsModalController.isOpen.value,true);
  nav.setTab('invalid');assert.equal(logsModalController.isOpen.value,true);
  nav.setTab('postTracking');assert.equal(logsModalController.isOpen.value,false);
 }finally{logsModalController.close();}
});

test('usePanelNavigation initializes with default tab and titles', () => {
  const nav = usePanelNavigation();
  assert.equal(nav.activeTab.value, 'monitor');
  assert.equal(nav.currentTitle.value, '粉丝跟进');
  assert.equal(nav.version.value, JSON.parse(readFileSync(new URL('../../src/manifest.json', import.meta.url))).version);
  assert.equal(nav.tabs.length, 9);
  assert.equal(nav.tabs.find(tab => tab.key === 'mutualComments')?.label, '互粉评论');
  assert.equal(TAB_TITLES.knowledge, '知识库');
  assert.equal(TAB_TITLES.postTracking, '帖子追踪');
  assert.equal(TAB_TITLES.leaderboard, 'X 榜单');
});

test('TAB_TITLES maps all 5 panels correctly', () => {
  assert.equal(TAB_TITLES.monitor, '粉丝跟进');
  assert.equal(TAB_TITLES.candidates, '互关追踪');
  assert.equal(TAB_TITLES.comments, '评论追踪');
  assert.equal(TAB_TITLES.followQueue, '关注队列');
  assert.equal(TAB_TITLES.unreciprocated, '回关监控');
});

test('NAV_TABS correctly configures badge presence for panels', () => {
  const monitorTab = NAV_TABS.find(t => t.key === 'monitor');
  assert.equal(monitorTab?.hasBadge, true);
  assert.equal(monitorTab?.badgeId, 'queueCount');

  const candidatesTab = NAV_TABS.find(t => t.key === 'candidates');
  assert.equal(candidatesTab?.hasBadge, true);
  assert.equal(candidatesTab?.badgeId, 'mutualNetworkCount');

  const commentsTab = NAV_TABS.find(t => t.key === 'comments');
  assert.equal(commentsTab?.hasBadge, true);
  assert.equal(commentsTab?.badgeId, 'commentTrackingCount');

  const queueTab = NAV_TABS.find(t => t.key === 'followQueue');
  assert.equal(queueTab?.hasBadge, false);
  assert.equal(queueTab?.badgeId, null);

  const unreciprocatedTab = NAV_TABS.find(t => t.key === 'unreciprocated');
  assert.equal(unreciprocatedTab?.hasBadge, true);
  assert.equal(unreciprocatedTab?.badgeId, 'unreciprocatedCount');
});

test('setTab reactively updates activeTab and title, ignoring invalid tabs', () => {
  const nav = usePanelNavigation();

  nav.setTab('candidates');
  assert.equal(nav.activeTab.value, 'candidates');
  assert.equal(nav.currentTitle.value, '互关追踪');

  nav.setTab('comments');
  assert.equal(nav.activeTab.value, 'comments');
  assert.equal(nav.currentTitle.value, '评论追踪');

  nav.setTab('followQueue');
  assert.equal(nav.activeTab.value, 'followQueue');
  assert.equal(nav.currentTitle.value, '关注队列');

  nav.setTab('unreciprocated');
  assert.equal(nav.activeTab.value, 'unreciprocated');
  assert.equal(nav.currentTitle.value, '回关监控');

  nav.setTab('monitor');
  assert.equal(nav.activeTab.value, 'monitor');
  assert.equal(nav.currentTitle.value, '粉丝跟进');

  // Invalid tab ignored
  nav.setTab('nonExistentTab');
  assert.equal(nav.activeTab.value, 'monitor');
  assert.equal(nav.currentTitle.value, '粉丝跟进');
});

test('updateBadge reactively sets counts and loading status', () => {
  const nav = usePanelNavigation();

  nav.updateBadge('monitor', { count: 42, loading: false });
  assert.equal(nav.badges.monitor.count, 42);
  assert.equal(nav.badges.monitor.loading, false);

  nav.updateBadge('candidates', { count: 120, loading: false });
  assert.equal(nav.badges.candidates.count, 120);
  assert.equal(nav.badges.candidates.loading, false);

  nav.updateBadge('unreciprocated', { count: null, loading: true });
  assert.equal(nav.badges.unreciprocated.count, null);
  assert.equal(nav.badges.unreciprocated.loading, true);

  // Updating non-existent badge is safely ignored
  nav.updateBadge('unknownKey', { count: 99 });
  assert.equal(nav.badges.unknownKey, undefined);
});
