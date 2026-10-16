import { normalizeHandle, parseCount, assess, riskAssess, evaluateMutualProfile, parseGrokMutualAnalysis, filterMutualTrackingUsers, selectValuableMutualTargets, csv, formatPageSummary, repairMojibake } from './scoring.js';
import { collectVisible, readProfile, readProfileBundle, scanFollowers, simulateProfileScrollStep, clickAnyFollowOnProfile } from './page-reader.js';
import { networkFetch, networkFollow, networkUnfollow, parseNetworkUsers, findCursor, personalRelationshipLabel, mutualUserCategory, reconcileFollowBackQueue, addUniqueUsersUpTo, mergeRecentPosts, isUsableNetworkTemplate as templateIsUsable } from './network-api.js';
import { durableGet, durableSet } from './persistent-db.js';

const $ = id => document.getElementById(id);
let rows = [];
let inspectionTab;
let monitor = {enabled:false, every:60, jitter:15, users:[], queue:[], followingUsers:[], followingListComplete:false, lastScan:null, checkpointHandle:null, checkpointAt:null};
let analysisRows = [];
let profileCache = {};
let followerScanRunning = false;
let activeFollowerTab = 'following';
let selectedFollowerHandles = new Set();
let followerPage = 1;
let followerPageSize = 20;
let followerSearch = '';
let drawerUser = null;
let drawerMode = 'profile';
let drawerLoading = false;
const defaultMutualAutoFollow = () => ({
  enabled: false,
  every: 5,
  jitter: 3,
  batchLimit: 10,
  scrollRounds: 5,
  dwellSeconds: 15,
  minFollowers: 50,
  onlyMutualIntent: true,
  grokAutoComment: false,
  processedHandles: [],
  followedCount: 0,
  lastRunAt: null,
  lastSummary: ''
});
function normalizeAutoFollowConfig(cfg = {}) {
  const defaults = defaultMutualAutoFollow();
  const res = { ...defaults, ...cfg };
  if (res.every === 45) res.every = defaults.every;
  if (res.jitter === 15) res.jitter = defaults.jitter;
  if (res.batchLimit === 3) res.batchLimit = defaults.batchLimit;
  if (res.scrollRounds === 3) res.scrollRounds = defaults.scrollRounds;
  if (res.dwellSeconds === 6) res.dwellSeconds = defaults.dwellSeconds;
  res.grokAutoComment = Boolean(res.grokAutoComment);
  return res;
}

function debounce(fn, delay = 300) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

async function persistAutoFollowSettings(type, cfg) {
  const localKey = type === 'mutual' ? 'mutualAutoFollowSettings' : 'commentAutoFollowSettings';
  const lsKey = type === 'mutual' ? 'x_mutualAutoFollowSettings' : 'x_commentAutoFollowSettings';
  const normalized = normalizeAutoFollowConfig(cfg);

  // 1. chrome.storage.local
  await chrome.storage.local.set({ [localKey]: normalized }).catch(() => {});

  // 2. localStorage 兜底
  try {
    localStorage.setItem(lsKey, JSON.stringify(normalized));
  } catch {}

  // 3. chrome.storage.sync 跨卸载/重装持久化
  try {
    if (chrome.storage?.sync) {
      await chrome.storage.sync.set({ [localKey]: normalized }).catch(() => {});
    }
  } catch {}

  // 4. x.com 域 IndexedDB 跨扩展重装生存
  persist(localKey, normalized);
}

async function loadPersistedAutoFollowSettings(type) {
  const localKey = type === 'mutual' ? 'mutualAutoFollowSettings' : 'commentAutoFollowSettings';
  const lsKey = type === 'mutual' ? 'x_mutualAutoFollowSettings' : 'x_commentAutoFollowSettings';

  // 1. chrome.storage.local
  try {
    const local = await chrome.storage.local.get(localKey);
    if (local && local[localKey]) return normalizeAutoFollowConfig(local[localKey]);
  } catch {}

  // 2. localStorage
  try {
    const raw = localStorage.getItem(lsKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed) return normalizeAutoFollowConfig(parsed);
    }
  } catch {}

  // 3. chrome.storage.sync
  try {
    if (chrome.storage?.sync) {
      const syncData = await chrome.storage.sync.get(localKey);
      if (syncData && syncData[localKey]) return normalizeAutoFollowConfig(syncData[localKey]);
    }
  } catch {}

  // 4. x.com 域 IndexedDB
  try {
    const durable = await durableGet(localKey);
    if (durable) return normalizeAutoFollowConfig(durable);
  } catch {}

  return null;
}
let mutualNetwork = {anchor:'', anchors:[], users:[], lastCollected:null, autoFollow: defaultMutualAutoFollow()};
let selectedMutualHandles = new Set();
let mutualSearch = '';
let mutualAutoRunning = false;
let commentTracking = {users:[], posts:[]};
const defaultCommentAutoFollow = () => {
  const mutualDefaults = {...defaultMutualAutoFollow(), ...(mutualNetwork.autoFollow || {})};
  return normalizeAutoFollowConfig({enabled:false, every:mutualDefaults.every, jitter:mutualDefaults.jitter, batchLimit:mutualDefaults.batchLimit, scrollRounds:mutualDefaults.scrollRounds, dwellSeconds:mutualDefaults.dwellSeconds, minFollowers:mutualDefaults.minFollowers, onlyMutualIntent:mutualDefaults.onlyMutualIntent, lastRunAt:null, lastSummary:''});
};
let commentTrackingStatus = null;
let autoFollowLogs = [];
let unreciprocatedTracker = {
  users: [],
  config: {
    enabled: false,
    every: 60,
    jitter: 10,
    overdueDays: 14,
    autoUnfollow: false,
    batchLimit: 10,
    unfollowDelay: 3,
    whitelist: '',
    lastRunAt: null,
    lastSummary: '尚未执行回关监测'
  },
  updatedAt: ''
};
let unreciprocatedLogs = [];
let activeUnreciprocatedTab = 'overdue';
let unreciprocatedSearch = '';
let unreciprocatedPage = 1;
let unreciprocatedPageSize = 50;
const selectedUnreciprocatedHandles = new Set();
let unreciprocatedCheckRunning = false;
let unreciprocatedUnfollowRunning = false;
let unreciprocatedUnfollowStopped = false;
const unreciprocatedBusy = new Set();
let activeGrokStreamResolver = null;
let activeCommentFilter = 'notMutual';
let commentPage = 1;
let commentPageSize = 20;
let commentSearch = '';
const MAX_FOLLOWER_SCAN = 3000;
let mutualNetworkRunning = false;
const followBackBusy = new Set();
const unfollowBusy = new Set();
let unfollowRunning = false;
let unfollowStopped = false;
const profileRefreshBusy = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const status = text => { const root = $('status') || $('networkStatus'); if (root) root.textContent = text; };
const monitorStatus = text => { $('monitorStatus').textContent = text; };
const analysisStatus = text => monitorStatus(text);

const monitorActionIcons = {
  follow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>',
  unfollow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" y1="11" x2="23" y2="11"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0 1.4 4.5M20 4v7h-7"/></svg>',
  profile: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.25"/><path d="M5.5 20c.55-3.4 3.05-5.25 6.5-5.25S17.95 16.6 18.5 20"/></svg>',
  expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="12" r="3"/><path d="M6 9v6"/><path d="m8.5 7.5 7 3.5"/><path d="m8.5 16.5 7-3.5"/></svg>',
  posts: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>'
};

function monitorIconButton(icon, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary monitor-icon-button';
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
  button.innerHTML = monitorActionIcons[icon] || '';
  return button;
}

function setMonitorIconButtonState(button, busy, label) {
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
  button.classList.toggle('is-busy', busy);
}

function cleanFollowerBio(user) {
  const cached = profileCache[user.handle?.toLowerCase()]?.bio;
  let text = (cached && cached.trim()) ? cached.trim() : String(user.bio || '').trim();
  text = repairMojibake(text);
  if (!text) return '暂无简介';
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const handleLower = `@${String(user.handle || '').toLowerCase()}`;
  const nameLower = String(user.name || '').toLowerCase();
  const cleanLines = lines.filter(line => {
    const l = line.toLowerCase();
    if (l === handleLower || l === user.handle?.toLowerCase()) return false;
    if (nameLower && l === nameLower) return false;
    if (/^(follows you|following|follow back|关注你|正在关注|回关|关注|等待回应)$/i.test(l)) return false;
    return true;
  });
  const result = cleanLines.join(' ').trim();
  return result || '暂无简介';
}

function setTab(tab) {
  document.querySelectorAll('.nav-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(panel => { panel.hidden = panel.dataset.panel !== tab; });
  const h1 = document.querySelector('main > header > h1');
  if (h1) h1.textContent = {monitor:'粉丝管理', candidates:'互关追踪', comments:'评论追踪', unreciprocated:'回关监测'}[tab] || '粉丝管理';
  if (tab === 'unreciprocated') {
    syncAllActiveFollowedUsers();
    renderUnreciprocatedUI();
  }
}
document.querySelectorAll('.nav-tab').forEach(button => button.addEventListener('click', () => setTab(button.dataset.tab)));
document.addEventListener('click', event => { if (event.target.closest('.info-tip')) event.preventDefault(); });
const persist = (key, value) => durableSet(key, value).catch(() => {});

function commentRelationship(user) {
  const key = String(user.handle || '').toLowerCase();
  const following = ownFollowingHandles().has(key) || user.relationship?.following === true;
  const followedBy = ownFollowerHandles().has(key) || user.relationship?.followedBy === true;
  return following && followedBy ? '互相关注' : '未互关';
}

async function saveCommentTracking() {
  await chrome.storage.local.set({commentTracking});
  persist('commentTracking', commentTracking);
}

function archiveCommentRecentPosts(profile) {
  const key = String(profile?.handle || '').toLowerCase();
  const user = (commentTracking.users || []).find(item => String(item.handle || '').toLowerCase() === key);
  if (!user || !(profile.posts || []).length) return false;
  user.recentPosts = mergeRecentPosts(user.recentPosts || [], profile.posts, 100);
  user.recentPostsFetchedAt = new Date().toISOString();
  user.recentPostsCount = user.recentPosts.length;
  return true;
}

function getCommentAutoFollow() {
  return normalizeAutoFollowConfig(commentTracking.autoFollow || {});
}

async function saveCommentAutoFollowSettings() {
  const current = getCommentAutoFollow();
  const next = {
    ...current,
    enabled: Boolean($('commentAutoEnabled')?.checked),
    every: Number($('commentAutoEvery')?.value || 5),
    jitter: Number($('commentAutoJitter')?.value || 0),
    batchLimit: Math.max(1, Math.min(20, Number($('commentAutoBatchSize')?.value || 10))),
    scrollRounds: Math.max(1, Math.min(8, Number($('commentAutoScrollRounds')?.value || 5))),
    dwellSeconds: Math.max(2, Math.min(60, Number($('commentAutoDwellSec')?.value || 15))),
    minFollowers: Math.max(0, Number($('commentAutoMinFollowers')?.value ?? 50)),
    onlyMutualIntent: $('commentAutoOnlyIntent') ? $('commentAutoOnlyIntent').checked : true,
    grokAutoComment: Boolean($('commentAutoGrokComment')?.checked)
  };
  if (!Number.isFinite(next.every) || next.every < 5) throw new Error('评论追踪定时周期至少 5 分钟。');
  if (!Number.isFinite(next.jitter) || next.jitter < 0 || next.jitter >= next.every) throw new Error('随机浮动必须大于等于 0 且小于定时周期。');
  commentTracking.autoFollow = next;
  await saveCommentTracking();
  await persistAutoFollowSettings('comment', next);
  await chrome.runtime.sendMessage({cmd:'configureCommentAutoFollow', config:next}).catch(() => {});
  renderCommentAutoFollowSettings();
}

function renderCommentAutoFollowSettings() {
  const cfg = getCommentAutoFollow();
  if ($('commentAutoEnabled')) $('commentAutoEnabled').checked = !!cfg.enabled;
  if ($('commentAutoEvery')) $('commentAutoEvery').value = cfg.every;
  if ($('commentAutoJitter')) $('commentAutoJitter').value = cfg.jitter;
  if ($('commentAutoBatchSize')) $('commentAutoBatchSize').value = cfg.batchLimit;
  if ($('commentAutoScrollRounds')) $('commentAutoScrollRounds').value = cfg.scrollRounds;
  if ($('commentAutoDwellSec')) $('commentAutoDwellSec').value = cfg.dwellSeconds;
  if ($('commentAutoMinFollowers')) $('commentAutoMinFollowers').value = cfg.minFollowers;
  if ($('commentAutoOnlyIntent')) $('commentAutoOnlyIntent').checked = cfg.onlyMutualIntent !== false;
  if ($('commentAutoGrokComment')) $('commentAutoGrokComment').checked = Boolean(cfg.grokAutoComment);
  if ($('commentAutoSummary')) $('commentAutoSummary').textContent = cfg.lastSummary || '尚未执行评论用户定时关注';
  if ($('commentAutoLastTime')) $('commentAutoLastTime').textContent = cfg.lastRunAt ? `最近执行：${new Date(cfg.lastRunAt).toLocaleString()}` : '';
}

function openCommentAutoFollowSettings() {
  closeProfileDrawer(); closeSettingsDrawer(); closeMutualSettingsDrawer();
  renderCommentAutoFollowSettings();
  $('commentAutoFollowDrawer').hidden = false;
  syncDrawerMask();
}

async function runCommentAutoFollowNow() {
  const result = await chrome.runtime.sendMessage({cmd:'runCommentAutoFollowNow'}).catch(error => ({ok:false, error:error.message}));
  $('commentTrackingStatus').textContent = result?.ok ? result.summary || '评论用户自动关注任务已完成。' : `任务未启动：${result?.error || '后台不可用'}`;
}

async function followCommentUser(user, button) {
  const key = String(user?.handle || '').toLowerCase();
  if (!key || user.followedAt || followBackBusy.has(key)) return;
  followBackBusy.add(key);
  setMonitorIconButtonState(button, true, '关注中…');
  try {
    const tabId = await backgroundXActionTab();
    const result = await followViaNetwork(tabId, user);
    if (result.ok || result.reason === 'already_following') {
      const item = (commentTracking.users || []).find(u => String(u.handle).toLowerCase() === key) || user;
      item.followedAt = new Date().toISOString();
      item.followSource = 'comment';
      item.relationship = {...(item.relationship || {}), following: true};
      delete item.followFailureReason;
      item.autoFollowState = 'followed'; delete item.autoFollowReason;
      await saveCommentTracking();
    } else {
      const item = (commentTracking.users || []).find(u => String(u.handle).toLowerCase() === key) || user;
      item.followFailedAt = new Date().toISOString();
      item.followFailureReason = result.error || result.reason || '关注请求未完成';
      await saveCommentTracking();
      $('commentTrackingStatus').textContent = `@${item.handle} 关注失败：${item.followFailureReason}`;
    }
  } catch (error) { $('commentTrackingStatus').textContent = `关注失败：${error.message}`; }
  finally { followBackBusy.delete(key); renderCommentTracking(); }
}

// 回关核验：已关注且对方出现在自己的粉丝列表时记录回关时间
function verifyCommentFollowBacks() {
  let changed = false;
  for (const user of commentTracking.users || []) {
    if (user.followedAt && !user.followBackAt && ownFollowerHandles().has(String(user.handle || '').toLowerCase())) {
      user.followBackAt = new Date().toISOString(); changed = true;
    }
  }
  if (changed) saveCommentTracking().catch(() => {});
}

function filteredCommentUsers() {
  const keyword = commentSearch.trim().toLowerCase();
  return (commentTracking.users || []).filter(user => {
    if (activeCommentFilter === 'notMutual' && commentRelationship(user) === '互相关注') return false;
    if (!keyword) return true;
    const replies = (user.sources || []).flatMap(source => (source.replies || []).map(reply => reply.text || '')).join(' ');
    const sources = (user.sources || []).map(source => `${source.url || ''} ${source.postAuthor || ''}`).join(' ');
    return [user.handle, user.name, user.bio, replies, sources].some(value => String(value || '').toLowerCase().includes(keyword));
  }).sort((a,b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')) || String(a.handle).localeCompare(String(b.handle)));
}

function renderCommentTracking() {
  const list = $('commentUsersList');
  if (!list) return;
  const table = $('commentUsersTable');
  const users = commentTracking.users || [];
  verifyCommentFollowBacks();
  const notMutualCount = users.filter(user => commentRelationship(user) !== '互相关注').length;
  $('commentTrackingCount').textContent = String(users.length);
  $('commentsUserCount').textContent = `${users.length} 位用户 · ${(commentTracking.posts || []).length} 个帖子`;
  $('commentAllCount').textContent = String(users.length);
  $('commentNotMutualCount').textContent = String(notMutualCount);
  document.querySelectorAll('[data-comment-filter]').forEach(button => {
    const active = button.dataset.commentFilter === activeCommentFilter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  const statusText = commentTrackingStatus?.message || (commentTracking.posts?.length ? `已保存 ${users.length} 位评论用户，来源于 ${(commentTracking.posts || []).length} 个帖子。` : '在 X 帖子旁点击评论图标，静默收集评论用户。');
  $('commentTrackingStatus').textContent = statusText;
  const filtered = filteredCommentUsers();
  const totalPages = Math.max(1, Math.ceil(filtered.length / commentPageSize));
  commentPage = Math.min(Math.max(1, commentPage), totalPages);
  const from = (commentPage - 1) * commentPageSize;
  const pageUsers = filtered.slice(from, from + commentPageSize);
  $('commentPageSummary').textContent = filtered.length ? `${commentPage} / ${totalPages} 页 · ${filtered.length} 条` : '0 条';
  $('commentPrevPage').disabled = commentPage <= 1;
  $('commentNextPage').disabled = commentPage >= totalPages;
  $('commentPageSize').value = String(commentPageSize);
  const empty = $('commentUsersEmpty');
  empty.hidden = users.length > 0 && pageUsers.length > 0;
  if (users.length > 0 && pageUsers.length === 0) {
    empty.querySelector('strong').textContent = '没有匹配的评论用户';
    empty.querySelector('span').textContent = '调整搜索词或切换筛选条件后重试。';
  } else {
    empty.querySelector('strong').textContent = '还没有评论用户';
    empty.querySelector('span').textContent = '打开 X，在帖子操作栏点击评论追踪图标开始收集。';
  }
  table.hidden = pageUsers.length === 0;
  list.replaceChildren();
  for (const user of pageUsers) {
    const key = String(user.handle || '').toLowerCase();
    const cached = profileCache[key];
    const row = document.createElement('tr');
    const account = document.createElement('td');
    account.className = 'col-account';
    const profile = document.createElement('a');
    profile.href = `https://x.com/${encodeURIComponent(user.handle)}`;
    profile.target = '_blank'; profile.rel = 'noopener noreferrer';
    profile.textContent = `${repairMojibake(cached?.name || user.name || user.handle)} · @${user.handle}`;
    const bio = document.createElement('p');
    bio.textContent = repairMojibake(cached?.bio || user.bio || '暂无简介');
    account.append(profile, bio);
    row.append(account);

    const sourceCell = document.createElement('td');
    sourceCell.className = 'col-source';
    const sources = document.createElement('div');
    sources.className = 'comment-source-list';
    for (const source of user.sources || []) {
      const link = document.createElement('a');
      link.className = 'comment-source-link';
      link.href = source.url;
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      const replyCount = source.replies?.length || 0;
      link.textContent = `@${source.postAuthor || 'source'} · ${replyCount} 条评论`;
      link.title = source.url;
      sources.append(link);
    }
    if (!sources.childElementCount) sources.textContent = '来源记录缺失';
    sourceCell.append(sources);
    row.append(sourceCell);

    const relation = document.createElement('td');
    relation.className = 'col-relation';
    const relationLabel = commentRelationship(user);
    const relationBadge = document.createElement('span');
    relationBadge.className = `badge ${relationLabel === '互相关注' ? 'candidate' : 'review'}`;
    relationBadge.textContent = relationLabel;
    relation.append(relationBadge);
    row.append(relation);

    for (const value of [cached?.followersText || user.followersText || '未读取', cached?.followingText || user.followingText || '未读取']) {
      const count = document.createElement('td');
      count.className = 'col-count';
      count.textContent = value;
      row.append(count);
    }

    const followCell = document.createElement('td');
    followCell.className = 'col-count col-record';
    if (user.followedAt) {
      const back = commentRelationship(user) === '互相关注' || user.followBackAt;
      followCell.textContent = `${new Date(user.followedAt).toLocaleString()} · ${back ? '已回关' : '待回关'}`;
    } else if (user.autoFollowState === 'skipped') followCell.textContent = `已跳过：${user.autoFollowReason || '未达到条件'}`;
    else followCell.textContent = user.followFailureReason ? `关注失败：${user.followFailureReason}` : '未关注';
    row.append(followCell);

    const actions = document.createElement('td');
    actions.className = 'col-actions';
    const postsButton = monitorIconButton('posts', '查看近期帖子');
    postsButton.addEventListener('click', () => openCommentRecentPostsDrawer(user));
    const profileButton = monitorIconButton('profile', '查看资料');
    profileButton.addEventListener('click', () => openProfileDrawer(user));
    const followButton = monitorIconButton('follow', user.followedAt ? '已关注' : '关注');
    followButton.disabled = !!user.followedAt || user.relationship?.following === true;
    followButton.addEventListener('click', () => followCommentUser(user, followButton));
    actions.append(postsButton, followButton, profileButton);
    row.append(actions);
    list.append(row);
  }
}

document.querySelectorAll('[data-comment-filter]').forEach(button => button.addEventListener('click', () => {
  activeCommentFilter = button.dataset.commentFilter;
  commentPage = 1;
  renderCommentTracking();
}));
$('commentSearch')?.addEventListener('input', event => { commentSearch = event.target.value; commentPage = 1; renderCommentTracking(); });
$('commentSearchBtn')?.addEventListener('click', () => { commentSearch = $('commentSearch').value.trim(); commentPage = 1; renderCommentTracking(); });
$('commentSearch')?.addEventListener('keydown', event => { if (event.key === 'Enter') { commentSearch = event.target.value.trim(); commentPage = 1; renderCommentTracking(); } });
$('commentPageSize')?.addEventListener('change', event => { commentPageSize = Number(event.target.value) || 20; commentPage = 1; renderCommentTracking(); });
$('commentPrevPage')?.addEventListener('click', () => { commentPage--; renderCommentTracking(); });
$('commentNextPage')?.addEventListener('click', () => { commentPage++; renderCommentTracking(); });
$('openCommentAutoFollowSettings')?.addEventListener('click', openCommentAutoFollowSettings);
$('closeCommentAutoFollowDrawer')?.addEventListener('click', closeCommentAutoFollowDrawer);
$('commentAutoEnabled')?.addEventListener('change', () => saveCommentAutoFollowSettings().catch(error => { $('commentTrackingStatus').textContent = error.message; }));
const debouncedSaveComment = debounce(() => saveCommentAutoFollowSettings().catch(() => {}), 300);
for (const id of ['commentAutoEvery', 'commentAutoJitter', 'commentAutoBatchSize', 'commentAutoScrollRounds', 'commentAutoDwellSec', 'commentAutoMinFollowers', 'commentAutoOnlyIntent', 'commentAutoGrokComment']) {
  $(id)?.addEventListener('change', () => saveCommentAutoFollowSettings().catch(error => { $('commentTrackingStatus').textContent = error.message; }));
  $(id)?.addEventListener('input', debouncedSaveComment);
}
$('saveCommentAutoSettings')?.addEventListener('click', () => saveCommentAutoFollowSettings().then(() => { $('commentTrackingStatus').textContent = '评论追踪自动关注配置已保存。'; }).catch(error => { $('commentTrackingStatus').textContent = error.message; }));
$('runCommentAutoNow')?.addEventListener('click', runCommentAutoFollowNow);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.commentTracking) commentTracking = changes.commentTracking.newValue || {users:[], posts:[]};
  if (changes.commentTrackingStatus) commentTrackingStatus = changes.commentTrackingStatus.newValue || null;
  if (changes.autoFollowLogs) { autoFollowLogs = changes.autoFollowLogs.newValue || []; renderLogsModal(); }
  if (changes.commentTracking || changes.commentTrackingStatus || changes.monitor) { renderCommentTracking(); renderCommentAutoFollowSettings(); }
});
function monitorUserStatus(user) {
  if (user.state === 'following' || user.relationship?.following === true) return 'following';
  return (monitor.queue || []).find(item => item.handle?.toLowerCase() === user.handle?.toLowerCase())?.status || 'saved';
}
function getNotMutualUsers() {
  const followerHandles = new Set((monitor.users || []).map(u => u.handle.toLowerCase()));
  const candidates = new Map();

  const formatCandidate = (u) => {
    const key = u.handle.toLowerCase();
    const cached = profileCache[key];
    const name = repairMojibake(cached?.name || u.name || u.handle);
    const bio = repairMojibake(cached?.bio || u.bio || '');
    return {
      ...u,
      name,
      bio,
      followersText: cached?.followersText || u.followersText || '',
      followingText: cached?.followingText || u.followingText || '',
      avatarUrl: cached?.avatarUrl || u.avatarUrl || '',
      notMutual: true,
      status: 'not_mutual'
    };
  };

  for (const user of (monitor.followingUsers || [])) {
    if (!user?.handle) continue;
    const key = user.handle.toLowerCase();
    const followedBy = user.relationship?.followedBy;
    if (followedBy === false || (followedBy !== true && !followerHandles.has(key))) {
      candidates.set(key, formatCandidate(user));
    }
  }

  for (const user of (monitor.users || [])) {
    if (!user?.handle) continue;
    const key = user.handle.toLowerCase();
    if (candidates.has(key)) continue;
    if (user.relationship?.following === true && user.relationship?.followedBy === false) {
      candidates.set(key, formatCandidate(user));
    }
  }

  for (const user of (mutualNetwork.users || [])) {
    if (!user?.handle) continue;
    const key = user.handle.toLowerCase();
    if (candidates.has(key)) continue;
    if (user.relationship?.following === true && (user.relationship?.followedBy === false || (!user.relationship?.followedBy && !followerHandles.has(key)))) {
      candidates.set(key, formatCandidate(user));
    }
  }

  return [...candidates.values()];
}

function removeUnfollowedUser(key) {
  const k = String(key || '').toLowerCase();
  if (!k) return;
  if (monitor.followingUsers) {
    monitor.followingUsers = monitor.followingUsers.filter(u => u.handle.toLowerCase() !== k);
  }
  for (const u of (monitor.users || [])) {
    if (u.handle.toLowerCase() === k) {
      if (u.relationship) u.relationship.following = false;
      u.state = 'unfollowed';
    }
  }
  for (const u of (mutualNetwork.users || [])) {
    if (u.handle.toLowerCase() === k) {
      if (u.relationship) u.relationship.following = false;
    }
  }
  for (const u of (monitor.queue || [])) {
    if (u.handle.toLowerCase() === k) {
      if (u.relationship) u.relationship.following = false;
    }
  }
  selectedFollowerHandles.delete(k);
}

function currentFollowerUsers() {
  let source;
  if (activeFollowerTab === 'notMutual') {
    source = getNotMutualUsers();
  } else if (activeFollowerTab === 'followBack') {
    source = (monitor.queue || []).filter(user => user.status !== 'followed' && user.state !== 'following' && user.relationship?.following !== true);
  } else {
    source = (monitor.users || []).filter(user => user.state === 'following' || monitorUserStatus(user) === 'followed').map(user => ({...user, status:monitorUserStatus(user)}));
  }
  return [...source].sort((a,b) => String(b.discoveredAt || '').localeCompare(String(a.discoveredAt || '')));
}

function renderMonitorList() {
  const allTabUsers = currentFollowerUsers();
  const allUsers = monitor.users || [];
  const pending = (monitor.queue || []).filter(user => user.status === 'pending' && user.state !== 'following' && user.relationship?.following !== true);
  const notMutualUsers = getNotMutualUsers();
  const keyword = followerSearch.trim().toLowerCase();
  const matchedUsers = keyword ? allTabUsers.filter(user => [user.handle, user.name, user.bio].some(value => String(value || '').toLowerCase().includes(keyword))) : allTabUsers;
  const totalPages = Math.max(1, Math.ceil(matchedUsers.length / followerPageSize));
  followerPage = Math.min(Math.max(1, followerPage), totalPages);
  const start = (followerPage - 1) * followerPageSize;
  const users = matchedUsers.slice(start, start + followerPageSize);
  const empty = $('monitorEmpty'); const list = $('monitorList'); const selection = $('selectionBar'); const pagination = $('monitorPagination');
  const listHeader = $('monitorListHeader');
  const following = (monitor.users || []).filter(user => user.state === 'following' || monitorUserStatus(user) === 'followed').length;
  $('followingCount').textContent = String(following);
  $('followBackCount').textContent = String(pending.length);
  if ($('notMutualCount')) $('notMutualCount').textContent = String(notMutualUsers.length);
  if ($('queueCount')) $('queueCount').textContent = String(pending.length);
  document.querySelectorAll('[data-follower-tab]').forEach(button => {
    const isActive = button.dataset.followerTab === activeFollowerTab;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  });
  const hasUsers = allTabUsers.length > 0 && matchedUsers.length > 0;
  empty.hidden = allTabUsers.length > 0; list.hidden = allTabUsers.length === 0; selection.hidden = allTabUsers.length === 0; pagination.hidden = allTabUsers.length === 0;
  if (listHeader) listHeader.hidden = !hasUsers;
  list.replaceChildren();
  $('scanFollowers').title = allUsers.length ? '扫描新粉丝，只读取最新页面直到遇到历史账号。' : '获取初始粉丝列表。';
  $('monitorEmptyTitle').textContent = activeFollowerTab === 'notMutual' ? '没有未互关（单向关注）账号' : (activeFollowerTab === 'followBack' ? '没有待回关账号' : (allUsers.length ? '没有已关注的粉丝' : '还没有粉丝列表'));
  $('initialFollowers').hidden = activeFollowerTab === 'followBack';
  $('initialFollowers').textContent = activeFollowerTab === 'notMutual' ? '扫描关注与粉丝' : (allUsers.length ? '扫描新粉丝' : '获取初始列表');
  $('monitorStatus').textContent = allUsers.length ? `本地档案 ${allUsers.length.toLocaleString()} 个 · 待回关 ${pending.length} 个 · 未互关 ${notMutualUsers.length} 个${keyword ? ` · 搜索到 ${matchedUsers.length} 个` : ''}` : '点击“获取初始列表”开始建立本地粉丝档案。';
  const visibleKeys = new Set(allTabUsers.map(user => user.handle.toLowerCase()));
  for (const key of [...selectedFollowerHandles]) if (!visibleKeys.has(key) && !allUsers.some(user => user.handle.toLowerCase() === key)) selectedFollowerHandles.delete(key);
  $('selectedCount').textContent = String(selectedFollowerHandles.size);
  if ($('totalVisibleCount')) $('totalVisibleCount').textContent = String(matchedUsers.length);
  if ($('analyzeSelected')) {
    $('analyzeSelected').hidden = activeFollowerTab === 'notMutual';
    $('analyzeSelected').disabled = selectedFollowerHandles.size === 0 || selectedFollowerHandles.size > 20;
  }
  if ($('addSelectedToMutual')) {
    $('addSelectedToMutual').disabled = selectedFollowerHandles.size === 0;
  }
  if ($('batchUnfollow')) {
    $('batchUnfollow').hidden = activeFollowerTab !== 'notMutual';
    $('batchUnfollow').disabled = selectedFollowerHandles.size === 0 || unfollowRunning;
  }
  $('listSelectAll').checked = users.length > 0 && users.every(user => selectedFollowerHandles.has(user.handle.toLowerCase()));
  $('listSelectAll').indeterminate = users.some(user => selectedFollowerHandles.has(user.handle.toLowerCase())) && !$('listSelectAll').checked;
  $('followerSearch').value = followerSearch;
  $('followerPageSize').value = String(followerPageSize);
  $('followerPageSummary').textContent = formatPageSummary(followerPage, totalPages, matchedUsers.length);
  $('followerPrevPage').disabled = followerPage <= 1;
  $('followerNextPage').disabled = followerPage >= totalPages;
  if (!allTabUsers.length) return;
  if (!users.length) {
    const noMatch = document.createElement('p'); noMatch.className = 'monitor-no-match'; noMatch.textContent = '没有匹配的账号。'; list.append(noMatch); return;
  }
  const fragment = document.createDocumentFragment();
  for (const user of users) {
    const key = user.handle.toLowerCase();
    const item = document.createElement('div');
    item.className = `monitor-item ${user.status === 'danger' ? 'is-danger' : ''}`;
    const select = document.createElement('input');
    select.type = 'checkbox';
    select.checked = selectedFollowerHandles.has(key);
    select.title = activeFollowerTab === 'notMutual' ? '选择后可批量取关' : '选择后可提交给 Grok 分析';
    select.addEventListener('change', () => {
      if (select.checked && activeFollowerTab !== 'notMutual' && selectedFollowerHandles.size >= 20) {
        select.checked = false;
        monitorStatus('Grok 一次最多选择 20 个账号。');
        return;
      }
      if (select.checked) selectedFollowerHandles.add(key);
      else selectedFollowerHandles.delete(key);
      renderMonitorList();
    });

    const info = document.createElement('div');
    info.className = 'monitor-info';
    const link = document.createElement('a');
    link.href = `https://x.com/${user.handle}`;
    link.target = '_blank';
    link.rel = 'noopener';
    const cached = profileCache[key];
    const rawName = cached?.name || user.name || user.handle;
    link.textContent = `${repairMojibake(rawName)} · @${user.handle}`;
    const detail = document.createElement('small');
    detail.textContent = cleanFollowerBio(user).slice(0, 160);
    info.append(link, detail);

    const tagCell = createMutualTagCell(user, 'div');

    const badge = document.createElement('span');
    if (activeFollowerTab === 'notMutual' || user.notMutual) {
      badge.className = 'monitor-badge badge-danger';
      badge.textContent = '未回关我';
      badge.title = '不推荐原因：你已关注该账号，但对方未回关你';
      badge.dataset.tip = badge.title;
    } else {
      badge.className = `monitor-badge badge-${user.status || 'saved'}`;
      badge.textContent = { danger: '风险', following: '已关注', followed: '已回关', pending: '待回关', follow_failed: '关注失败', blocked: '已屏蔽', saved: '本地收录' }[user.status] || '本地收录';
      if (user.status === 'follow_failed' && user.followFailureReason) badge.title = `最近失败原因：${user.followFailureReason}`;
    }

    const actions = document.createElement('div');
    actions.className = 'monitor-actions';
    if (activeFollowerTab === 'followBack' && user.status !== 'followed') {
      const follow = monitorIconButton('follow', followBackBusy.has(key) ? '回关中…' : '回关');
      follow.disabled = followBackBusy.has(key);
      follow.classList.toggle('is-busy', followBackBusy.has(key));
      follow.title = '通过当前 X 会话的接口执行回关，不打开个人主页窗口';
      follow.addEventListener('click', () => followBackOne(user, follow));
      actions.append(follow);
    }
    if (activeFollowerTab === 'notMutual') {
      const unfollow = monitorIconButton('unfollow', unfollowBusy.has(key) ? '取关中…' : '取消关注');
      unfollow.disabled = unfollowBusy.has(key);
      unfollow.classList.toggle('is-busy', unfollowBusy.has(key));
      unfollow.title = '取消关注该账号（对方未回关）';
      unfollow.addEventListener('click', () => unfollowOne(user, unfollow));
      actions.append(unfollow);
    }
    const refresh = monitorIconButton('refresh', profileRefreshBusy.has(key) ? '刷新中…' : '刷新资料');
    refresh.disabled = profileRefreshBusy.has(key);
    refresh.classList.toggle('is-busy', profileRefreshBusy.has(key));
    refresh.title = '静默读取该账号公开资料并存入本地画像缓存';
    refresh.addEventListener('click', () => refreshFollowerProfile(user));
    actions.append(refresh);

    const action = monitorIconButton('profile', '资料');
    action.title = '在右侧抽屉查看已保存的画像详情';
    action.addEventListener('click', () => openProfileDrawer(user));
    actions.append(action);

    item.append(select, info, tagCell, badge, actions);
    fragment.append(item);
  }
  list.append(fragment);
}
function renderQueue() { renderMonitorList(); }

function getMergedUserForEvaluation(user) {
  if (!user?.handle) return user || {};
  const key = user.handle.toLowerCase();
  const cached = profileCache[key] || {};
  const posts = Array.isArray(cached.posts) && cached.posts.length
    ? cached.posts
    : (Array.isArray(user.posts) ? user.posts : []);
  return {
    ...user,
    ...cached,
    name: repairMojibake(cached.name || user.name || user.handle),
    bio: repairMojibake(cached.bio || user.bio || ''),
    followersText: cached.followersText || user.followersText || '',
    followingText: cached.followingText || user.followingText || '',
    posts,
    grokMutualIntent: typeof cached.grokMutualIntent === 'boolean' ? cached.grokMutualIntent : user.grokMutualIntent,
    grokReason: cached.grokReason || user.grokReason || ''
  };
}

function createMutualTagCell(user, cellTag = 'div') {
  const cell = document.createElement(cellTag);
  cell.className = cellTag === 'td' ? 'col-tag' : 'col-tag-cell';
  const wrap = cellTag === 'td' ? document.createElement('div') : cell;
  if (cellTag === 'td') {
    wrap.className = 'col-tag-cell';
    cell.append(wrap);
  }
  const merged = getMergedUserForEvaluation(user);
  const evalResult = evaluateMutualProfile(merged);

  const intentBadge = document.createElement('span');
  if (evalResult.tag === '互粉') {
    intentBadge.className = 'monitor-badge badge-mutual-intent';
    intentBadge.textContent = '互粉';
  } else {
    intentBadge.className = 'monitor-badge badge-no-intent';
    intentBadge.textContent = '无';
  }
  intentBadge.title = evalResult.intentTooltip;
  intentBadge.dataset.tip = evalResult.intentTooltip;
  wrap.append(intentBadge);

  if (evalResult.countsKnown || evalResult.isNotRecommended) {
    const ratioBadge = document.createElement('span');
    if (evalResult.isNotRecommended) {
      ratioBadge.className = 'monitor-badge badge-bait-risk';
      ratioBadge.textContent = '不推荐';
    } else {
      ratioBadge.className = 'monitor-badge badge-safe-ratio';
      ratioBadge.textContent = '推荐';
    }
    ratioBadge.title = evalResult.recommendReason;
    ratioBadge.dataset.tip = evalResult.recommendReason;
    wrap.append(ratioBadge);
  }
  return cell;
}

function syncDrawerMask() {
  const anyOpen = [
    $('profileDrawer'),
    $('settingsDrawer'),
    $('mutualSettingsDrawer'),
    $('commentAutoFollowDrawer')
  ].some(el => el && !el.hidden);
  if ($('profileDrawerMask')) $('profileDrawerMask').hidden = !anyOpen;
}

function closeProfileDrawer() {
  drawerUser = null;
  drawerMode = 'profile';
  $('profileDrawer').hidden = true;
  syncDrawerMask();
}

function closeSettingsDrawer() {
  if ($('settingsDrawer')) $('settingsDrawer').hidden = true;
  syncDrawerMask();
}

function closeMutualSettingsDrawer() {
  saveMutualAutoFollowSettings().catch(() => {});
  if ($('mutualSettingsDrawer')) $('mutualSettingsDrawer').hidden = true;
  syncDrawerMask();
}

function closeCommentAutoFollowDrawer() {
  saveCommentAutoFollowSettings().catch(() => {});
  if ($('commentAutoFollowDrawer')) $('commentAutoFollowDrawer').hidden = true;
  syncDrawerMask();
}

function renderSettingsDrawer() {
  if (!$('settingsDrawer')) return;
  $('monitorEnabled').checked = !!monitor.enabled;
  $('monitorEvery').value = monitor.every || 60;
  if ($('monitorJitter')) $('monitorJitter').value = monitor.jitter ?? 15;
  const handleEl = $('monitorCheckpointHandle');
  const timeEl = $('monitorCheckpointTime');
  if (handleEl) {
    if (monitor.checkpointHandle) {
      handleEl.textContent = `最新位点：@${monitor.checkpointHandle}`;
      if (timeEl) timeEl.textContent = monitor.checkpointAt ? `记录于 ${new Date(monitor.checkpointAt).toLocaleString()}` : '';
    } else {
      handleEl.textContent = '未记录位点（首次将建立增量基准）';
      if (timeEl) timeEl.textContent = '';
    }
  }
}

function openSettingsDrawer() {
  closeProfileDrawer();
  closeMutualSettingsDrawer();
  renderSettingsDrawer();
  if ($('settingsDrawer')) $('settingsDrawer').hidden = false;
  syncDrawerMask();
}

function getMutualAutoConfig() {
  return normalizeAutoFollowConfig(mutualNetwork.autoFollow || {});
}

function renderMutualSettingsDrawer() {
  if (!$('mutualSettingsDrawer')) return;
  const cfg = getMutualAutoConfig();
  if ($('mutualAutoEnabled')) $('mutualAutoEnabled').checked = !!cfg.enabled;
  if ($('mutualAutoEvery')) $('mutualAutoEvery').value = cfg.every || 5;
  if ($('mutualAutoJitter')) $('mutualAutoJitter').value = cfg.jitter ?? 3;
  if ($('mutualAutoBatchSize')) $('mutualAutoBatchSize').value = cfg.batchLimit || 10;
  if ($('mutualAutoScrollRounds')) $('mutualAutoScrollRounds').value = cfg.scrollRounds || 5;
  if ($('mutualAutoDwellSec')) $('mutualAutoDwellSec').value = cfg.dwellSeconds || 15;
  if ($('mutualAutoMinFollowers')) $('mutualAutoMinFollowers').value = cfg.minFollowers ?? 50;
  if ($('mutualAutoOnlyIntent')) $('mutualAutoOnlyIntent').checked = cfg.onlyMutualIntent !== false;
  if ($('mutualAutoGrokComment')) $('mutualAutoGrokComment').checked = Boolean(cfg.grokAutoComment);
  const summaryEl = $('mutualAutoSummaryText');
  const timeEl = $('mutualAutoLastTime');
  if (summaryEl) {
    summaryEl.textContent = cfg.lastSummary || (cfg.followedCount ? `累计已仿真看帖并关注 ${cfg.followedCount} 人` : '尚未执行定时看帖关注');
  }
  if (timeEl) {
    timeEl.textContent = cfg.lastRunAt ? `最近执行：${new Date(cfg.lastRunAt).toLocaleString()} · 已记录处理 ${(cfg.processedHandles || []).length} 人` : '';
  }
  const runBtn = $('runMutualAutoNow');
  if (runBtn) {
    runBtn.disabled = mutualAutoRunning;
    runBtn.textContent = mutualAutoRunning ? '正在看帖并关注中…' : '立即执行一次（看帖并关注）';
  }
}

function openMutualSettingsDrawer() {
  closeProfileDrawer();
  closeSettingsDrawer();
  renderMutualSettingsDrawer();
  if ($('mutualSettingsDrawer')) $('mutualSettingsDrawer').hidden = false;
  syncDrawerMask();
}

function drawerProfile() {
  if (!drawerUser?.handle) return null;
  return getMergedUserForEvaluation(drawerUser);
}

function drawerField(label, value) {
  const row = document.createElement('div'); row.className = 'drawer-field';
  const key = document.createElement('span'); key.textContent = label;
  const text = document.createElement('strong'); text.textContent = value || '未读取';
  row.append(key, text); return row;
}

function renderProfileDrawer() {
  const profile = drawerProfile();
  if (!profile) return closeProfileDrawer();
  const evalResult = evaluateMutualProfile(profile);
  const root = $('profileDrawerContent'); root.replaceChildren();
  const identity = document.createElement('div'); identity.className = 'drawer-identity';
  const avatar = document.createElement('div'); avatar.className = 'drawer-avatar';
  if (profile.avatarUrl) { const image = document.createElement('img'); image.src = profile.avatarUrl; image.alt = ''; avatar.append(image); }
  else avatar.textContent = String(repairMojibake(profile.name) || profile.handle || '?').slice(0, 1).toUpperCase();
  const names = document.createElement('div'); const name = document.createElement('strong'); name.textContent = repairMojibake(profile.name) || `@${profile.handle}`; const handle = document.createElement('small'); handle.textContent = `@${profile.handle}`; names.append(name, handle); identity.append(avatar, names); root.append(identity);
  const facts = document.createElement('div'); facts.className = 'drawer-facts';
  const tagSourceSuffix = evalResult.intentSource === 'posts' ? '（帖子命中）' : (evalResult.intentSource === 'grok' ? '（Grok）' : '');
  facts.append(
    drawerField('粉丝', profile.followersText),
    drawerField('关注', profile.followingText),
    drawerField('互粉标签', `${evalResult.tag}${tagSourceSuffix}`),
    drawerField('推荐评估', evalResult.recommendLabel)
  );
  root.append(facts);
  const bio = document.createElement('section'); bio.className = 'drawer-section'; const bioTitle = document.createElement('h3'); bioTitle.textContent = '简介'; const bioText = document.createElement('p'); bioText.textContent = repairMojibake(profile.bio) || '暂无简介'; bio.append(bioTitle, bioText); root.append(bio);
  const mutualSection = document.createElement('section'); mutualSection.className = `drawer-section drawer-risk ${evalResult.isNotRecommended ? 'is-danger' : ''}`;
  const mutualTitle = document.createElement('h3'); mutualTitle.textContent = '互粉意向与推荐评估';
  const mutualText = document.createElement('p');
  const lines = [evalResult.recommendReason];
  if (evalResult.postKeywordHits?.length) {
    lines.push(`首页前 ${evalResult.postCount} 条帖子关键词命中：${evalResult.postKeywordHits.join('、')}`);
  }
  if (evalResult.bioKeywordHits?.length) {
    lines.push(`简介/名称关键词命中：${evalResult.bioKeywordHits.join('、')}`);
  }
  if (!evalResult.keywordHits?.length) {
    lines.push(evalResult.postCount > 0 ? `已检查简介与前 ${evalResult.postCount} 条帖子：未命中互粉关键词` : '尚未读取首页帖子，点击“采集资料”可扫描前 5-10 条帖子关键词');
  }
  if (typeof profile.grokMutualIntent === 'boolean') {
    lines.push(`Grok 互粉倾向：${profile.grokMutualIntent ? '有互粉倾向' : '无互粉倾向'}${profile.grokReason ? `（${profile.grokReason}）` : ''}`);
  }
  mutualText.textContent = lines.join('\n');
  mutualSection.append(mutualTitle, mutualText);
  root.append(mutualSection);
  const risk = profile.risk || evalResult.risk; const riskSection = document.createElement('section'); riskSection.className = `drawer-section drawer-risk ${risk.level === 'danger' ? 'is-danger' : ''}`; const riskTitle = document.createElement('h3'); riskTitle.textContent = risk.level === 'danger' ? '风险标记' : '内容风险检查'; const riskText = document.createElement('p'); riskText.textContent = risk.level === 'danger' ? risk.hits.join('；') : '未命中本地内容危险信号'; riskSection.append(riskTitle, riskText); root.append(riskSection);
  const postSection = document.createElement('section'); postSection.className = 'drawer-section'; const recentPosts = drawerMode === 'commentPosts' ? (drawerUser.recentPosts || profile.posts || []) : (profile.posts || []); const postTitle = document.createElement('h3'); postTitle.textContent = drawerMode === 'commentPosts' ? `近期帖子历史（${recentPosts.length}/100）` : '最近帖子（用于互粉关键词匹配）'; if (!recentPosts.length) { const hint = document.createElement('p'); hint.textContent = drawerLoading ? '正在读取公开资料…' : '尚未采集，点击“采集资料”读取最近帖子。'; postSection.append(postTitle, hint); } else { const list = document.createElement('ol'); for (const post of recentPosts) { const item = document.createElement('li'); const text = document.createElement('span'); text.textContent = post.text || '无文字内容'; item.append(text); if (post.url) { const link = document.createElement('a'); link.href = post.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '打开帖子'; item.append(document.createTextNode(' · '), link); } list.append(item); } postSection.append(postTitle, list); } root.append(postSection);
  if (profile.grokComment) {
    const grokSec = document.createElement('section');
    grokSec.className = 'drawer-section';
    const grokTitle = document.createElement('h3');
    grokTitle.textContent = '🤖 Grok 互动回评建议（草稿）';
    const grokBox = document.createElement('div');
    grokBox.className = 'log-grok-box';
    grokBox.style.margin = '6px 0 0';
    const grokHdr = document.createElement('div');
    grokHdr.className = 'log-grok-header';
    const grokTag = document.createElement('span');
    grokTag.className = 'log-grok-tag';
    grokTag.textContent = '推荐回评';
    grokHdr.append(grokTag);
    if (profile.grokCommentPostUrl) {
      const a = document.createElement('a');
      a.className = 'log-grok-post-link';
      a.href = profile.grokCommentPostUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = '原推 ↗';
      grokHdr.append(a);
    }
    const btn = document.createElement('button');
    btn.className = 'log-copy-btn';
    btn.textContent = '复制回评';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(profile.grokComment);
        btn.textContent = '已复制！';
        setTimeout(() => { btn.textContent = '复制回评'; }, 1800);
      } catch {
        btn.textContent = '复制失败';
      }
    });
    grokHdr.append(btn);
    grokBox.append(grokHdr);
    if (profile.grokCommentPost) {
      const pPrev = document.createElement('div');
      pPrev.style.fontSize = '11px';
      pPrev.style.color = 'var(--text-subtle)';
      pPrev.style.marginBottom = '4px';
      pPrev.style.paddingLeft = '6px';
      pPrev.style.borderLeft = '2px solid var(--border-soft)';
      pPrev.style.maxHeight = '38px';
      pPrev.style.overflow = 'hidden';
      pPrev.style.textOverflow = 'ellipsis';
      pPrev.textContent = '针对推文：' + profile.grokCommentPost;
      grokBox.append(pPrev);
    }
    const bdy = document.createElement('div');
    bdy.className = 'log-grok-body';
    bdy.textContent = profile.grokComment;
    grokBox.append(bdy);
    grokSec.append(grokTitle, grokBox);
    root.append(grokSec);
  }
  $('profileDrawerTitle').textContent = `@${profile.handle}`;
  $('drawerRefreshProfile').disabled = drawerLoading;
  $('drawerRefreshProfile').textContent = drawerLoading ? '采集中…' : '采集资料';
  $('profileDrawer').hidden = false;
  syncDrawerMask();
}

function openProfileDrawer(user) {
  closeSettingsDrawer();
  closeMutualSettingsDrawer();
  drawerMode = 'profile';
  drawerUser = {...user};
  renderProfileDrawer();
  if (!profileCache[user.handle.toLowerCase()]) refreshDrawerProfile();
}

function openCommentRecentPostsDrawer(user) {
  closeSettingsDrawer(); closeMutualSettingsDrawer();
  drawerMode = 'commentPosts';
  drawerUser = {...user};
  const cached = profileCache[String(user.handle || '').toLowerCase()];
  if (cached) drawerUser = {...cached, ...drawerUser, posts:cached.posts || []};
  renderProfileDrawer();
  const fetchedAt = Date.parse(user.recentPostsFetchedAt || '');
  if (!user.recentPosts?.length || !Number.isFinite(fetchedAt) || Date.now() - fetchedAt >= 7 * 86400000) refreshDrawerProfile();
}

async function readProfileBundleInBackground(user, recentLimit = 10) {
  const tab = await chrome.tabs.create({url:`https://x.com/${user.handle}`, active:false});
  if (!tab?.id) throw new Error('后台资料标签页创建失败');
  try {
    const deadline = Date.now() + 25000;
    let data = {pending:true};
    while (Date.now() < deadline && data.pending) {
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      if (!current) break;
      if (current.status === 'complete') data = (await chrome.scripting.executeScript({target:{tabId:tab.id}, func:readProfileBundle, args:[user.handle, recentLimit]}))[0]?.result || data;
      if (data.pending) await sleep(700);
    }
    if (data.pending) throw new Error('公开资料未能在限定时间内读取');
    if ((data.posts || []).length < 5) {
      await sleep(650);
      const more = (await chrome.scripting.executeScript({target:{tabId:tab.id}, func:readProfileBundle, args:[user.handle, recentLimit]}).catch(() => []))?.[0]?.result;
      if (more && !more.pending && (more.posts || []).length > (data.posts || []).length) data = more;
    }
    return {...user, ...data, handle:user.handle, url:`https://x.com/${user.handle}`, posts:data.posts || [], risk:riskAssess({...user, ...data}), profileCachedAt:new Date().toISOString()};
  } finally { await chrome.tabs.remove(tab.id).catch(() => {}); }
}

async function refreshDrawerProfile() {
  if (!drawerUser?.handle || drawerLoading || profileRefreshBusy.has(drawerUser.handle.toLowerCase())) return;
  drawerLoading = true;
  renderProfileDrawer();
  try {
    if (drawerMode === 'commentPosts') {
      const key = String(drawerUser.handle).toLowerCase();
      const profile = await readProfileBundleInBackground(drawerUser, 5);
      const commentUser = (commentTracking.users || []).find(item => String(item.handle || '').toLowerCase() === key);
      if (commentUser) {
        commentUser.recentPosts = mergeRecentPosts(commentUser.recentPosts || [], profile.posts || [], 100);
        commentUser.recentPostsFetchedAt = new Date().toISOString();
        commentUser.recentPostsCount = commentUser.recentPosts.length;
        drawerUser = {...profile, ...commentUser};
        profileCache[key] = {...(profileCache[key] || {}), ...profile, posts:commentUser.recentPosts.slice(0, 10)};
        await saveCommentTracking();
        await chrome.storage.local.set({profileCache}); persist('profileCache', profileCache);
      }
      return;
    }
    await refreshFollowerProfile(drawerUser);
  } catch (error) {
    if (drawerMode === 'commentPosts') {
      const commentUser = (commentTracking.users || []).find(item => String(item.handle || '').toLowerCase() === String(drawerUser?.handle || '').toLowerCase());
      if (commentUser) { commentUser.recentPostFetchError = String(error?.message || error); await saveCommentTracking(); }
      $('commentTrackingStatus').textContent = `@${drawerUser?.handle || ''} 近期帖子读取失败：${error?.message || error}`;
    } else monitorStatus(`资料读取失败：${error.message}`);
  } finally {
    drawerLoading = false;
    renderProfileDrawer();
  }
}

function applyProfileToMonitor(profile) {
  const key = String(profile?.handle || '').toLowerCase();
  if (!key) return;
  const {status, ...profileFields} = profile;
  if (profileFields.name) profileFields.name = repairMojibake(profileFields.name);
  if (profileFields.bio) profileFields.bio = repairMojibake(profileFields.bio);
  for (const collection of [monitor.users || [], monitor.queue || [], monitor.followingUsers || [], mutualNetwork.users || []]) {
    const item = collection.find(entry => String(entry.handle || '').toLowerCase() === key);
    if (item) Object.assign(item, profileFields);
  }
}

async function refreshFollowerProfile(user) {
  const key = String(user?.handle || '').toLowerCase();
  if (!key || profileRefreshBusy.has(key)) return;
  profileRefreshBusy.add(key);
  renderMonitorList();
  if (String(drawerUser?.handle || '').toLowerCase() === key) {
    drawerLoading = true;
    renderProfileDrawer();
  }
  monitorStatus(`正在后台读取 @${user.handle} 的公开资料与首页前 5–10 条帖子…`);
  try {
    const profile = await readProfileBundleInBackground(user, 10);
    profileCache[key] = profile;
    if (archiveCommentRecentPosts(profile)) await saveCommentTracking();
    applyProfileToMonitor(profile);
    if (String(drawerUser?.handle || '').toLowerCase() === key) drawerUser = profile;
    await chrome.storage.local.set({monitor, profileCache, mutualNetwork});
    persist('monitor', monitor);
    persist('profileCache', profileCache);
    persist('mutualNetwork', mutualNetwork);
    const evalRes = evaluateMutualProfile(profile);
    monitorStatus(`@${user.handle} 已刷新（读取 ${profile.posts?.length || 0} 条帖子 · 标签：${evalRes.tag}${evalRes.keywordHits?.length ? `，命中：${evalRes.keywordHits.join('、')}` : ''} · ${evalRes.baitRiskLabel}）。`);
    renderMutualNetwork();
    return profile;
  } catch (error) {
    monitorStatus(`@${user.handle} 的资料刷新失败：${error.message}`);
  } finally {
    profileRefreshBusy.delete(key);
    renderMonitorList();
    if (String(drawerUser?.handle || '').toLowerCase() === key) {
      drawerLoading = false;
      renderProfileDrawer();
    }
  }
}
async function backgroundProfileTab(handle) {
  const tab = await chrome.tabs.create({url:`https://x.com/${handle}`, active:false});
  if (!tab?.id) throw new Error('后台标签页创建失败');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const current = await chrome.tabs.get(tab.id);
    if (current.status === 'complete') return tab.id;
    await sleep(500);
  }
  throw new Error('后台标签页加载超时');
}

const networkTemplateRoutes = {
  UserByScreenName: '',
  Following: 'following',
  Followers: 'followers',
  BlueVerifiedFollowers: 'verified_followers'
};

async function hasNetworkTemplate(operation) {
  const {networkTemplates = {}} = await chrome.storage.local.get('networkTemplates');
  return isUsableNetworkTemplate(operation, networkTemplates[operation]);
}

function isUsableNetworkTemplate(operation, template) {
  return templateIsUsable(operation, template);
}

async function triggerTabClick(tabId, operation, handle) {
  try {
    await chrome.scripting.executeScript({
      target: {tabId},
      func: (op, h) => {
        const tabs = Array.from(document.querySelectorAll('a[role="tab"], div[role="tab"], [role="tab"]'));
        if (op === 'Followers') {
          const target = tabs.find(el => {
            const href = (el.getAttribute('href') || '').toLowerCase().replace(/\/+$/, '');
            const text = (el.textContent || '').trim();
            if (!href.includes('verified') && !href.includes('followers_you_follow') && href.endsWith('/followers')) return true;
            if ((text === '关注者' || text === 'Followers' || text.endsWith('关注者')) && !text.includes('认证') && !text.includes('Verified') && !text.includes('know') && !text.includes('你关注')) return true;
            return false;
          });
          if (target) target.click();
        } else if (op === 'Following') {
          const target = tabs.find(el => {
            const href = (el.getAttribute('href') || '').toLowerCase().replace(/\/+$/, '');
            const text = (el.textContent || '').trim();
            if (href.endsWith('/following')) return true;
            if (text === '正在关注' || text === 'Following' || text.endsWith('正在关注')) return true;
            return false;
          });
          if (target) target.click();
        }
      },
      args: [operation, handle]
    });
  } catch {}
}

async function ensureNetworkTemplate(handle, operation, force = false) {
  if (!force && await hasNetworkTemplate(operation)) return true;
  const suffix = networkTemplateRoutes[operation];
  if (suffix === undefined) return false;
  const minCapturedAt = force ? Date.now() : 0;
  networkStatus(`正在静默准备 ${operation} 接口模板…`);
  const tab = await chrome.tabs.create({url:`https://x.com/${handle}${suffix ? `/${suffix}` : ''}`, active:false});
  if (!tab?.id) return false;
  try {
    const deadline = Date.now() + 20000;
    let elapsed = 0;
    while (Date.now() < deadline) {
      const {networkTemplates = {}} = await chrome.storage.local.get('networkTemplates');
      const template = networkTemplates[operation];
      if (isUsableNetworkTemplate(operation, template) && (!force || Number(template.at || 0) >= minCapturedAt)) return true;
      elapsed += 500;
      if (elapsed === 1000 || elapsed === 2000 || elapsed === 3500 || elapsed === 5000) {
        await triggerTabClick(tab.id, operation, handle);
      }
      await sleep(500);
    }
    return false;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function invalidateNetworkTemplate(operation) {
  const {networkTemplates = {}} = await chrome.storage.local.get('networkTemplates');
  if (!networkTemplates[operation]) return;
  delete networkTemplates[operation];
  await chrome.storage.local.set({networkTemplates});
}

async function networkFetchWithRecovery(tabId, handle, operation, variables) {
  let response = await networkFetch(tabId, operation, variables);
  if (response.status !== 404) return response;
  // If this was a pagination request (with cursor), 404 is a cursor expiration/pagination
  // issue, NOT that the base queryId template has retired. Do NOT invalidate or retry.
  if (variables?.cursor) return response;
  // A GraphQL queryId can be retired by X while the extension's cached
  // template still exists. Re-capture this operation once, then retry once.
  await invalidateNetworkTemplate(operation);
  if (!await ensureNetworkTemplate(handle, operation, true)) {
    return {...response, error:`${operation} 模板已失效，静默刷新未捕获到新模板。`};
  }
  response = await networkFetch(tabId, operation, variables);
  if (response.status === 404) {
    const {networkTemplates = {}} = await chrome.storage.local.get('networkTemplates');
    const rejectedQueryId = networkTemplates[operation]?.queryId || '';
    await invalidateNetworkTemplate(operation);
    return {
      ...response,
      error:`${operation} 刷新后仍返回 404${rejectedQueryId ? `（模板 ${rejectedQueryId}）` : ''}${response.error ? `：${response.error}` : '。'} 已清除失效模板，请下次重新捕获。`
    };
  }
  return response;
}

async function collectRelations(handle, perSideLimit = 500) {
  if (!await ensureNetworkTemplate(handle, 'UserByScreenName')) throw new Error('未捕获 UserByScreenName 模板，请刷新 X 页面后重试。');
  const tabId = await backgroundProfileTab(handle);
  try {
    await sleep(1200);
    const profile = await networkFetch(tabId, 'UserByScreenName', {screen_name:handle});
    if (profile.status !== 200) throw new Error(profile.error || '未捕获 profile 网络模板，请先在 X 打开一次主页。');
    const owner = parseNetworkUsers(profile.json).find(user => user.handle.toLowerCase() === handle.toLowerCase());
    if (!owner?.id) throw new Error('没有读取到该账号的用户 ID。');
    const collect = async operation => {
      if (!await ensureNetworkTemplate(handle, operation)) throw new Error(`未捕获 ${operation} 模板，已静默尝试读取对应列表但未成功。`);
      const found = new Map(); let cursor = '';
      for (let page=0; page<10 && found.size<perSideLimit; page++) {
        const response = await networkFetchWithRecovery(tabId, handle, operation, {userId:owner.id, count:20, ...(cursor ? {cursor} : {})});
        if (response.status !== 200) {
          if (page > 0 && found.size > 0) break;
          throw new Error(response.error || `${operation} 网络请求失败（${response.status}）`);
        }
        for (const user of parseNetworkUsers(response.json)) if (user.handle.toLowerCase() !== handle.toLowerCase()) found.set(user.handle.toLowerCase(), user);
        const next=findCursor(response.json); if (!next || next === cursor) break; cursor=next;
      }
      return [...found.values()].slice(0, perSideLimit);
    };
    return {handle, following:await collect('Following'), followers:await collect('Followers'), checkedAt:new Date().toISOString()};
  } finally { await chrome.tabs.remove(tabId).catch(() => {}); }
}

async function saveMutualNetwork() { await chrome.storage.local.set({mutualNetwork}); persist('mutualNetwork', mutualNetwork); }
function networkStatus(text) {
  const root = $('networkStatus');
  if (root) root.textContent = text;
}
function mergeNetworkAccount(existing = {}, user = {}) {
  const relationship = {...(existing.relationship || {})};
  for (const [key, value] of Object.entries(user.relationship || {})) if (value !== null && value !== undefined) relationship[key] = value;
  const relationshipKnown = existing.relationshipKnown === true || user.relationshipKnown === true;
  return {...existing, ...user, relationship, relationshipKnown};
}
function ownFollowerHandles() {
  return new Set((monitor.users || []).map(item => item.handle?.toLowerCase()).filter(Boolean));
}
function applyOwnFollowingSnapshot(user) {
  if (!user?.handle) return user;
  const key = user.handle.toLowerCase();
  const followingHandles = ownFollowingHandles();
  const followerHandles = ownFollowerHandles();
  const relationship = {...(user.relationship || {})};
  if (followingHandles.has(key)) relationship.following = true;
  else if (typeof relationship.following !== 'boolean') relationship.following = false;
  if (followerHandles.has(key) && typeof relationship.followedBy !== 'boolean') relationship.followedBy = true;
  return {...user, relationship, relationshipKnown:typeof relationship.followedBy === 'boolean'};
}
function ownFollowingHandles() {
  const handles = new Set((monitor.followingUsers || []).map(item => item.handle?.toLowerCase()).filter(Boolean));
  for (const user of (monitor.users || [])) {
    if (user?.handle && (user.state === 'following' || monitorUserStatus(user) === 'followed')) handles.add(user.handle.toLowerCase());
  }
  return handles;
}
function personalRelationRank(user) {
  return {'互相关注':0, '对方关注你':1, '你关注对方':2, '未互关':3, '你未关注对方':4, '关系未知':5}[personalRelationshipLabel(user)];
}
let activeMutualTab = 'mutual';
let mutualPage = 1;
let mutualPageSize = 50;

function getAllMutualUsersWithSnapshot() {
  return [...(mutualNetwork.users || [])]
    .map(applyOwnFollowingSnapshot)
    .sort((a,b) => personalRelationRank(a) - personalRelationRank(b) || String(a.name || a.handle).localeCompare(String(b.name || b.handle)));
}

function getFilteredMutualUsers(tab = activeMutualTab, keyword = mutualSearch) {
  const byTab = getAllMutualUsersWithSnapshot().filter(user => mutualUserCategory(user) === tab);
  return filterMutualTrackingUsers(byTab, keyword, profileCache);
}

function selectedMutualUsersList() {
  if (!selectedMutualHandles.size) return [];
  const allByKey = new Map(getAllMutualUsersWithSnapshot().map(u => [u.handle.toLowerCase(), u]));
  return [...selectedMutualHandles].map(k => allByKey.get(k)).filter(Boolean);
}

function renderMutualNetwork() {
  const body = $('mutualResults'); if (!body) return;
  body.replaceChildren();
  const allUsers = getAllMutualUsersWithSnapshot();
  const allKeySet = new Set(allUsers.map(u => u.handle.toLowerCase()));
  for (const k of [...selectedMutualHandles]) {
    if (!allKeySet.has(k)) selectedMutualHandles.delete(k);
  }
  $('mutualNetworkCount').textContent = String(allUsers.length);
  $('networkAnchor').value = mutualNetwork.anchor || '';

  const groups = { mutual: [], following: [], followBack: [], none: [] };
  for (const user of allUsers) {
    const cat = mutualUserCategory(user);
    (groups[cat] || groups.none).push(user);
  }
  if ($('mutualTabMutualCount')) $('mutualTabMutualCount').textContent = String(groups.mutual.length);
  if ($('mutualTabFollowingCount')) $('mutualTabFollowingCount').textContent = String(groups.following.length);
  if ($('mutualTabFollowBackCount')) $('mutualTabFollowBackCount').textContent = String(groups.followBack.length);
  if ($('mutualTabNoneCount')) $('mutualTabNoneCount').textContent = String(groups.none.length);
  document.querySelectorAll('.mutual-tab').forEach(button => {
    const isActive = button.dataset.mutualTab === activeMutualTab;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  });

  const tabUsers = groups[activeMutualTab] || [];
  const users = filterMutualTrackingUsers(tabUsers, mutualSearch, profileCache);
  const total = users.length;
  if ($('mutualSelectedCount')) $('mutualSelectedCount').textContent = String(selectedMutualHandles.size);
  if ($('mutualTotalVisibleCount')) $('mutualTotalVisibleCount').textContent = String(total);
  if ($('mutualSearch') && $('mutualSearch').value !== mutualSearch) $('mutualSearch').value = mutualSearch;

  const selCount = selectedMutualHandles.size;
  if (!batchRefreshRunning && $('batchRefreshMutual')) {
    $('batchRefreshMutual').textContent = selCount > 0 ? `批量更新 (${selCount})` : '批量更新';
  }
  if ($('grokAnalyzeMutual')) {
    $('grokAnalyzeMutual').textContent = selCount > 0 ? `Grok 分析 (${Math.min(selCount, 20)})` : 'Grok 分析';
  }

  const pagination = $('mutualPagination');
  if (pagination) {
    if (total === 0) {
      pagination.hidden = true;
    } else {
      pagination.hidden = false;
      const totalPages = Math.ceil(total / mutualPageSize) || 1;
      if (mutualPage > totalPages) mutualPage = totalPages;
      if (mutualPage < 1) mutualPage = 1;
      $('mutualPageSummary').textContent = `第 ${mutualPage} / ${totalPages} 页（共 ${total} 条）`;
      $('mutualPrevPage').disabled = mutualPage <= 1;
      $('mutualNextPage').disabled = mutualPage >= totalPages;
      $('mutualPageSize').value = String(mutualPageSize);
    }
  }

  const startIdx = (mutualPage - 1) * mutualPageSize;
  const pageUsers = users.slice(startIdx, startIdx + mutualPageSize);
  const selectAllEl = $('mutualSelectAll');
  if (selectAllEl) {
    selectAllEl.checked = pageUsers.length > 0 && pageUsers.every(u => selectedMutualHandles.has(u.handle.toLowerCase()));
    selectAllEl.indeterminate = pageUsers.some(u => selectedMutualHandles.has(u.handle.toLowerCase())) && !selectAllEl.checked;
  }

  for (const user of pageUsers) {
    const key = user.handle.toLowerCase();
    const cached = profileCache[key];
    const displayName = repairMojibake(cached?.name || user.name || user.handle);
    const displayBio = repairMojibake(cached?.bio || user.bio || '');
    const followersText = cached?.followersText || user.followersText || '未读取';
    const followingText = cached?.followingText || user.followingText || '未读取';
    const row = document.createElement('tr');

    const checkTd = document.createElement('td');
    checkTd.className = 'col-check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedMutualHandles.has(key);
    checkbox.title = '选择后可指定执行批量更新或 Grok 分析';
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedMutualHandles.add(key);
      else selectedMutualHandles.delete(key);
      renderMutualNetwork();
    });
    checkTd.append(checkbox);
    row.append(checkTd);

    const account = document.createElement('td');
    account.className = 'col-account';
    const link = document.createElement('a'); link.href=`https://x.com/${user.handle}`; link.target='_blank'; link.rel='noopener noreferrer'; link.textContent=`${displayName} · @${user.handle}`;
    const bio = document.createElement('p'); bio.textContent=displayBio || '暂无简介'; account.append(link,bio); row.append(account);
    const tagTd = createMutualTagCell(user, 'td');
    row.append(tagTd);
    const relation = document.createElement('td'); relation.className = 'col-relation';
    const relationLabel = personalRelationshipLabel(user);
    const badge = document.createElement('span'); badge.className=`badge ${relationLabel === '互相关注' ? 'candidate' : relationLabel === '关系未知' ? 'review' : ''}`; badge.textContent=relationLabel; relation.append(badge); row.append(relation);
    for (const text of [followersText, followingText]) { const cell=document.createElement('td'); cell.className = 'col-count'; cell.textContent=text; row.append(cell); }
    const followRecordTd = document.createElement('td');
    followRecordTd.className = 'col-count col-record';
    if (user.followedAt) {
      const isMutual = user.relationship?.following === true && user.relationship?.followedBy === true;
      const back = isMutual || user.followBackAt;
      followRecordTd.textContent = `${new Date(user.followedAt).toLocaleString()} · ${back ? '已回关' : '待回关'}`;
    } else {
      followRecordTd.textContent = '未关注';
    }
    row.append(followRecordTd);
    const actions = document.createElement('td');
    actions.className = 'col-actions';

    const isFollowing = user.relationship?.following === true;
    const isFollowBusy = followBackBusy.has(key);
    const followLabel = isFollowBusy ? '关注中…' : (isFollowing ? '已关注' : (user.relationship?.followedBy === true ? '回关' : '关注'));
    const followBtn = monitorIconButton('follow', followLabel);
    followBtn.disabled = isFollowing || isFollowBusy;
    followBtn.classList.toggle('is-busy', isFollowBusy);
    followBtn.title = isFollowing ? '已关注该账号' : '通过当前 X 会话接口直接关注该账号';
    followBtn.setAttribute('aria-label', followLabel);
    if (!isFollowing) {
      followBtn.addEventListener('click', () => followMutualUser(user, followBtn));
    }

    const profile = monitorIconButton('profile', '查看资料');
    profile.addEventListener('click', () => openProfileDrawer(user));
    const expand = monitorIconButton('expand', '以此扩展');
    expand.title = '以该账号为新锚点，合并去重后的互关追踪列表';
    expand.setAttribute('aria-label', '以此扩展');
    expand.addEventListener('click', () => collectMutualNetwork(user.handle, false));
    const refreshBtn = monitorIconButton('refresh', profileRefreshBusy.has(key) ? '更新中…' : '更新信息');
    refreshBtn.disabled = profileRefreshBusy.has(key);
    refreshBtn.classList.toggle('is-busy', profileRefreshBusy.has(key));
    refreshBtn.title = '更新公开资料及你与对方的关注关系';
    refreshBtn.setAttribute('aria-label', '更新信息');
    refreshBtn.addEventListener('click', () => refreshMutualUser(user));
    actions.append(followBtn, profile, expand, refreshBtn);
    row.append(actions);
    body.append(row);
  }
  $('mutualEmpty').hidden = users.length > 0;
  if (allUsers.length === 0) {
    $('mutualEmpty').textContent = mutualNetwork.anchor ? '该锚点尚未读取到可展示的账号。' : '还没有互关追踪记录。';
  } else if (users.length === 0) {
    if (mutualSearch.trim()) {
      $('mutualEmpty').textContent = `未找到匹配“${mutualSearch.trim()}”的账号。`;
    } else {
      const emptyMap = {
        mutual: '当前没有已互关账号。',
        following: '当前没有已关注（对方未回关）账号。',
        followBack: '当前没有待回关账号。',
        none: '当前没有无关系账号。'
      };
      $('mutualEmpty').textContent = emptyMap[activeMutualTab] || '当前分类下没有账号。';
    }
  }
}

async function followMutualUser(user, button) {
  const key = String(user?.handle || '').toLowerCase();
  if (!key || user.relationship?.following === true || followBackBusy.has(key)) return;
  if (monitor.pausedUntil && Date.now() < new Date(monitor.pausedUntil).getTime()) {
    networkStatus(`关注受限已暂停至 ${new Date(monitor.pausedUntil).toLocaleString()}，请稍后再试。`);
    return;
  }
  followBackBusy.add(key);
  setMonitorIconButtonState(button, true, '关注中…');
  try {
    networkStatus(`正在通过 X 接口关注 @${user.handle}…`);
    const tabId = await backgroundXActionTab();
    const result = await followViaNetwork(tabId, user);
    if (result.ok || result.reason === 'already_following') {
      const followedBy = result.target?.relationshipKnown ? result.target.relationship.followedBy : user.relationship?.followedBy;
      const updatedRel = {
        ...(user.relationship || {}),
        following: true,
        ...(typeof followedBy === 'boolean' ? {followedBy} : {})
      };
      user.relationship = updatedRel;
      user.state = 'following';
      if (typeof followedBy === 'boolean') user.relationshipKnown = true;
      const item = (mutualNetwork.users || []).find(u => u.handle.toLowerCase() === key);
      if (item) {
        item.relationship = {...(item.relationship || {}), ...updatedRel};
        item.state = 'following';
        if (typeof followedBy === 'boolean') item.relationshipKnown = true;
      }
      if (!(monitor.followingUsers || []).some(u => u.handle?.toLowerCase() === key)) {
        monitor.followingUsers = [...(monitor.followingUsers || []), {...user, relationship: updatedRel, state: 'following'}];
      }
      await markQueueFollowed(user);
      await saveMutualNetwork();
      renderMutualNetwork();
      networkStatus(result.ok ? (result.unblocked ? `已通过 X 接口解除屏蔽并关注 @${user.handle}。` : `已通过 X 接口关注 @${user.handle}。`) : `@${user.handle} 已是关注状态。`);
      return;
    }
    if (result.reason === 'rate_limited') {
      monitor.pausedUntil = new Date(Date.now() + 60 * 60000).toISOString();
      await chrome.storage.local.set({monitor});
      persist('monitor', monitor);
      networkStatus(`@${user.handle} 触发关注限制，已暂停至 ${new Date(monitor.pausedUntil).toLocaleString()}。`);
      return;
    }
    networkStatus(`@${user.handle} 未执行关注：${result.error || result.reason}`);
  } catch (error) {
    networkStatus(`@${user.handle} 接口关注失败：${error.message}`);
  } finally {
    followBackBusy.delete(key);
    if (button.isConnected) setMonitorIconButtonState(button, false, '关注');
    renderMutualNetwork();
  }
}

async function readPostsFromProfileTab(tabId, handle, recentLimit = 10, maxWaitMs = 5000) {
  if (!tabId || !handle) return [];
  try {
    const current = await chrome.tabs.get(tabId).catch(() => null);
    if (!current) return [];
    const targetUrl = `https://x.com/${handle}`;
    if (!new RegExp(`^https://(?:x|twitter)\\.com/${handle}(?:[/?#]|$)`, 'i').test(current.url || '')) {
      await chrome.tabs.update(tabId, {url: targetUrl});
    }
    const deadline = Date.now() + maxWaitMs;
    let bestPosts = [];
    while (Date.now() < deadline) {
      const tabState = await chrome.tabs.get(tabId).catch(() => null);
      if (!tabState) break;
      if (tabState.status === 'complete') {
        const data = (await chrome.scripting.executeScript({
          target: {tabId},
          func: readProfileBundle,
          args: [handle, recentLimit]
        }).catch(() => []))?.[0]?.result;
        if (data && !data.pending && Array.isArray(data.posts)) {
          bestPosts = data.posts;
          if (bestPosts.length >= 5) break;
        }
      }
      await sleep(550);
    }
    return bestPosts;
  } catch {
    return [];
  }
}

async function fetchUserProfileNetwork(user, tabId, readHomePosts = false) {
  const handle = String(user?.handle || '').replace(/^@/, '');
  if (!handle) throw new Error('无效账号');
  try {
    const profileRes = await networkFetch(tabId, 'UserByScreenName', {screen_name: handle});
    if (profileRes.status === 200 && profileRes.json) {
      const parsed = parseNetworkUsers(profileRes.json).find(u => u.handle.toLowerCase() === handle.toLowerCase());
      if (parsed) {
        const updated = {
          name: repairMojibake(parsed.name || user.name || handle),
          bio: repairMojibake(parsed.bio || user.bio || ''),
          followersText: parsed.followersText || user.followersText || '',
          followingText: parsed.followingText || user.followingText || ''
        };
        if (parsed.relationshipKnown) {
          updated.relationship = parsed.relationship;
          updated.relationshipKnown = true;
        }
        const preEval = evaluateMutualProfile({...user, ...updated});
        if (readHomePosts || (!preEval.promise && !preEval.hasBaitRisk && !(user.posts?.length))) {
          const posts = await readPostsFromProfileTab(tabId, handle, 10, readHomePosts ? 6000 : 4000);
          if (posts.length) updated.posts = posts;
        }
        return updated;
      }
    }
  } catch {}
  const bundle = await readProfileBundleInBackground({handle}, 10);
  return {
    name: repairMojibake(bundle.name || user.name || handle),
    bio: repairMojibake(bundle.bio || user.bio || ''),
    followersText: bundle.followersText || user.followersText || '',
    followingText: bundle.followingText || user.followingText || '',
    posts: bundle.posts || user.posts || []
  };
}

async function refreshMutualUser(user) {
  const key = String(user?.handle || '').toLowerCase();
  if (!key || profileRefreshBusy.has(key)) return;
  profileRefreshBusy.add(key);
  renderMutualNetwork();
  networkStatus(`正在更新 @${user.handle} 的公开资料与首页前 5–10 条帖子…`);
  let tabId;
  try {
    tabId = await backgroundProfileTab(user.handle);
    const updated = await fetchUserProfileNetwork(user, tabId, true);
    Object.assign(user, updated);
    applyProfileToMonitor(Object.assign({handle: user.handle}, updated));
    const item = (mutualNetwork.users || []).find(u => u.handle.toLowerCase() === key);
    if (item) Object.assign(item, updated);
    profileCache[key] = {...(profileCache[key] || {}), ...user, ...updated};
    await saveMutualNetwork();
    await chrome.storage.local.set({monitor, profileCache});
    persist('monitor', monitor);
    persist('profileCache', profileCache);
    const evalRes = evaluateMutualProfile(profileCache[key]);
    networkStatus(`@${user.handle} 已更新（标签：${evalRes.tag}${evalRes.keywordHits?.length ? `，命中：${evalRes.keywordHits.join('、')}` : ''} · ${evalRes.recommendLabel}）。`);
  } catch (error) {
    networkStatus(`@${user.handle} 更新失败：${error.message}`);
  } finally {
    profileRefreshBusy.delete(key);
    if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
    renderMutualNetwork();
  }
}

let batchRefreshRunning = false;
async function batchRefreshMutualNetwork() {
  if (batchRefreshRunning) {
    batchRefreshRunning = false;
    networkStatus('正在停止批量更新…');
    return;
  }
  const selectedList = selectedMutualUsersList();
  let targetUsers = selectedList;
  let modeLabel = `已勾选的 ${selectedList.length} 个`;
  if (!targetUsers.length) {
    const users = getFilteredMutualUsers();
    if (!users.length) {
      networkStatus('当前列表下没有账号可更新。');
      return;
    }
    const startIdx = (mutualPage - 1) * mutualPageSize;
    targetUsers = users.slice(startIdx, startIdx + mutualPageSize);
    modeLabel = `当前页 ${targetUsers.length} 个`;
  }
  if (!targetUsers.length) return;

  batchRefreshRunning = true;
  const btn = $('batchRefreshMutual');
  if (btn) btn.textContent = '停止更新';
  networkStatus(`准备批量更新${modeLabel}账号的信息…`);

  let tabId;
  try {
    tabId = await backgroundProfileTab(mutualNetwork.anchor || targetUsers[0].handle);
    let updatedCount = 0;
    for (let i = 0; i < targetUsers.length; i++) {
      if (!batchRefreshRunning) break;
      const user = targetUsers[i];
      const key = user.handle.toLowerCase();
      networkStatus(`正在更新 (${i + 1}/${targetUsers.length})：@${user.handle}…`);
      try {
        const updated = await fetchUserProfileNetwork(user, tabId);
        Object.assign(user, updated);
        applyProfileToMonitor(Object.assign({handle: user.handle}, updated));
        const item = (mutualNetwork.users || []).find(u => u.handle.toLowerCase() === key);
        if (item) Object.assign(item, updated);
        profileCache[key] = {...(profileCache[key] || {}), ...user, ...updated};
        updatedCount++;
        renderMutualNetwork();
      } catch (e) {}
      if (i % 5 === 0 || i === targetUsers.length - 1) {
        await saveMutualNetwork();
        await chrome.storage.local.set({monitor, profileCache});
        persist('monitor', monitor);
        persist('profileCache', profileCache);
      }
      await sleep(250);
    }
    networkStatus(`批量更新完成，已成功更新 ${updatedCount} 个账号的信息。`);
  } catch (error) {
    networkStatus(`批量更新出错：${error.message}`);
  } finally {
    batchRefreshRunning = false;
    if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
    await saveMutualNetwork();
    renderMutualNetwork();
  }
}

async function saveMutualAutoFollowSettings() {
  const current = getMutualAutoConfig();
  const next = {
    ...current,
    enabled: Boolean($('mutualAutoEnabled')?.checked),
    every: Number($('mutualAutoEvery')?.value || 5),
    jitter: Number($('mutualAutoJitter')?.value || 0),
    batchLimit: Math.max(1, Math.min(20, Number($('mutualAutoBatchSize')?.value || 10))),
    scrollRounds: Math.max(1, Math.min(8, Number($('mutualAutoScrollRounds')?.value || 5))),
    dwellSeconds: Math.max(2, Math.min(60, Number($('mutualAutoDwellSec')?.value || 15))),
    minFollowers: Math.max(0, Number($('mutualAutoMinFollowers')?.value ?? 50)),
    onlyMutualIntent: $('mutualAutoOnlyIntent') ? $('mutualAutoOnlyIntent').checked : true,
    grokAutoComment: Boolean($('mutualAutoGrokComment')?.checked)
  };
  if (!Number.isFinite(next.every) || next.every < 5) throw new Error('定时执行周期至少 5 分钟。');
  if (!Number.isFinite(next.jitter) || next.jitter < 0 || next.jitter >= next.every) throw new Error('随机浮动必须大于等于 0 且小于定时执行周期。');
  mutualNetwork.autoFollow = next;
  await saveMutualNetwork();
  await persistAutoFollowSettings('mutual', next);
  renderMutualSettingsDrawer();
  await chrome.alarms.clear('x-mutual-auto-follow');
  if (next.enabled) {
    const delta = next.jitter > 0 ? Math.floor((Math.random() * 2 - 1) * next.jitter) : 0;
    const delay = Math.max(5, next.every + delta);
    await chrome.alarms.create('x-mutual-auto-follow', {delayInMinutes: delay});
  }
}

function extractGrokCommentReply(rawText, cleanHandle) {
  if (!rawText) return '';
  const text = String(rawText).trim();
  const marker = `[@${cleanHandle} | 回评:`;
  const idx = text.lastIndexOf(marker);
  if (idx !== -1) {
    const after = text.slice(idx + marker.length);
    const endIdx = after.indexOf(']');
    const candidate = (endIdx !== -1 ? after.slice(0, endIdx) : after).trim();
    if (candidate.length >= 4) {
      return candidate.replace(/\n+/g, ' ').trim();
    }
  }

  const match = /回评[:：]\s*([^\n\]]{6,160})/i.exec(text.slice(-1500));
  if (match && match[1]) {
    return match[1].replace(/\n+/g, ' ').trim();
  }

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.length >= 8 && line.length <= 150 && !/Thinking about|Regenerate|Copy text|Go to grok/i.test(line)) {
      return line.replace(/^["'“‘]|["'”’]$/g, '').trim();
    }
  }
  return '';
}

function driveGrokInput(prompt) {
  return (async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const findTa = () => {
      const root = document.getElementById('react-root');
      if (!root) return null;
      return Array.prototype.find.call(
        document.querySelectorAll('textarea'),
        (t) => root.contains(t) && t.offsetParent !== null && t.getBoundingClientRect().width > 100
      ) || null;
    };
    const findBtn = () => Array.prototype.find.call(
      document.querySelectorAll('button'),
      (b) => {
        const label = `${b.getAttribute('aria-label') || ''} ${b.innerText || ''} ${b.getAttribute('data-testid') || ''}`;
        return /Grok something|send|提交|发送/i.test(label);
      }
    );
    const ready = (b) => b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';

    let el = null;
    for (let i = 0; i < 30 && !el; i++) {
      el = findTa();
      if (!el) await sleep(500);
    }
    if (!el) return { ok: false, err: 'Grok 输入框未挂载' };

    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(el, prompt);
    else el.value = prompt;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    if (el.value !== prompt) {
      return { ok: false, err: '输入框未收下 prompt' };
    }

    let btn = null;
    for (let i = 0; i < 20; i++) {
      btn = findBtn();
      if (ready(btn)) break;
      await sleep(250);
    }
    const sawBtn = !!btn;
    if (ready(btn)) {
      btn.click();
    } else {
      el.focus();
      const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      for (const type of ['keydown', 'keypress', 'keyup']) {
        el.dispatchEvent(new KeyboardEvent(type, key));
      }
    }

    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const ta = findTa();
      if (!ta || ta.value === '') return { ok: true };
      if (sawBtn && !findBtn()) return { ok: true };
    }
    return { ok: true };
  })();
}

function readGrokDomAnswer(anchor) {
  const labels = Array.prototype.map.call(
    document.querySelectorAll('button'), (b) => b.getAttribute('aria-label') || b.innerText || ''
  );
  const done = labels.some(l => /Regenerate|Copy text|重新生成|复制文本/i.test(l));

  const root = document.querySelector('[data-testid=primaryColumn]') || document.body;
  const t = root.innerText || '';

  const FAIL = /Grok was unable to reply|Something went wrong, please refresh|操作过于频繁|无法回复/;
  const i = anchor ? t.lastIndexOf(anchor) : 0;
  if (i < 0) return { text: '', done: false };

  if (FAIL.test(t.slice(i))) {
    const leaf = Array.prototype.find.call(
      document.querySelectorAll('span,div,button'),
      (e) => e.children.length === 0 && /Retry|重试/i.test((e.innerText || '').trim())
    );
    if (leaf) {
      let n = leaf;
      for (let k = 0; k < 6 && n; k++) {
        if (n.tagName === 'BUTTON' || n.getAttribute('role') === 'button') break;
        n = n.parentElement;
      }
      (n || leaf).click();
    }
    return { text: '', done: false, failed: true };
  }

  const JUNK = [
    'Quick Answer', 'Auto', 'Think Harder', 'Fast', 'Expert',
    '自动', '快速', '专家', 'Go to grok.com',
    'Regenerate', 'Copy text', '重新生成', '复制文本',
    'Share', 'New Chat', 'See new posts', 'Stop', 'Thought for a moment'
  ];
  const THINKING = 'Thinking about your request';
  const text = t.slice(i + (anchor ? anchor.length : 0)).split('\n')
    .filter(line => {
      const l = line.trim();
      if (!l) return false;
      if (JUNK.includes(l)) return false;
      if (l.startsWith(THINKING)) return false;
      return true;
    })
    .join('\n').trim();

  return { text, done };
}

// ==============================================================================
// Grok 多平台（x.com 与 grok.com）可用性探测与降级驱动机制
// ==============================================================================
let cachedGrokAvailability = null;
let lastGrokCheckTime = 0;

function probeXGrokInPage() {
  const root = document.getElementById('react-root');
  if (!root) return { ok: false, reason: '未找到 X 页面根容器' };
  const text = (document.body.innerText || '').slice(0, 3000);
  if (/Subscribe to Premium|Upgrade to Premium|Upgrade to SuperGrok|Grok is not available in your region/i.test(text)) {
    return { ok: false, reason: 'x.com 账号未开通 Grok 权限（需订阅 Premium）' };
  }
  if (/Grok was unable to reply|Something went wrong, please refresh|Failed to load models|Unable to load model/i.test(text)) {
    return { ok: false, reason: 'x.com Grok 服务暂时异常或被限流' };
  }
  const ta = Array.prototype.find.call(
    document.querySelectorAll('textarea'),
    t => root.contains(t) && t.offsetParent !== null && t.getBoundingClientRect().width > 80
  );
  if (!ta) return { ok: false, reason: '未找到 x.com 输入框（未开通或被限制）' };
  return { ok: true, reason: 'x.com Grok 正常可用' };
}

function probeGrokComInPage() {
  const url = window.location.href;
  if (/login|signin/i.test(url)) {
    return { ok: false, reason: 'grok.com 用户未登录' };
  }
  const bodyText = (document.body ? document.body.innerText : '') || '';
  if (/(Sign in|Log in to continue|Sign in with X)/i.test(bodyText) && !document.querySelector('textarea, [contenteditable="true"]')) {
    return { ok: false, reason: 'grok.com 用户未登录' };
  }
  if (/Subscription required|Upgrade to continue|Limit reached/i.test(bodyText)) {
    return { ok: false, reason: 'grok.com 未开通使用权限或额度耗尽' };
  }

  // 精准识别 grok.com 出现的 "Failed to load models. Retry" 故障
  const hasModelFailText = /Failed to load models|Unable to load model|Failed to fetch models|No models available/i.test(bodyText);
  const modelFailEl = Array.from(document.querySelectorAll('*')).find(
    el => el.children.length === 0 && /Failed to load models/i.test(el.textContent || '')
  );
  if (hasModelFailText || modelFailEl) {
    // 尝试寻找弹出的 Retry 按钮自动点击一次尝试恢复
    const retryBtn = Array.from(document.querySelectorAll('button, a, span, div[role="button"]'))
      .find(el => el.textContent && /Retry|重试/i.test(el.textContent.trim()) && el.offsetParent !== null);
    if (retryBtn) {
      try { retryBtn.click(); } catch (e) {}
    }
    return { ok: false, reason: 'grok.com 模型加载失败 (Failed to load models. Retry)' };
  }

  if (/Something went wrong|Service unavailable/i.test(bodyText) && !document.querySelector('textarea, [contenteditable="true"]')) {
    return { ok: false, reason: 'grok.com 服务暂时不可用' };
  }

  const inputEl = document.querySelector('textarea, [contenteditable="true"], [data-placeholder], input[type="text"]');
  if (inputEl) {
    return { ok: true, reason: 'grok.com 已登录且开通可用' };
  }
  return { ok: false, reason: '未在 grok.com 找到对话输入框' };
}

function driveGrokComInput(prompt) {
  const bodyText = (document.body ? document.body.innerText : '') || '';
  if (/Failed to load models|Unable to load model/i.test(bodyText)) {
    return { ok: false, err: 'grok.com 模型加载失败 (Failed to load models)' };
  }
  const inputEl = document.querySelector('textarea, [contenteditable="true"]');
  if (!inputEl) return { ok: false, err: '未找到 grok.com 输入框' };
  if (inputEl.tagName === 'TEXTAREA') {
    const proto = Object.getPrototypeOf(inputEl);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(inputEl, prompt);
    else inputEl.value = prompt;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    inputEl.focus();
    inputEl.textContent = prompt;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const submitBtn = document.querySelector('button[type="submit"], button[aria-label*="Send"], button[aria-label*="提交"], button svg[data-icon="arrow-up"]')?.closest('button');
  if (submitBtn && !submitBtn.disabled) {
    submitBtn.click();
    return { ok: true };
  }
  inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  return { ok: true };
}

function readGrokComDomAnswer(anchor) {
  const text = (document.body ? document.body.innerText : '') || '';
  if (/Failed to load models|Unable to load model/i.test(text)) {
    return { text: '', done: true, err: 'grok.com 模型加载失败' };
  }
  const i = text.lastIndexOf(anchor);
  if (i < 0) return { text: '', done: false };
  const slice = text.slice(i + anchor.length).trim();
  const done = !document.querySelector('button[aria-label*="Stop"], .animate-spin') && slice.length > 10;
  return { text: slice, done };
}

async function checkGrokAvailability(force = false) {
  const now = Date.now();
  if (!force && cachedGrokAvailability && (now - lastGrokCheckTime < 300000)) {
    return cachedGrokAvailability;
  }

  let xOk = false;
  let xReason = '';
  let grokComOk = false;
  let grokComReason = '';

  // 1. 测试 x.com/i/grok
  let winX = null;
  try {
    winX = await chrome.windows.create({
      url: 'https://x.com/i/grok',
      type: 'popup',
      state: 'minimized',
      focused: false
    });
    const tabId = winX.tabs?.[0]?.id || (await chrome.tabs.query({ windowId: winX.id }))?.[0]?.id;
    if (tabId) {
      await sleep(3500);
      const res = (await chrome.scripting.executeScript({
        target: { tabId },
        func: probeXGrokInPage
      }).catch(() => []))?.[0]?.result;
      if (res) {
        xOk = Boolean(res.ok);
        xReason = res.reason;
      }
    }
  } catch (err) {
    xReason = err.message;
  } finally {
    if (winX?.id) await chrome.windows.remove(winX.id).catch(() => {});
  }

  // 2. 如果 x.com 正常，优先使用 x.com
  if (xOk) {
    cachedGrokAvailability = {
      available: true,
      activeChannel: 'x.com',
      message: 'x.com Grok 正常开通且可用',
      xReason,
      grokComReason: '未测试（x.com 已可用）'
    };
    lastGrokCheckTime = now;
    return cachedGrokAvailability;
  }

  // 3. x.com 不可用时，探测 grok.com 用户是否已开通且模型正常
  let winGrok = null;
  try {
    winGrok = await chrome.windows.create({
      url: 'https://grok.com/',
      type: 'popup',
      state: 'minimized',
      focused: false
    });
    const tabId = winGrok.tabs?.[0]?.id || (await chrome.tabs.query({ windowId: winGrok.id }))?.[0]?.id;
    if (tabId) {
      await sleep(3500);
      const res = (await chrome.scripting.executeScript({
        target: { tabId },
        func: probeGrokComInPage
      }).catch(() => []))?.[0]?.result;
      if (res) {
        grokComOk = Boolean(res.ok);
        grokComReason = res.reason;
      }
    }
  } catch (err) {
    grokComReason = err.message;
  } finally {
    if (winGrok?.id) await chrome.windows.remove(winGrok.id).catch(() => {});
  }

  // 4. 综合判断：若 grok.com 可用，使用 grok.com；若两者均不可用，则评论不可用
  if (grokComOk) {
    cachedGrokAvailability = {
      available: true,
      activeChannel: 'grok.com',
      message: `x.com 不可用（${xReason}），已切换为 grok.com 备用通道`,
      xReason,
      grokComReason
    };
  } else {
    cachedGrokAvailability = {
      available: false,
      activeChannel: null,
      message: `x.com（${xReason || '不可用'}）与 grok.com（${grokComReason || '未登录/未开通/模型加载失败'}）均不可用，评论生成不可用`,
      xReason,
      grokComReason
    };
  }

  lastGrokCheckTime = now;
  return cachedGrokAvailability;
}

async function requestGrokReplyForPost(handle, post, authorName = '') {
  if (!post || !post.text) return null;

  // 1. 优先读取 Grok 可用性检测结果，若均不可用立即跳过，避免长时间阻塞看帖和关注流程
  const status = await checkGrokAvailability(false);
  if (!status.available) {
    console.warn('Grok 评论服务当前不可用，跳过回评生成:', status.message);
    return null;
  }

  const postText = (post.text || '').trim();
  const cleanHandle = String(handle || '').replace(/^@/, '');
  const cleanName = repairMojibake(authorName || cleanHandle);
  const anchorLine = `[@${cleanHandle} | 回评: 你的评论内容]`;
  const prompt = [
    `你是一位推特（X平台）上的互动高手。请针对博主 @${cleanHandle}（昵称：${cleanName}）发布的以下推文，生成一条自然真实、高情商、有共鸣、能激发博主回评互动的高质量简短评论：`,
    '要求：',
    '1. 字数控制在 25 到 80 个字以内；',
    '2. 紧扣推文具体内容和观点，提出真诚的问题、独到的共鸣或有趣的切入点，切忌空洞客套；',
    '3. 严禁以“作为AI”、“非常赞同”等机械刻板句式开头，要像真诚的推友即兴交流；',
    '4. 回复的最末尾请务必以如下标准格式单独输出回评（便于工具提取）：',
    anchorLine,
    '',
    '推文正文：',
    postText.slice(0, 500)
  ].join('\n');

  // 如果已知只有 grok.com 可用（例如 x.com 未开通 Premium），直接走 grok.com 通道
  if (status.activeChannel !== 'grok.com') {
    let createdWindow = null;
    let streamText = null;
    const streamPromise = new Promise(resolve => {
      activeGrokStreamResolver = resolve;
    });
    streamPromise.then(text => { streamText = text; }).catch(() => {});

    try {
      createdWindow = await chrome.windows.create({
        url: 'https://x.com/i/grok',
        type: 'popup',
        state: 'minimized',
        focused: false
      });
      let tabId = createdWindow.tabs?.[0]?.id;
      if (!tabId && createdWindow.id) {
        const tabs = await chrome.tabs.query({windowId: createdWindow.id});
        tabId = tabs?.[0]?.id;
      }
      if (tabId) {
        await sleep(2500);
        const xProbe = (await chrome.scripting.executeScript({
          target: {tabId},
          func: probeXGrokInPage
        }).catch(() => []))?.[0]?.result;

        if (xProbe?.ok) {
          // 驱动输入框填入并提交（MAIN world）
          const driveRes = (await chrome.scripting.executeScript({
            target: {tabId},
            world: 'MAIN',
            func: driveGrokInput,
            args: [prompt]
          }).catch(() => []))?.[0]?.result;

          if (!driveRes?.ok) {
            console.warn('Grok 驱动发送状态:', driveRes?.err || '已尝试发送');
          }

          // 双通道等待答案（最长 45 秒）
          const deadline = Date.now() + 45000;
          let reply = '';
          let lastDomText = '';
          let stableRounds = 0;

          while (Date.now() < deadline) {
            if (streamText) {
              reply = extractGrokCommentReply(streamText, cleanHandle);
              if (reply) break;
            }

            await sleep(2000);

            try {
              const out = await chrome.scripting.executeScript({
                target: {tabId},
                world: 'MAIN',
                func: readGrokDomAnswer,
                args: [anchorLine]
              });
              const domRes = out?.[0]?.result;
              if (domRes?.text) {
                const extracted = extractGrokCommentReply(domRes.text, cleanHandle);
                if (domRes.done && extracted) {
                  reply = extracted;
                  break;
                }
                if (extracted && extracted === lastDomText) {
                  stableRounds++;
                  if (stableRounds >= 3) {
                    reply = extracted;
                    break;
                  }
                } else if (extracted) {
                  lastDomText = extracted;
                  stableRounds = 0;
                }
              }
            } catch (err) {}
          }

          if (reply) {
            return {
              reply,
              postText: postText.slice(0, 140),
              postUrl: post.url || ''
            };
          }
        }
      }
    } catch (e) {
      console.warn('x.com Grok 调用异常，尝试备用通道:', e);
    } finally {
      activeGrokStreamResolver = null;
      if (createdWindow?.id) {
        await chrome.windows.remove(createdWindow.id).catch(() => {});
      }
    }
  }

  // 备用通道：尝试 grok.com
  let grokComWindow = null;
  try {
    grokComWindow = await chrome.windows.create({
      url: 'https://grok.com/',
      type: 'popup',
      state: 'minimized',
      focused: false
    });
    const gTabId = grokComWindow.tabs?.[0]?.id || (await chrome.tabs.query({ windowId: grokComWindow.id }))?.[0]?.id;
    if (gTabId) {
      await sleep(3500);
      const probeRes = (await chrome.scripting.executeScript({
        target: { tabId: gTabId },
        func: probeGrokComInPage
      }).catch(() => []))?.[0]?.result;

      if (probeRes?.ok) {
        const driveRes = (await chrome.scripting.executeScript({
          target: { tabId: gTabId },
          func: driveGrokComInput,
          args: [prompt]
        }).catch(() => []))?.[0]?.result;

        if (driveRes?.err) {
          console.warn('grok.com 输入驱动错误:', driveRes.err);
        }

        const gDeadline = Date.now() + 40000;
        let gReply = '';
        while (Date.now() < gDeadline) {
          await sleep(2500);
          const out = await chrome.scripting.executeScript({
            target: { tabId: gTabId },
            func: readGrokComDomAnswer,
            args: [anchorLine]
          }).catch(() => []);
          const res = out?.[0]?.result;
          if (res?.err) {
            console.warn('grok.com 运行异常:', res.err);
            break;
          }
          if (res?.text) {
            const ext = extractGrokCommentReply(res.text, cleanHandle);
            if (res.done && ext) {
              gReply = ext;
              break;
            }
          }
        }

        if (gReply) {
          return {
            reply: gReply,
            postText: postText.slice(0, 140),
            postUrl: post.url || ''
          };
        }
      } else {
        console.warn('grok.com 备用通道不可用:', probeRes?.reason || '未开通或未登录');
        cachedGrokAvailability = {
          available: false,
          activeChannel: null,
          message: `grok.com 不可用（${probeRes?.reason || '模型加载失败/未开通'}），评论功能不可用`,
          xReason: status.xReason,
          grokComReason: probeRes?.reason || '不可用'
        };
      }
    }
  } catch (grokErr) {
    console.warn('grok.com 备用通道执行异常:', grokErr);
  } finally {
    if (grokComWindow?.id) {
      await chrome.windows.remove(grokComWindow.id).catch(() => {});
    }
  }

  console.warn('x.com 与 grok.com 均未能生成回评，评论功能不可用');
  return null;
}

async function visitScrollAndFollowCandidate(user, cfg) {
  const handle = String(user?.handle || '').replace(/^@/, '');
  const key = handle.toLowerCase();
  const tab = await chrome.tabs.create({url: `https://x.com/${handle}`, active: false});
  if (!tab?.id) throw new Error('无法创建主页标签页');
  const tabId = tab.id;
  try {
    const deadline = Date.now() + 22000;
    let bundle = {pending: true};
    while (Date.now() < deadline && bundle.pending) {
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (!t) throw new Error('主页标签页已关闭');
      if (t.status === 'complete') {
        bundle = (await chrome.scripting.executeScript({
          target: {tabId},
          func: readProfileBundle,
          args: [handle, 10]
        }).catch(() => []))?.[0]?.result || bundle;
      }
      if (bundle.pending) await sleep(650);
    }

    const rounds = Math.max(1, Math.min(8, Number(cfg.scrollRounds) || 5));
    const totalDwellMs = Math.max(2000, Math.min(60000, (Number(cfg.dwellSeconds) || 15) * 1000));
    const stepDelay = Math.max(600, Math.round(totalDwellMs / rounds));

    for (let r = 0; r < rounds; r++) {
      networkStatus(`正在 @${handle} 首页下拉模拟看帖 (${r + 1}/${rounds})…`);
      await chrome.scripting.executeScript({
        target: {tabId},
        func: simulateProfileScrollStep,
        args: [r, 420]
      }).catch(() => {});
      await sleep(stepDelay + Math.floor(Math.random() * 350));
    }

    const afterScroll = (await chrome.scripting.executeScript({
      target: {tabId},
      func: readProfileBundle,
      args: [handle, 10]
    }).catch(() => []))?.[0]?.result;
    if (afterScroll && !afterScroll.pending) {
      bundle = afterScroll;
    }

    const updatedProfile = {
      ...user,
      ...(bundle.pending ? {} : bundle),
      name: repairMojibake(bundle.name || user.name || handle),
      bio: repairMojibake(bundle.bio || user.bio || ''),
      followersText: bundle.followersText || user.followersText || '',
      followingText: bundle.followingText || user.followingText || '',
      posts: bundle.posts || user.posts || [],
      profileCachedAt: new Date().toISOString()
    };
    profileCache[key] = {...(profileCache[key] || {}), ...updatedProfile};
    if (archiveCommentRecentPosts(updatedProfile)) await saveCommentTracking();
    applyProfileToMonitor(updatedProfile);
    const item = (mutualNetwork.users || []).find(u => u.handle.toLowerCase() === key);
    if (item) Object.assign(item, updatedProfile);

    let grokResult = null;
    if (cfg.grokAutoComment && Array.isArray(updatedProfile.posts) && updatedProfile.posts.length > 0) {
      const validPosts = updatedProfile.posts.filter(p => (p?.text || '').trim().length >= 8);
      const pool = validPosts.length > 0 ? validPosts : updatedProfile.posts;
      const chosenPost = pool[Math.floor(Math.random() * pool.length)];
      if (chosenPost && chosenPost.text) {
        networkStatus(`正在使用 Grok 为 @${handle} 的推文生成高情商互动回评建议…`);
        grokResult = await requestGrokReplyForPost(handle, chosenPost, updatedProfile.name);
        if (grokResult?.reply) {
          updatedProfile.grokComment = grokResult.reply;
          updatedProfile.grokCommentPost = grokResult.postText;
          updatedProfile.grokCommentPostUrl = grokResult.postUrl;
          if (profileCache[key]) {
            profileCache[key].grokComment = grokResult.reply;
            profileCache[key].grokCommentPost = grokResult.postText;
            profileCache[key].grokCommentPostUrl = grokResult.postUrl;
          }
          if (item) {
            item.grokComment = grokResult.reply;
            item.grokCommentPost = grokResult.postText;
            item.grokCommentPostUrl = grokResult.postUrl;
          }
        }
      }
    }

    const evalRes = evaluateMutualProfile(profileCache[key]);
    if (evalRes.isNotRecommended) {
      return {status: 'skipped', reason: evalRes.recommendReason};
    }
    if (cfg.onlyMutualIntent !== false && evalRes.tag !== '互粉' && evalRes.recommendLabel !== '推荐') {
      return {status: 'skipped', reason: evalRes.intentTooltip};
    }

    networkStatus(`已完成 @${handle} 首页看帖（读取 ${updatedProfile.posts?.length || 0} 条帖子 · ${evalRes.recommendLabel}），正在点击关注…`);
    let clickRes = (await chrome.scripting.executeScript({
      target: {tabId},
      func: clickAnyFollowOnProfile,
      args: [handle]
    }).catch(() => []))?.[0]?.result || {ok: false, reason: 'script_failed'};

    if (!clickRes.ok && clickRes.reason !== 'already_following' && clickRes.reason !== 'rate_limited') {
      clickRes = await followViaNetwork(tabId, updatedProfile);
    }

    if (clickRes.reason === 'rate_limited') {
      return {status: 'rate_limited', reason: '触发 X 关注频率限制'};
    }
    if (clickRes.ok || clickRes.reason === 'already_following') {
      const updatedRel = {...(user.relationship || {}), following: true};
      user.relationship = updatedRel;
      user.state = 'following';
      if (item) {
        item.relationship = {...(item.relationship || {}), following: true};
        item.state = 'following';
      }
      if (!(monitor.followingUsers || []).some(u => u.handle?.toLowerCase() === key)) {
        monitor.followingUsers = [...(monitor.followingUsers || []), {...updatedProfile, relationship: updatedRel, state: 'following'}];
      }
      await markQueueFollowed(updatedProfile);
      return {
        status: 'followed',
        evalResult: evalRes,
        grokComment: grokResult?.reply || '',
        grokCommentPost: grokResult?.postText || '',
        grokCommentPostUrl: grokResult?.postUrl || ''
      };
    }
    return {status: 'failed', reason: clickRes.error || clickRes.reason || '未找到关注按钮'};
  } finally {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}

async function runMutualAutoFollowBatch(source = 'manual') {
  if (mutualAutoRunning) {
    networkStatus('定时看帖关注任务正在运行中…');
    return;
  }
  if (monitor.pausedUntil && Date.now() < new Date(monitor.pausedUntil).getTime()) {
    networkStatus(`关注受限已暂停至 ${new Date(monitor.pausedUntil).toLocaleString()}，暂不执行自动关注。`);
    return;
  }
  const cfg = getMutualAutoConfig();
  const candidates = selectValuableMutualTargets(
    mutualNetwork.users || [],
    cfg,
    profileCache,
    ownFollowingHandles()
  );
  if (!candidates.length) {
    const msg = '当前没有符合条件的未关注价值账号（可先扩展互关追踪或批量更新资料）。';
    networkStatus(msg);
    mutualNetwork.autoFollow = {...cfg, lastRunAt: new Date().toISOString(), lastSummary: msg};
    await saveMutualNetwork();
    renderMutualSettingsDrawer();
    return;
  }

  mutualAutoRunning = true;
  renderMutualSettingsDrawer();
  let followedNow = 0;
  let skippedNow = 0;
  const processed = new Set((cfg.processedHandles || []).map(h => String(h || '').toLowerCase()));

  try {
    for (let i = 0; i < candidates.length; i++) {
      const target = candidates[i];
      const key = target.handle.toLowerCase();
      networkStatus(`[${source === 'alarm' ? '定时' : '仿真'}关注 ${i + 1}/${candidates.length}] 正在打开 @${target.handle} 首页下拉看帖…`);
      try {
        const res = await visitScrollAndFollowCandidate(target, cfg);
        processed.add(key);
        const postsScanned = profileCache[key]?.posts || target.posts || [];
        if (res.status === 'followed') {
          followedNow++;
          await recordAutoFollowLog({
            scope: 'mutual',
            source,
            handle: target.handle,
            name: target.name,
            result: 'followed',
            detail: `看帖停留 ${cfg.dwellSeconds || 15} 秒，评估通过（${res.evalResult?.recommendLabel || '推荐'}），点击关注成功。${res.grokComment ? '已由 Grok 生成互动回评。' : ''}`,
            posts: postsScanned,
            grokComment: res.grokComment || '',
            grokCommentPost: res.grokCommentPost || '',
            grokCommentPostUrl: res.grokCommentPostUrl || ''
          });
        } else if (res.status === 'skipped') {
          skippedNow++;
          await recordAutoFollowLog({
            scope: 'mutual',
            source,
            handle: target.handle,
            name: target.name,
            result: 'skipped',
            detail: `看帖评估未通过跳过：${res.reason || '不符合互粉意向或推荐标准'}`,
            posts: postsScanned
          });
        } else if (res.status === 'rate_limited') {
          await recordAutoFollowLog({
            scope: 'mutual',
            source,
            handle: target.handle,
            name: target.name,
            result: 'rate_limited',
            detail: '触发 X 关注频率受限，已自动暂停任务 1 小时。',
            posts: postsScanned
          });
          monitor.pausedUntil = new Date(Date.now() + 60 * 60000).toISOString();
          await chrome.storage.local.set({monitor});
          persist('monitor', monitor);
          networkStatus(`@${target.handle} 触发关注限制，已暂停 1 小时。`);
          break;
        } else {
          await recordAutoFollowLog({
            scope: 'mutual',
            source,
            handle: target.handle,
            name: target.name,
            result: 'failed',
            detail: `关注未完成：${res.reason || '未找到关注按钮或操作失败'}`,
            posts: postsScanned
          });
        }
      } catch (err) {
        processed.add(key);
        await recordAutoFollowLog({
          scope: 'mutual',
          source,
          handle: target.handle,
          name: target.name,
          result: 'failed',
          detail: `执行异常：${err?.message || String(err)}`,
          posts: profileCache[key]?.posts || []
        });
      }
      renderMutualNetwork();
      if (i < candidates.length - 1) {
        await sleep(1800 + Math.floor(Math.random() * 1500));
      }
    }
    const nextCfg = getMutualAutoConfig();
    const totalFollowed = (Number(nextCfg.followedCount) || 0) + followedNow;
    const summary = `本轮看帖关注 ${followedNow} 人${skippedNow ? `（跳过不推荐 ${skippedNow} 人）` : ''} · 累计已关注 ${totalFollowed} 人`;
    mutualNetwork.autoFollow = {
      ...nextCfg,
      processedHandles: [...processed].slice(-2000),
      followedCount: totalFollowed,
      lastRunAt: new Date().toISOString(),
      lastSummary: summary
    };
    await saveMutualNetwork();
    await chrome.storage.local.set({monitor, profileCache});
    persist('monitor', monitor);
    persist('profileCache', profileCache);
    networkStatus(summary);
  } finally {
    mutualAutoRunning = false;
    renderMutualSettingsDrawer();
    renderMutualNetwork();
  }
}

document.querySelectorAll('.mutual-tab').forEach(button => {
  button.addEventListener('click', () => {
    activeMutualTab = button.dataset.mutualTab;
    mutualPage = 1;
    renderMutualNetwork();
  });
});

$('mutualSelectAll')?.addEventListener('change', event => {
  const users = getFilteredMutualUsers();
  const startIdx = (mutualPage - 1) * mutualPageSize;
  const pageUsers = users.slice(startIdx, startIdx + mutualPageSize);
  for (const user of pageUsers) {
    const key = user.handle.toLowerCase();
    if (event.target.checked) selectedMutualHandles.add(key);
    else selectedMutualHandles.delete(key);
  }
  renderMutualNetwork();
});

$('mutualSearch')?.addEventListener('input', event => {
  mutualSearch = event.target.value;
  mutualPage = 1;
  renderMutualNetwork();
});
$('mutualSearchBtn')?.addEventListener('click', () => {
  mutualSearch = ($('mutualSearch')?.value || '').trim();
  mutualPage = 1;
  renderMutualNetwork();
});
$('mutualSearch')?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    mutualSearch = ($('mutualSearch')?.value || '').trim();
    mutualPage = 1;
    renderMutualNetwork();
  }
});

$('openMutualSettingsDrawer')?.addEventListener('click', openMutualSettingsDrawer);
$('closeMutualSettingsDrawer')?.addEventListener('click', closeMutualSettingsDrawer);
$('runMutualAutoNow')?.addEventListener('click', () => {
  runMutualAutoFollowBatch('manual').catch(error => networkStatus(`执行失败：${error.message}`));
});
$('mutualAutoEnabled')?.addEventListener('change', () => {
  saveMutualAutoFollowSettings()
    .then(() => {
      const cfg = getMutualAutoConfig();
      networkStatus(cfg.enabled ? `已开启互关追踪定时看帖关注，周期每 ${cfg.every}±${cfg.jitter || 0} 分钟（单次最多 ${cfg.batchLimit} 人）。` : '已关闭互关追踪定时看帖关注。');
    })
    .catch(error => networkStatus(error.message));
});
const debouncedSaveMutual = debounce(() => saveMutualAutoFollowSettings().catch(() => {}), 300);
for (const id of ['mutualAutoEvery', 'mutualAutoJitter', 'mutualAutoBatchSize', 'mutualAutoScrollRounds', 'mutualAutoDwellSec', 'mutualAutoMinFollowers', 'mutualAutoOnlyIntent', 'mutualAutoGrokComment']) {
  $(id)?.addEventListener('change', () => saveMutualAutoFollowSettings().catch(error => networkStatus(error.message)));
  $(id)?.addEventListener('input', debouncedSaveMutual);
}

window.addEventListener('beforeunload', () => {
  saveMutualAutoFollowSettings().catch(() => {});
  saveCommentAutoFollowSettings().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.cmd === 'grokStreamAnswer') {
    if (typeof activeGrokStreamResolver === 'function') {
      try { activeGrokStreamResolver(message.text || ''); } catch {}
    }
  }
  if (message?.cmd === 'runMutualAutoFollowTick') {
    sendResponse({ok: true, handledByPanel: true});
    runMutualAutoFollowBatch('alarm').catch(() => {});
    return true;
  }
  if (message?.cmd === 'runUnreciprocatedTick') {
    sendResponse({ok: true, handledByPanel: true});
    runUnreciprocatedCheckCycle('alarm').catch(() => {});
    return true;
  }
});

$('batchRefreshMutual')?.addEventListener('click', batchRefreshMutualNetwork);

$('mutualPrevPage')?.addEventListener('click', () => {
  if (mutualPage > 1) {
    mutualPage--;
    renderMutualNetwork();
  }
});
$('mutualNextPage')?.addEventListener('click', () => {
  mutualPage++;
  renderMutualNetwork();
});
$('mutualPageSize')?.addEventListener('change', event => {
  mutualPageSize = Number(event.target.value) || 50;
  mutualPage = 1;
  renderMutualNetwork();
});


async function collectMutualNetwork(rawAnchor, reset = false) {
  if (mutualNetworkRunning) return;
  let anchor;
  try { anchor = normalizeHandle(rawAnchor); } catch (error) { networkStatus(error.message); return; }
  mutualNetworkRunning = true; $('collectNetwork').disabled = true; networkStatus(`正在以 @${anchor} 为锚点，静默读取 following 与 followers…`);
  try {
    if (reset) {
      mutualNetwork = {anchor, anchors:[], users:[], lastCollected:null, autoFollow: getMutualAutoConfig()};
      selectedMutualHandles.clear();
      mutualPage = 1;
    }
    const limit = Number($('networkLimit').value) || 500;
    const result = await collectRelations(anchor, limit);
    const next = new Map((mutualNetwork.users || []).map(user => [user.handle.toLowerCase(), {...user, sourceAnchors:[...(user.sourceAnchors || [])]}]));
    const relationMap = new Map();
    for (const user of result.following) {
      const key=user.handle.toLowerCase();
      relationMap.set(key, mergeNetworkAccount(relationMap.get(key), user));
    }
    for (const user of result.followers) {
      const key=user.handle.toLowerCase();
      relationMap.set(key, mergeNetworkAccount(relationMap.get(key), user));
    }
    for (const [key, user] of relationMap) {
      const old = next.get(key) || {}; const sources = new Set([...(old.sourceAnchors || []), anchor]);
      const merged = mergeNetworkAccount(old, user);
      next.set(key, {...merged, sourceAnchors:[...sources], discoveredAt:old.discoveredAt || new Date().toISOString()});
    }
    mutualNetwork = {...mutualNetwork, anchor, anchors:[...new Set([...(mutualNetwork.anchors || []), anchor])], users:[...next.values()], lastCollected:new Date().toISOString()};
    await saveMutualNetwork(); renderMutualNetwork();
    const relationCounts = Object.groupBy ? Object.groupBy([...relationMap.values()].map(applyOwnFollowingSnapshot), personalRelationshipLabel) : [...relationMap.values()].map(applyOwnFollowingSnapshot).reduce((groups, user) => { const label=personalRelationshipLabel(user); groups[label] ||= []; groups[label].push(user); return groups; }, {});
    networkStatus(`@${anchor} 已发现 ${relationMap.size} 个账号；与你互相关注 ${relationCounts['互相关注']?.length || 0} 个，对方关注你 ${relationCounts['对方关注你']?.length || 0} 个，你关注对方 ${relationCounts['你关注对方']?.length || 0} 个，你未关注对方 ${relationCounts['你未关注对方']?.length || 0} 个，关系未知 ${relationCounts['关系未知']?.length || 0} 个。`);
  } catch (error) { networkStatus(`@${anchor} 收集失败：${error.message}`); }
  finally { mutualNetworkRunning=false; $('collectNetwork').disabled=false; }
}
async function markQueueFollowed(user) {
  const key = user.handle.toLowerCase();
  registerTrackedFollow(user);
  const now = new Date().toISOString();
  const stamp = entry => { entry.followedAt = now; delete entry.followBackAt; entry.relationship = {...(entry.relationship || {}), following: true}; };
  const item = (monitor.queue || []).find(entry => entry.handle?.toLowerCase() === key);
  if (item) { item.status = 'followed'; stamp(item); }
  const userItem = (monitor.users || []).find(entry => entry.handle?.toLowerCase() === key);
  if (userItem) { userItem.state = 'following'; stamp(userItem); }
  const mutualItem = (mutualNetwork.users || []).find(entry => entry.handle?.toLowerCase() === key);
  if (mutualItem) { mutualItem.state = 'following'; stamp(mutualItem); }
  const followingItem = (monitor.followingUsers || []).find(entry => entry.handle?.toLowerCase() === key);
  if (followingItem) stamp(followingItem);
  const commentItem = (commentTracking.users || []).find(entry => String(entry.handle || '').toLowerCase() === key);
  if (commentItem) { stamp(commentItem); await chrome.storage.local.set({commentTracking}); persist('commentTracking', commentTracking); }
  user.followedAt = now;
  await chrome.storage.local.set({monitor, mutualNetwork});
  persist('monitor', monitor);
  persist('mutualNetwork', mutualNetwork);
  renderMonitorList();
  renderMutualNetwork();
  renderCommentTracking();
}

async function markQueueBlocked(user) {
  const key = user.handle.toLowerCase();
  const item = (monitor.queue || []).find(entry => entry.handle?.toLowerCase() === key);
  if (item) {
    item.status = 'blocked';
    item.blockedAt = new Date().toISOString();
    item.blockReason = 'X relationship blocking';
  }
  await chrome.storage.local.set({monitor});
  persist('monitor', monitor);
  renderMonitorList();
}

function setFollowFailure(user, reason) {
  user.status = 'follow_failed';
  user.followFailedAt = new Date().toISOString();
  user.followFailureReason = String(reason || '关注请求未完成');
  user.lastError = user.followFailureReason;
}

async function markQueueFollowFailed(user, reason) {
  const key = user.handle.toLowerCase();
  const item = (monitor.queue || []).find(entry => entry.handle?.toLowerCase() === key);
  if (item) setFollowFailure(item, reason);
  await chrome.storage.local.set({monitor});
  persist('monitor', monitor);
  renderMonitorList();
}

async function backgroundXActionTab() {
  const tabs = await chrome.tabs.query({url:['https://x.com/*', 'https://twitter.com/*']});
  const existing = tabs.find(tab => tab.id && tab.status === 'complete' && !/\/i\/grok/i.test(tab.url || ''));
  if (existing?.id) return existing.id;
  const tab = await chrome.tabs.create({url:'https://x.com/home', active:false});
  if (!tab.id) throw new Error('无法创建 X 后台标签页');
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(500);
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (current?.status === 'complete') return tab.id;
  }
  throw new Error('X 后台标签页加载超时');
}

function isFollowRateLimited(response) {
  return response?.status === 429 || /rate limit|try again in an hour|too quickly|频率受限|操作过于频繁/i.test(String(response?.error || ''));
}

async function followViaNetwork(tabId, user) {
  let targetId = user.id || '';
  let target = null;
  const lookup = await networkFetch(tabId, 'UserByScreenName', {screen_name:user.handle});
  if (lookup.status === 200) {
    target = parseNetworkUsers(lookup.json).find(item => item.handle.toLowerCase() === user.handle.toLowerCase()) || null;
    if (target?.id) targetId = target.id;
    if (target?.relationship?.following) return {ok:false, reason:'already_following', target};
  } else if (!targetId) {
    return {ok:false, reason:'lookup_failed', error:lookup.error || `资料请求返回 ${lookup.status}`};
  }
  if (!targetId) return {ok:false, reason:'profile_unavailable', error:'未从 X 资料接口取得用户 ID'};
  // friendships/create is the X endpoint that performs a follow. X also clears
  // an existing block as part of a successful follow, so do not route a blocked
  // profile through the UI or discard it before making the request.
  const unblocked = target?.relationship?.blocking === true;
  const result = await networkFollow(tabId, targetId);
  if (result.status >= 200 && result.status < 300) return {ok:true, unblocked, target};
  if (isFollowRateLimited(result)) return {ok:false, reason:'rate_limited', error:result.error};
  return {ok:false, reason:'follow_failed', error:result.error || `关注接口返回 ${result.status}`};
}

async function followBackOne(user, button) {
  const key = String(user.handle || '').toLowerCase();
  if (!key || user.status === 'followed' || followBackBusy.has(key)) return;
  if (monitor.pausedUntil && Date.now() < new Date(monitor.pausedUntil).getTime()) {
    await chrome.storage.local.set({monitor});
    persist('monitor', monitor);
    monitorStatus(`已暂停至 ${new Date(monitor.pausedUntil).toLocaleString()}，不会重复尝试。`);
    return;
  }
  followBackBusy.add(key);
  setMonitorIconButtonState(button, true, '回关中…');
  try {
    monitorStatus(`正在通过 X 接口回关 @${user.handle}，不会打开个人主页…`);
    const tabId = await backgroundXActionTab();
    const result = await followViaNetwork(tabId, user);
    if (result.ok || result.reason === 'already_following') {
      await markQueueFollowed(user);
      monitorStatus(result.ok ? (result.unblocked ? `已通过 X 接口解除屏蔽并回关 @${user.handle}。` : `已通过 X 接口回关 @${user.handle}。`) : `@${user.handle} 已是关注状态，已从待回关移出。`);
      return;
    }
    if (result.reason === 'blocked') {
      await markQueueFollowFailed(user, result.error || '当前 X 账号屏蔽了该账号');
      monitorStatus(`@${user.handle} 未回关，已标记为关注失败。`);
      return;
    }
    if (result.reason === 'rate_limited') {
      await markQueueFollowFailed(user, result.error || 'X 关注频率受限');
      monitor.pausedUntil = new Date(Date.now() + 60 * 60000).toISOString();
      await chrome.storage.local.set({monitor});
      persist('monitor', monitor);
      renderMonitorList();
      monitorStatus(`@${user.handle} 触发关注限制，已暂停至 ${new Date(monitor.pausedUntil).toLocaleString()}。`);
      return;
    }
    await markQueueFollowFailed(user, result.error || result.reason);
    monitorStatus(`@${user.handle} 未执行回关：${result.error || result.reason}。`);
  } catch (error) {
    await markQueueFollowFailed(user, error.message);
    setMonitorIconButtonState(button, false, '回关');
    monitorStatus(`@${user.handle} 接口回关失败：${error.message}`);
  } finally {
    followBackBusy.delete(key);
    if (button.isConnected) setMonitorIconButtonState(button, false, '回关');
  }
}

async function unfollowViaNetwork(tabId, user) {
  let userId = user.id;
  if (!userId) {
    const lookup = await networkFetch(tabId, 'UserByScreenName', {screen_name:user.handle});
    if (lookup.status !== 200) return {ok:false, reason:'lookup_failed', error:lookup.error || `资料请求返回 ${lookup.status}`};
    const target = parseNetworkUsers(lookup.json).find(item => item.handle.toLowerCase() === user.handle.toLowerCase());
    if (!target?.id) return {ok:false, reason:'profile_unavailable', error:'未从 X 资料接口取得用户 ID'};
    userId = target.id;
    user.id = target.id;
  }
  const result = await networkUnfollow(tabId, userId);
  if (result.status >= 200 && result.status < 300) return {ok:true};
  return {ok:false, reason:'unfollow_failed', error:result.error || `取关接口返回 ${result.status}`};
}

async function unfollowOne(user, button) {
  const key = String(user.handle || '').toLowerCase();
  if (!key || unfollowBusy.has(key)) return;
  unfollowBusy.add(key);
  setMonitorIconButtonState(button, true, '取关中…');
  try {
    monitorStatus(`正在通过 X 接口取消关注 @${user.handle}…`);
    const tabId = await backgroundXActionTab();
    const result = await unfollowViaNetwork(tabId, user);
    if (result.ok) {
      removeUnfollowedUser(key);
      await chrome.storage.local.set({monitor, mutualNetwork});
      persist('monitor', monitor);
      persist('mutualNetwork', mutualNetwork);
      renderMonitorList();
      renderMutualNetwork();
      monitorStatus(`已取消关注 @${user.handle}。`);
      return;
    }
    monitorStatus(`@${user.handle} 取关未完成：${result.error || result.reason}`);
  } catch (error) {
    monitorStatus(`@${user.handle} 取关失败：${error.message}`);
  } finally {
    unfollowBusy.delete(key);
    if (button.isConnected) setMonitorIconButtonState(button, false, '取消关注');
  }
}

async function addSelectedFollowersToMutualNetwork() {
  if (!selectedFollowerHandles.size) {
    monitorStatus('请先在列表中勾选需要加入互关追踪的用户账号。');
    return;
  }

  // 汇集当前勾选的用户详情
  const allKnownMap = new Map();
  for (const u of (monitor.followingUsers || [])) {
    if (u?.handle) allKnownMap.set(u.handle.toLowerCase(), u);
  }
  for (const u of (monitor.users || [])) {
    if (u?.handle) {
      const existing = allKnownMap.get(u.handle.toLowerCase()) || {};
      allKnownMap.set(u.handle.toLowerCase(), { ...existing, ...u });
    }
  }
  for (const u of getNotMutualUsers()) {
    if (u?.handle) {
      const existing = allKnownMap.get(u.handle.toLowerCase()) || {};
      allKnownMap.set(u.handle.toLowerCase(), { ...existing, ...u });
    }
  }

  const targets = [...selectedFollowerHandles].map(k => allKnownMap.get(k)).filter(Boolean);
  if (!targets.length) {
    monitorStatus('未找到选中账号的详细信息。');
    return;
  }

  const existingMutualMap = new Map((mutualNetwork.users || []).map(u => [u.handle.toLowerCase(), u]));
  let addedCount = 0;
  let updatedCount = 0;
  const now = new Date().toISOString();

  for (const user of targets) {
    const key = user.handle.toLowerCase();
    const cached = profileCache[key] || {};
    const baseAccount = {
      id: user.id || cached.id || '',
      handle: user.handle,
      name: repairMojibake(cached.name || user.name || user.handle),
      bio: repairMojibake(cached.bio || user.bio || ''),
      avatarUrl: cached.avatarUrl || user.avatarUrl || '',
      followersText: cached.followersText || user.followersText || '',
      followingText: cached.followingText || user.followingText || '',
      followers: cached.followers || user.followers || null,
      following: cached.following || user.following || null,
      sourceAnchors: ['粉丝管理'],
      discoveredAt: now,
      relationship: { ...(user.relationship || {}), ...(cached.relationship || {}) }
    };

    if (!existingMutualMap.has(key)) {
      const full = applyOwnFollowingSnapshot(mergeNetworkAccount({}, baseAccount));
      existingMutualMap.set(key, full);
      addedCount++;
    } else {
      const old = existingMutualMap.get(key);
      const merged = applyOwnFollowingSnapshot(mergeNetworkAccount(old, baseAccount));
      existingMutualMap.set(key, merged);
      updatedCount++;
    }
  }

  mutualNetwork.users = [...existingMutualMap.values()];
  mutualNetwork.updatedAt = now;
  await saveMutualNetwork();
  renderMutualNetwork();

  if ($('mutualNetworkCount')) $('mutualNetworkCount').textContent = mutualNetwork.users.length;

  const msg = `已成功将选中的 ${targets.length} 位用户加入互关追踪（新增 ${addedCount} 位，更新 ${updatedCount} 位），可前往“互关追踪”进行统一分析与定时看帖关注！`;
  monitorStatus(msg);
  alert(msg);
}

async function batchUnfollowSelected() {
  if (unfollowRunning) {
    unfollowStopped = true;
    monitorStatus('正在停止批量取关…');
    return;
  }
  const candidates = currentFollowerUsers();
  const targets = [...selectedFollowerHandles].map(k => candidates.find(u => u.handle.toLowerCase() === k)).filter(Boolean);
  if (!targets.length) {
    monitorStatus('请先在未互关列表中勾选需要取关的账号。');
    return;
  }
  if (!confirm(`确定要批量取消关注选中的 ${targets.length} 个未互关账号吗？`)) return;

  unfollowRunning = true;
  unfollowStopped = false;
  const btn = $('batchUnfollow');
  if (btn) {
    btn.textContent = '停止取关';
    btn.disabled = false;
  }
  monitorStatus(`准备批量取消关注 ${targets.length} 个未互关账号…`);

  let tabId;
  try {
    tabId = await backgroundXActionTab();
  } catch (error) {
    unfollowRunning = false;
    if (btn) btn.textContent = '批量取关';
    monitorStatus(`X 后台会话不可用：${error.message}`);
    return;
  }

  let completed = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      if (unfollowStopped) {
        monitorStatus(`已停止批量取关，本次成功取关 ${completed} 个，剩余 ${targets.length - completed} 个。`);
        break;
      }
      const user = targets[i];
      monitorStatus(`正在取关 (${i + 1}/${targets.length})：@${user.handle}…`);
      try {
        const result = await unfollowViaNetwork(tabId, user);
        if (result.ok) {
          removeUnfollowedUser(user.handle);
          completed++;
        } else {
          monitorStatus(`@${user.handle} 取关未成功：${result.error || result.reason}`);
        }
      } catch (err) {
        monitorStatus(`@${user.handle} 取关出错：${err.message}`);
      }
      if (i % 3 === 0 || i === targets.length - 1) {
        await chrome.storage.local.set({monitor, mutualNetwork});
        persist('monitor', monitor);
        persist('mutualNetwork', mutualNetwork);
        renderMonitorList();
        renderMutualNetwork();
      }
      if (i < targets.length - 1 && !unfollowStopped) {
        await sleep(1500 + Math.floor(Math.random() * 1500));
      }
    }
  } finally {
    unfollowRunning = false;
    if (btn) btn.textContent = '批量取关';
    await chrome.storage.local.set({monitor, mutualNetwork});
    persist('monitor', monitor);
    persist('mutualNetwork', mutualNetwork);
    renderMonitorList();
    renderMutualNetwork();
    if (!unfollowStopped) {
      monitorStatus(`批量取关完成，本次成功取关 ${completed} 个账号。`);
    }
  }
}


async function followCandidate(row, button) {
  button.disabled = true;
  button.textContent = '正在关注…';
  try {
    const tabId = await backgroundXActionTab();
    const result = await followViaNetwork(tabId, row);
    if (result.ok || result.reason === 'already_following') { await markQueueFollowed(row); button.textContent = result.unblocked ? '已解封并关注' : '已关注'; button.className = 'queue-status'; return; }
    button.textContent = result.reason === 'blocked' ? '已屏蔽' : '未执行';
    status(`@${row.handle} 未执行关注：${result.error || result.reason}`);
  } catch (error) {
    button.textContent = '失败';
    status(`打开 @${row.handle} 失败：${error.message}`);
  } finally { button.disabled = false; }
}

async function invoke(func, args) {
  const results = await chrome.scripting.executeScript({ target: { tabId: inspectionTab }, func, args });
  if (!results[0]) throw new Error('无法读取页面。请检查 X 登录状态和扩展的网站访问权限。');
  return results[0].result;
}

async function navigate(url) {
  await chrome.tabs.update(inspectionTab, { url });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(inspectionTab);
    if (tab.status === 'complete' && tab.url?.replace(/\/$/, '') === url.replace(/\/$/, '')) return;
    await sleep(500);
  }
  throw new Error('页面未能加载。请检查网络、登录或 X 的访问限制。');
}

async function saveMonitorSettings() {
  const next = {
    enabled: $('monitorEnabled').checked,
    every: Number($('monitorEvery').value),
    jitter: Number($('monitorJitter')?.value || 0)
  };
  if (!Number.isFinite(next.every) || next.every < 10) throw new Error('基准检索间隔至少 10 分钟。');
  if (!Number.isFinite(next.jitter) || next.jitter < 0 || next.jitter >= next.every) throw new Error('随机浮动必须大于等于 0 且小于基准间隔。');
  monitor = {...monitor, ...next};
  await chrome.storage.local.set({monitor});
  persist('monitor', monitor);
  await chrome.alarms.clear('x-followers-scan');
  if (monitor.enabled) {
    const delta = monitor.jitter > 0 ? Math.floor((Math.random() * 2 - 1) * monitor.jitter) : 0;
    const delay = Math.max(10, monitor.every + delta);
    await chrome.alarms.create('x-followers-scan', {delayInMinutes: delay});
  }
}

async function followerTab() {
  const tabs = await chrome.tabs.query({url:['https://x.com/*','https://twitter.com/*']});
  let identityTab = tabs.find(tab => tab.status === 'complete') || tabs[0];
  let createdIdentityTab = false;
  if (!identityTab) {
    identityTab = await chrome.tabs.create({url:'https://x.com/home', active:false});
    createdIdentityTab = true;
  }
  let handle = await readOwnHandle(identityTab.id).catch(() => '');
  if (!handle) {
    for (let i = 0; i < 4 && !handle; i++) {
      await sleep(800);
      handle = await readOwnHandle(identityTab.id).catch(() => '');
    }
  }
  if (!handle) {
    if (createdIdentityTab) await chrome.tabs.remove(identityTab.id).catch(() => {});
    throw new Error('无法识别 X 登录账号；请先在 X 页面登录后重试。');
  }

  const targetId = createdIdentityTab ? identityTab.id : null;
  const tab = targetId
    ? await chrome.tabs.update(targetId, {url:`https://x.com/${handle}/followers`})
    : await chrome.tabs.create({url:`https://x.com/${handle}/followers`, active:false});
  const tabId = tab.id;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const current = await chrome.tabs.get(tabId).catch(() => null);
    if (current?.status === 'complete') return {tabId, temporary:true, handle};
    await sleep(300);
  }
  if (createdIdentityTab || !targetId) await chrome.tabs.remove(tabId).catch(() => {});
  throw new Error('X 粉丝列表加载超时，请稍后重试。');
}

async function readOwnHandle(tabId) {
  const result = await chrome.scripting.executeScript({target:{tabId}, world:'MAIN', func:() => document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.replace(/^\//,'').split('/')[0] || ''});
  return result?.[0]?.result || '';
}

async function scanFollowingFromNetwork(tabId, target, limit) {
  const profile = await networkFetch(tabId, 'UserByScreenName', {screen_name:target});
  if (profile.status !== 200) return null;
  const owner = parseNetworkUsers(profile.json).find(user => user.handle.toLowerCase() === target.toLowerCase());
  if (!owner?.id) return null;
  const found = new Map(); let cursor = '';
  for (let page=0; page<10 && found.size<limit; page++) {
    const response = await networkFetchWithRecovery(tabId, target, 'Following', {userId:owner.id, count:20, ...(cursor ? {cursor} : {})});
    if (response.status !== 200) return null;
    for (const user of parseNetworkUsers(response.json)) if (user.handle.toLowerCase() !== target.toLowerCase()) found.set(user.handle.toLowerCase(), user.handle);
    const next = findCursor(response.json); if (!next || next === cursor) break; cursor = next;
  }
  return [...found.values()].slice(0, limit);
}

async function scanOwnFollowing(tabId, handle, pageLimit = 1000) {
  if (!await ensureNetworkTemplate(handle, 'UserByScreenName')) return null;
  const profile = await networkFetch(tabId, 'UserByScreenName', {screen_name:handle});
  if (profile.status !== 200) return null;
  const me = parseNetworkUsers(profile.json).find(user => user.handle.toLowerCase() === handle.toLowerCase());
  if (!me?.id) return null;
  if (!await ensureNetworkTemplate(handle, 'Following')) return null;
  const found = new Map(); let cursor = ''; let complete = false;
  for (let page=0; page<pageLimit; page++) {
    const response = await networkFetchWithRecovery(tabId, handle, 'Following', {userId:me.id, count:20, ...(cursor ? {cursor} : {})});
    if (response.status !== 200) return {users:[...found.values()], complete:false, error:response.error || `Following 请求失败（${response.status}）`};
    for (const user of parseNetworkUsers(response.json)) {
      if (user.handle.toLowerCase() !== handle.toLowerCase()) {
        found.set(user.handle.toLowerCase(), {...user, relationship:{...(user.relationship || {}), following:true}});
      }
    }
    const next = findCursor(response.json);
    if (!next) { complete=true; break; }
    if (next === cursor) return {users:[...found.values()], complete:false, error:'Following 分页游标未前进'};
    cursor = next;
  }
  return {users:[...found.values()], complete};
}

async function syncOwnFollowingList(tabId, handle) {
  try {
    const result = await scanOwnFollowing(tabId, handle);
    if (result?.users?.length) {
      const previous = new Map((monitor.followingUsers || []).map(u => [u.handle.toLowerCase(), u]));
      for (const user of result.users) previous.set(user.handle.toLowerCase(), {...previous.get(user.handle.toLowerCase()), ...user});
      monitor.followingUsers = [...previous.values()];
      if (result.complete) monitor.followingListComplete = true;
      const followingHandles = ownFollowingHandles();
      const apply = user => {
        if (!user?.handle) return;
        if (followingHandles.has(user.handle.toLowerCase())) user.relationship = {...(user.relationship || {}), following:true};
        else if (typeof user.relationship?.following !== 'boolean') user.relationship = {...(user.relationship || {}), following:false};
        user.relationshipKnown = typeof user.relationship.followedBy === 'boolean';
      };
      for (const user of [...(monitor.users || []), ...(monitor.queue || []), ...(mutualNetwork.users || [])]) apply(user);
    }
  } catch {}
}

async function scanFollowersFromNetwork(tabId, knownHandles = new Set(), checkpointHandle = null, operation = 'Followers', maxUsers = MAX_FOLLOWER_SCAN) {
  const handle = await readOwnHandle(tabId);
  if (!handle) return {fallbackReason:'无法从 X 页面识别当前登录账号'};
  if (!await ensureNetworkTemplate(handle, 'UserByScreenName')) return {fallbackReason:'用户资料接口模板未捕获'};
  const profile = await networkFetch(tabId, 'UserByScreenName', {screen_name:handle});
  if (profile.status !== 200) return {fallbackReason:profile.error || `用户资料请求失败（${profile.status}）`};
  const me = parseNetworkUsers(profile.json).find(user => user.handle.toLowerCase() === handle.toLowerCase());
  if (!me?.id) return {fallbackReason:'用户资料接口没有返回当前账号 ID'};
  if (!await ensureNetworkTemplate(handle, operation)) return {fallbackReason:`${operation} 接口模板未捕获`};
  const found = new Map(); let cursor = '';
  let reachedCheckpoint = false;
  let topFollower = null;
  for (let page=0; page<Math.ceil(maxUsers / 20) && found.size<maxUsers; page++) {
    const response = await networkFetchWithRecovery(tabId, handle, operation, {userId:me.id, count:20, ...(cursor ? {cursor} : {})});
    if (response.status !== 200) {
      return {
        fallbackReason:response.error || `${operation} 请求失败（${response.status}）`,
        partialUsers:[...found.values()],
        operation
      };
    }
    const pageUsers = parseNetworkUsers(response.json);
    let pageHasNew = false;
    for (const user of pageUsers) {
      if (user.handle.toLowerCase() === handle.toLowerCase()) continue;
      if (!topFollower) topFollower = user;
      if (checkpointHandle && user.handle.toLowerCase() === checkpointHandle.toLowerCase()) {
        reachedCheckpoint = true;
        break;
      }
      if (!knownHandles.has(user.handle.toLowerCase())) pageHasNew = true;
    }
    addUniqueUsersUpTo(found, pageUsers.filter(user => user.handle.toLowerCase() !== handle.toLowerCase()), maxUsers, user => ({...user, followerSource:operation === 'BlueVerifiedFollowers' ? 'verified_followers' : 'followers'}));
    if (reachedCheckpoint) break;
    if (knownHandles.size && page > 0 && !pageHasNew) {
      reachedCheckpoint = true;
      break;
    }
    const next = findCursor(response.json); if (!next || next === cursor) break; cursor = next;
  }
  return {users:[...found.values()], topFollower, reachedCheckpoint, limited:found.size>=maxUsers && !reachedCheckpoint, operation};
}

async function scanFollowerList() {
  const scanTarget = await followerTab();
  const {tabId, temporary, handle} = scanTarget;
  try {
    const knownHandles = new Set((monitor.users || []).map(user => user.handle.toLowerCase()));
    const checkpointHandle = monitor.checkpointHandle || null;
    monitorStatus(checkpointHandle ? `正在按位点 @${checkpointHandle} 增量检索最新粉丝…` : '正在准备粉丝接口并建立初始粉丝基准…');
    let networkResult = await scanFollowersFromNetwork(tabId, knownHandles, checkpointHandle, 'Followers', MAX_FOLLOWER_SCAN).catch(error => ({fallbackReason:error.message}));
    if (networkResult && !networkResult.fallbackReason) {
      const {users:networkUsers, topFollower, reachedCheckpoint, limited, operation:sourceOperation} = networkResult;
      const previous = new Map((monitor.users || []).map(user => [user.handle.toLowerCase(), user]));
      const foundAt = new Date().toISOString();
      for (const user of networkUsers) { const old=previous.get(user.handle.toLowerCase()); previous.set(user.handle.toLowerCase(), {...old, ...user, discoveredAt:old?.discoveredAt || foundAt}); }
      const users = [...previous.values()];
      const queue = reconcileFollowBackQueue(monitor.queue, users, riskAssess);
      queue.sort((a,b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1));
      await syncOwnFollowingList(tabId, handle);
      const newCheckpointHandle = topFollower?.handle || monitor.checkpointHandle || networkUsers[0]?.handle || null;
      monitor = {
        ...monitor,
        users,
        queue,
        followingUsers: monitor.followingUsers || [],
        lastScan: new Date().toISOString(),
        checkpointHandle: newCheckpointHandle,
        checkpointAt: new Date().toISOString(),
        source: sourceOperation === 'BlueVerifiedFollowers' ? 'verified_followers_network' : 'followers_network'
      };
      await chrome.storage.local.set({monitor}); persist('monitor', monitor); renderQueue(); renderSettingsDrawer();
      const sourceName = sourceOperation === 'BlueVerifiedFollowers' ? '蓝标粉丝接口' : '粉丝接口';
      const newCount = networkUsers.filter(user => !knownHandles.has(user.handle.toLowerCase())).length;
      const cpText = reachedCheckpoint ? '已到达上次记录位点（已自动停止拉取历史数据）' : (limited ? `本次达到 ${MAX_FOLLOWER_SCAN} 个上限` : '已同步至最新位点');
      const notMutualCount = getNotMutualUsers().length;
      monitorStatus(`已从 ${sourceName} 增量读取 ${networkUsers.length} 个账号，新增 ${newCount} 个；${cpText}；累计保存 ${users.length} 个，待回关 ${queue.filter(user => user.status === 'pending').length} 个，未互关 ${notMutualCount} 个。`);
      return;
    }
    const fallbackReason = networkResult?.fallbackReason || '接口暂不可用';
    monitorStatus(`粉丝接口暂不可用（${fallbackReason}），正在从 @${handle} 的粉丝列表读取…`);
    const found = new Map((networkResult?.partialUsers || []).map(user => [user.handle.toLowerCase(), user])); let idle = 0;
    let topFollowerDom = null;
    let reachedCheckpointDom = false;
    for (let i=0; i<300 && idle<8 && found.size<MAX_FOLLOWER_SCAN; i++) {
      const result = (await chrome.scripting.executeScript({target:{tabId}, func:scanFollowers}))[0]?.result;
      if (!result?.ready) {
        await sleep(1200);
        continue;
      }
      const before = found.size;
      for (const user of result?.users || []) {
        if (!topFollowerDom) topFollowerDom = user;
        if (checkpointHandle && user.handle.toLowerCase() === checkpointHandle.toLowerCase()) {
          reachedCheckpointDom = true;
          break;
        }
        if (found.size < MAX_FOLLOWER_SCAN) found.set(user.handle.toLowerCase(), user);
      }
      if (reachedCheckpointDom) break;
      idle = before === found.size ? idle + 1 : 0;
      await sleep(1200);
    }
    const users = [...found.values()];
    const previous = new Map((monitor.users || []).map(user => [user.handle.toLowerCase(), user]));
    const foundAt = new Date().toISOString();
    for (const user of users) { const old=previous.get(user.handle.toLowerCase()); previous.set(user.handle.toLowerCase(), {...old, ...user, discoveredAt:old?.discoveredAt || foundAt}); }
    const allUsers = [...previous.values()];
    const queue = reconcileFollowBackQueue(monitor.queue, allUsers, riskAssess);
    queue.sort((a,b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1));
    await syncOwnFollowingList(tabId, handle);
    const newCheckpointHandle = topFollowerDom?.handle || monitor.checkpointHandle || users[0]?.handle || null;
    monitor = {
      ...monitor,
      users: allUsers,
      queue,
      followingUsers: monitor.followingUsers || [],
      lastScan: new Date().toISOString(),
      checkpointHandle: newCheckpointHandle,
      checkpointAt: new Date().toISOString(),
      source: 'followers_dom'
    };
    await chrome.storage.local.set({monitor});
    persist('monitor', monitor);
    renderQueue();
    renderSettingsDrawer();
    const newCount = users.filter(user => !knownHandles.has(user.handle.toLowerCase())).length;
    const notMutualCount = getNotMutualUsers().length;
    const capText = users.length >= MAX_FOLLOWER_SCAN ? `本次达到 ${MAX_FOLLOWER_SCAN} 个上限；` : '';
    monitorStatus(`已从 @${handle} 的粉丝列表增量读取 ${users.length} 个账号，新增 ${newCount} 个；${capText}最新位点 @${newCheckpointHandle}；累计保存 ${allUsers.length} 个，待回关 ${queue.filter(user => user.status === 'pending').length} 个，未互关 ${notMutualCount} 个。`);
  } catch (error) {
    monitorStatus(`扫描失败：${error.message}`);
  } finally {
    if (temporary) await chrome.tabs.remove(tabId).catch(() => {});
  }
}

let followBackRunning = false;
let followBackStopped = false;

async function processFollowBack() {
  if (followBackRunning) {
    followBackStopped = true;
    monitorStatus('正在停止回关…');
    return;
  }
  if (monitor.pausedUntil && Date.now() < new Date(monitor.pausedUntil).getTime()) {
    monitorStatus(`已暂停至 ${new Date(monitor.pausedUntil).toLocaleString()}，不会重复尝试。`);
    return;
  }
  const pending = (monitor.queue || []).filter(user => user.status === 'pending' && user.risk?.level !== 'danger' && user.state !== 'following' && user.relationship?.following !== true);
  if (!pending.length) {
    monitorStatus('没有待回关账号，请先扫描粉丝列表。');
    return;
  }
  let tabId;
  try { tabId = await backgroundXActionTab(); }
  catch (error) {
    for (const user of pending) setFollowFailure(user, error.message);
    await chrome.storage.local.set({monitor});
    persist('monitor', monitor);
    renderQueue();
    monitorStatus(`X 后台会话不可用，${pending.length} 个待回关账号已标记关注失败。`);
    return;
  }
  followBackRunning = true;
  followBackStopped = false;
  $('processFollowBack')?.classList.add('is-busy');
  let completed = 0;
  try {
    for (let i = 0; i < pending.length; i++) {
      if (followBackStopped) {
        monitorStatus(`已手动停止回关，本次成功回关 ${completed} 个，剩余待回关 ${monitor.queue.filter(user => user.status === 'pending').length} 个。`);
        break;
      }
      const user = pending[i];
      monitorStatus(`正在回关 (${i + 1}/${pending.length})：@${user.handle}…`);
      let result;
      try { result = await followViaNetwork(tabId, user); }
      catch (error) { setFollowFailure(user, error.message); continue; }
      if (result.reason === 'rate_limited') {
        setFollowFailure(user, result.error || 'X 关注频率受限');
        monitor.pausedUntil = new Date(Date.now() + 60 * 60000).toISOString();
        monitorStatus(`检测到 X 限制，已暂停后续回关（已成功回关 ${completed} 个），约一小时后再提醒。`);
        break;
      }
      if (result.ok || result.reason === 'already_following') {
        user.status = 'followed';
        user.followedAt = new Date().toISOString();
        completed++;
      } else {
        setFollowFailure(user, result.error || result.reason || '关注请求未完成');
      }
      monitor.queue = monitor.queue.map(item => (item.handle === user.handle ? user : item));
      await chrome.storage.local.set({monitor});
      renderQueue();

      if (i < pending.length - 1 && !followBackStopped) {
        await sleep(2500 + Math.floor(Math.random() * 2500));
      }
    }
  } finally {
    followBackRunning = false;
    $('processFollowBack')?.classList.remove('is-busy');
    persist('monitor', monitor);
    renderQueue();
    if (!followBackStopped) {
      monitorStatus(`回关处理完成，本次成功回关 ${completed} 个账号，剩余待回关 ${monitor.queue.filter(user => user.status === 'pending').length} 个。`);
    }
  }
}

async function startFollowerScan() {
  if (followerScanRunning) return;
  followerScanRunning = true;
  $('scanFollowers').disabled = true; $('initialFollowers').disabled = true;
  monitorStatus(monitor.users?.length ? '正在增量扫描新粉丝…' : '正在获取初始粉丝列表…');
  try { await scanFollowerList(); }
  catch (error) { monitorStatus(`扫描失败：${error.message}`); }
  finally { followerScanRunning = false; $('scanFollowers').disabled = false; $('initialFollowers').disabled = false; renderMonitorList(); }
}
$('scanFollowers').addEventListener('click', startFollowerScan);
$('initialFollowers').addEventListener('click', startFollowerScan);
$('processFollowBack').addEventListener('click', async () => { try { await processFollowBack(); } catch (error) { monitorStatus(`处理失败：${error.message}`); } });
$('monitorEnabled').addEventListener('change', () => saveMonitorSettings().then(() => monitorStatus(monitor.enabled ? `已启用不定频检索，基准每 ${monitor.every}±${monitor.jitter || 0} 分钟。` : '已关闭定时检索。')).catch(error => monitorStatus(error.message)));
for (const id of ['monitorEvery','monitorJitter']) $(id)?.addEventListener('change', () => saveMonitorSettings().catch(error => monitorStatus(error.message)));
document.querySelectorAll('[data-follower-tab]').forEach(button => button.addEventListener('click', () => {
  activeFollowerTab = button.dataset.followerTab;
  selectedFollowerHandles.clear();
  followerPage = 1;
  renderMonitorList();
}));
$('listSelectAll').addEventListener('change', event => {
  const allUsers = currentFollowerUsers();
  const keyword = followerSearch.trim().toLowerCase();
  const matchedUsers = keyword ? allUsers.filter(user => [user.handle, user.name, user.bio].some(value => String(value || '').toLowerCase().includes(keyword))) : allUsers;
  const users = matchedUsers.slice((followerPage - 1) * followerPageSize, followerPage * followerPageSize);
  if (activeFollowerTab === 'notMutual') {
    for (const user of users) {
      const key = user.handle.toLowerCase();
      if (event.target.checked) selectedFollowerHandles.add(key);
      else selectedFollowerHandles.delete(key);
    }
  } else {
    const additions = users.filter(user => !selectedFollowerHandles.has(user.handle.toLowerCase())).length;
    if (event.target.checked && selectedFollowerHandles.size + additions > 20) {
      const capacity = 20 - selectedFollowerHandles.size;
      for (const user of users.slice(0, Math.max(0, capacity))) selectedFollowerHandles.add(user.handle.toLowerCase());
      monitorStatus(`Grok 一次最多分析 20 个账号，已从当前页选择前 ${Math.max(0, capacity)} 个。`);
    } else {
      for (const user of users) {
        const key = user.handle.toLowerCase();
        if (event.target.checked) selectedFollowerHandles.add(key);
        else selectedFollowerHandles.delete(key);
      }
    }
  }
  renderMonitorList();
});
$('batchUnfollow')?.addEventListener('click', batchUnfollowSelected);
$('addSelectedToMutual')?.addEventListener('click', addSelectedFollowersToMutualNetwork);
$('followerSearch').addEventListener('input', event => { followerSearch=event.target.value; followerPage=1; renderMonitorList(); });
$('followerSearchBtn')?.addEventListener('click', () => { followerSearch=$('followerSearch').value.trim(); followerPage=1; renderMonitorList(); });
$('followerSearch')?.addEventListener('keydown', event => { if (event.key === 'Enter') { followerSearch=event.target.value.trim(); followerPage=1; renderMonitorList(); } });
$('followerPageSize').addEventListener('change', event => { followerPageSize=Number(event.target.value); followerPage=1; renderMonitorList(); });
$('followerPrevPage').addEventListener('click', () => { followerPage--; renderMonitorList(); });
$('followerNextPage').addEventListener('click', () => { followerPage++; renderMonitorList(); });
$('collectNetwork').addEventListener('click', () => collectMutualNetwork($('networkAnchor').value, true));
$('networkAnchor').addEventListener('keydown', event => { if (event.key === 'Enter') collectMutualNetwork(event.target.value, true); });
$('closeProfileDrawer').addEventListener('click', closeProfileDrawer);
$('openSettingsDrawer')?.addEventListener('click', openSettingsDrawer);
$('closeSettingsDrawer')?.addEventListener('click', closeSettingsDrawer);
$('profileDrawerMask').addEventListener('click', () => {
  closeProfileDrawer();
  closeSettingsDrawer();
  closeMutualSettingsDrawer();
  closeCommentAutoFollowDrawer();
});
$('drawerRefreshProfile').addEventListener('click', refreshDrawerProfile);
$('drawerOpenX').addEventListener('click', () => { if (drawerUser?.handle) chrome.tabs.create({url:`https://x.com/${drawerUser.handle}`, active:true}); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (!$('profileDrawer').hidden) closeProfileDrawer();
    if ($('settingsDrawer') && !$('settingsDrawer').hidden) closeSettingsDrawer();
    if ($('mutualSettingsDrawer') && !$('mutualSettingsDrawer').hidden) closeMutualSettingsDrawer();
    if ($('commentAutoFollowDrawer') && !$('commentAutoFollowDrawer').hidden) closeCommentAutoFollowDrawer();
    if ($('logsModal') && !$('logsModal').hidden) closeLogsModal();
  }
});

function grokPrompt() {
  const items = analysisRows.map((row, index) => {
    const evalInfo = evaluateMutualProfile(row);
    return [
      `账号 ${index + 1}`,
      `用户名：@${row.handle}`,
      `主页：${row.url || `https://x.com/${row.handle}`}`,
      `名称：${row.name || ''}`,
      `简介：${row.bio || ''}`,
      `粉丝：${row.followersText || '未读取'}`,
      `关注：${row.followingText || '未读取'}`,
      `关注/粉丝比与推荐评估：${evalInfo.recommendReason}`,
      `本地危险信号：${row.risk?.level === 'danger' ? `危险（${row.risk.hits.join('、')}）` : '未命中规则'}`,
      `最近帖子：`,
      ...(row.posts || []).map((post, postIndex) => `${postIndex + 1}. ${post.text}${post.time ? `（${post.time}）` : ''}${post.url ? ` ${post.url}` : ''}`)
    ].join('\n');
  }).join('\n\n---\n\n');
  return `你是 X 账号互粉与推荐筛选助手。下面是同一批 ${analysisRows.length} 个账号的公开 profile 和最近帖子。请逐个分析并输出：\n1. 账号主题与真实活跃方向；\n2. 是否有愿意互粉倾向（结合简介与帖子互关/回关意向、互动习惯及关注/粉丝比例综合判断）；\n3. 推荐评估：关注人数比粉丝数少在 1/5 以内（即关注量 >= 粉丝量×80%，例如关注 4000、粉丝 5000）视为推荐；若关注人数比粉丝数少超过 1/5（关注量 < 粉丝量×80%）视为不推荐；\n4. 最近帖子质量、原创性和明显风险，特别标记擦边色情、成人平台、私密导流、博彩、诈骗或可疑外链；\n5. 每个账号分析末尾必须单独输出一行标准回填标记（严格按以下格式，便于系统自动识别互粉标签与推荐原因）：\n[@用户名 | 互粉意向: 有/无 | 互粉标签: 互粉/无 | 推荐评估: 推荐/不推荐 | 理由: 一句话推荐原因或不推荐原因]\n\n${items}`;
}

function selectedFollowerUsers() {
  const users = new Map();
  for (const user of [...(monitor.users || []), ...(monitor.queue || []), ...(monitor.followingUsers || []), ...(mutualNetwork.users || [])]) {
    if (user?.handle) users.set(user.handle.toLowerCase(), user);
  }
  return [...selectedFollowerHandles].map(key => users.get(key)).filter(Boolean).slice(0, 20);
}

async function applyGrokAnalysisResults(parsedMap) {
  const entries = Object.entries(parsedMap || {});
  if (!entries.length) return 0;
  let updatedCount = 0;
  const now = new Date().toISOString();
  for (const [key, res] of entries) {
    const patch = {
      grokMutualIntent: res.grokMutualIntent,
      mutualTag: res.mutualTag,
      grokBaitRisk: res.grokBaitRisk || '',
      grokReason: res.grokReason || '',
      grokAnalyzedAt: now
    };
    profileCache[key] = {...(profileCache[key] || {handle: res.handle}), ...patch};
    for (const list of [monitor.users, monitor.queue, monitor.followingUsers, mutualNetwork.users, analysisRows]) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (item?.handle?.toLowerCase() === key) Object.assign(item, patch);
      }
    }
    updatedCount++;
  }
  if (updatedCount > 0) {
    await chrome.storage.local.set({profileCache, monitor, mutualNetwork, analysisRows});
    persist('profileCache', profileCache);
    persist('monitor', monitor);
    persist('mutualNetwork', mutualNetwork);
    persist('analysisRows', analysisRows);
    renderMonitorList();
    renderMutualNetwork();
    if (!$('profileDrawer').hidden && drawerUser) renderProfileDrawer();
  }
  return updatedCount;
}

async function pollGrokResponseAndApply(tabId, handles, reportStatus = analysisStatus) {
  const targetHandles = (handles || []).filter(Boolean);
  if (!tabId || !targetHandles.length) return;
  const deadline = Date.now() + 75000;
  let bestCount = 0;
  let stableRounds = 0;
  while (Date.now() < deadline) {
    await sleep(2500);
    const currentTab = await chrome.tabs.get(tabId).catch(() => null);
    if (!currentTab) break;
    const textResult = (await chrome.scripting.executeScript({
      target: {tabId},
      func: () => document.body?.innerText || ''
    }).catch(() => []))?.[0]?.result || '';
    if (!textResult) continue;
    const markerIdx = textResult.lastIndexOf('[@用户名 | 互粉意向:');
    const responseText = markerIdx >= 0 ? textResult.slice(markerIdx + 18) : textResult;
    const parsed = parseGrokMutualAnalysis(responseText, targetHandles);
    const matchedCount = Object.keys(parsed).length;
    if (matchedCount > 0) {
      await applyGrokAnalysisResults(parsed);
      const mutualCount = Object.values(parsed).filter(item => item.grokMutualIntent).length;
      reportStatus(`Grok 已回填 ${matchedCount}/${targetHandles.length} 个账号标签（其中“互粉” ${mutualCount} 个）。`);
      if (matchedCount >= targetHandles.length) break;
      if (matchedCount === bestCount) {
        stableRounds++;
        if (stableRounds >= 4) break;
      } else {
        bestCount = matchedCount;
        stableRounds = 0;
      }
    }
  }
}

async function collectSelectedProfiles(customCandidates = null, reportStatus = analysisStatus) {
  const candidates = (customCandidates || selectedFollowerUsers()).slice(0, 20);
  if (!candidates.length) throw new Error('请先选择或加载要分析的账号。');
  const collected = []; let tabId;
  try {
    for (const user of candidates) {
      const key = user.handle.toLowerCase();
      const cached = profileCache[key];
      if (cached && cached.followersText && cached.followingText && Array.isArray(cached.posts)) {
        collected.push({...user, ...cached});
        continue;
      }
      if (!tabId) { const tab = await chrome.tabs.create({url:'https://x.com/home', active:false}); tabId = tab.id; inspectionTab = tabId; }
      reportStatus(`正在读取 @${user.handle} 的资料（${collected.length + 1}/${candidates.length}）…`);
      let netData = {};
      try { netData = await fetchUserProfileNetwork(user, tabId); } catch {}
      await navigate(`https://x.com/${user.handle}`);
      let data = {pending:true}; const deadline = Date.now() + 18000;
      while (Date.now() < deadline && data.pending) { data = await invoke(readProfileBundle, [user.handle, 5]); if (data.pending) await sleep(700); }
      const mergedData = {...user, ...netData, ...data, followersText: data.followersText || netData.followersText || user.followersText || '', followingText: data.followingText || netData.followingText || user.followingText || ''};
      const row = {...mergedData, handle:user.handle, url:`https://x.com/${user.handle}`, posts:data.posts || [], risk:riskAssess(mergedData), profileCachedAt:new Date().toISOString()};
      profileCache[key] = row; collected.push(row);
      applyProfileToMonitor(row);
      await chrome.storage.local.set({profileCache}); persist('profileCache', profileCache);
    }
  } finally {
    if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
    renderMonitorList();
    renderMutualNetwork();
  }
  analysisRows = collected;
  await chrome.storage.local.set({analysisRows}); persist('analysisRows', analysisRows);
  return collected;
}

async function submitBatchToGrok(customCandidates = null, reportStatus = analysisStatus) {
  await collectSelectedProfiles(customCandidates, reportStatus);
  const prompt = grokPrompt();
  const created = await chrome.windows.create({url:'https://x.com/i/grok', type:'popup', state:'minimized', focused:false});
  let tabId = created.tabs?.[0]?.id;
  if (!tabId && created.id) {
    const tabs = await chrome.tabs.query({windowId: created.id});
    tabId = tabs?.[0]?.id;
  }
  if (!tabId) throw new Error('Grok 窗口创建失败。');
  await chrome.storage.local.set({grokWindowId:created.id, grokSubmittedAt:new Date().toISOString()});
  const deadline = Date.now() + 30000;
  let lastReason = 'Grok 页面尚未准备好';
  while (Date.now() < deadline) {
    await sleep(1000);
    const result = (await chrome.scripting.executeScript({target:{tabId}, func:(text) => {
      const input = document.querySelector('textarea, [contenteditable="true"]');
      if (!input) return {ok:false, reason:'找不到 Grok 输入框'};
      if (input.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(input, text);
      } else {
        input.textContent = text;
      }
      input.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:text}));
      input.dispatchEvent(new Event('change', {bubbles:true}));
      const send = [...document.querySelectorAll('button')].find(button => {
        const label = `${button.getAttribute('aria-label') || ''} ${button.innerText || ''} ${button.getAttribute('data-testid') || ''}`;
        return /send|提交|发送/i.test(label) && !button.disabled;
      });
      if (!send) return {ok:false, reason:'找不到 Grok 发送按钮'};
      send.click();
      return {ok:true};
    }, args:[prompt]}))[0]?.result;
    if (result?.ok) {
      const handles = analysisRows.map(r => r.handle);
      reportStatus(`已在最小化 Grok 窗口提交 ${handles.length} 个账号的互粉倾向分析，正在等待 Grok 回填标签…`);
      pollGrokResponseAndApply(tabId, handles, reportStatus).catch(() => {});
      return;
    }
    lastReason = result?.reason || lastReason;
  }
  await navigator.clipboard.writeText(prompt);
  throw new Error(`${lastReason}。分析包已复制到剪贴板，请在 Grok 窗口粘贴发送。`);
}

function sanitizeUserMojibake(user) {
  if (!user || typeof user !== 'object') return false;
  let modified = false;
  if (user.name) {
    const cleaned = repairMojibake(user.name);
    if (cleaned !== user.name) { user.name = cleaned; modified = true; }
  }
  if (user.bio) {
    const cleaned = repairMojibake(user.bio);
    if (cleaned !== user.bio) { user.bio = cleaned; modified = true; }
  }
  return modified;
}

function sanitizeMojibakeCollections() {
  let changed = false;
  for (const list of [monitor.users, monitor.queue, monitor.followingUsers, mutualNetwork.users]) {
    if (Array.isArray(list)) {
      for (const u of list) {
        if (sanitizeUserMojibake(u)) changed = true;
      }
    }
  }
  if (profileCache && typeof profileCache === 'object') {
    for (const p of Object.values(profileCache)) {
      if (sanitizeUserMojibake(p)) changed = true;
    }
  }
  return changed;
}

$('analyzeSelected').addEventListener('click', async () => { try { analysisStatus('正在读取资料并提交 Grok 分析互粉倾向…'); await submitBatchToGrok(null, analysisStatus); } catch (error) { analysisStatus(`Grok 分析失败：${error.message}`); } });
$('grokAnalyzeMutual')?.addEventListener('click', async () => {
  try {
    const selectedUsers = selectedMutualUsersList();
    let targets = selectedUsers.slice(0, 20);
    if (!targets.length) {
      const users = getFilteredMutualUsers();
      const startIdx = (mutualPage - 1) * mutualPageSize;
      targets = users.slice(startIdx, startIdx + Math.min(mutualPageSize, 20));
    }
    if (!targets.length) {
      networkStatus('当前没有可提交 Grok 分析的账号。');
      return;
    }
    const modeLabel = selectedUsers.length > 0 ? `已选的 ${targets.length} 个账号` : `当前页前 ${targets.length} 个账号`;
    networkStatus(`正在读取${modeLabel}资料并提交 Grok 分析互粉倾向…`);
    await submitBatchToGrok(targets, networkStatus);
  } catch (error) {
    networkStatus(`Grok 分析失败：${error.message}`);
  }
});
try {
  const savedMonitor = await chrome.storage.local.get('monitor');
  monitor = {...monitor, ...(savedMonitor.monitor || {})};
  if (!Array.isArray(monitor.followingUsers)) monitor.followingUsers = [];
  const reconciledQueue = reconcileFollowBackQueue(monitor.queue, monitor.users, riskAssess);
  if (JSON.stringify(reconciledQueue) !== JSON.stringify(monitor.queue || [])) {
    monitor = {...monitor, queue:reconciledQueue};
    await chrome.storage.local.set({monitor});
    persist('monitor', monitor);
  }
  renderSettingsDrawer();
  if (monitor.lastScan) monitorStatus(`上次检索 ${new Date(monitor.lastScan).toLocaleString()}，待回关 ${monitor.queue?.filter(user => user.status === 'pending').length || 0} 个。`);
  renderQueue();
  renderMonitorList();
} catch (error) { monitorStatus(`关注与粉丝记录加载失败：${error.message}`); }

try {
  const savedAnalysis = await chrome.storage.local.get(['analysisRows', 'profileCache']);
  analysisRows = savedAnalysis.analysisRows || [];
  profileCache = savedAnalysis.profileCache || {};
} catch (error) { analysisStatus(`分析记录加载失败：${error.message}`); }

try {
  const savedNetwork = await chrome.storage.local.get(['mutualNetwork', 'mutualAutoFollowSettings']);
  let mutualCfg = savedNetwork.mutualAutoFollowSettings || savedNetwork.mutualNetwork?.autoFollow;
  if (!mutualCfg) {
    mutualCfg = await loadPersistedAutoFollowSettings('mutual');
  }
  mutualNetwork = {
    ...mutualNetwork,
    ...(savedNetwork.mutualNetwork || {}),
    autoFollow: normalizeAutoFollowConfig(mutualCfg || {})
  };
  renderMutualNetwork();
  renderMutualSettingsDrawer();
  if (mutualNetwork.lastCollected) networkStatus(`已恢复 ${mutualNetwork.users?.length || 0} 个去重账号，最近锚点 @${mutualNetwork.anchor}。`);
} catch (error) { networkStatus(`互关追踪记录加载失败：${error.message}`); }

try {
  const {autoFollowLogs: savedLocalLogs = []} = await chrome.storage.local.get('autoFollowLogs');
  if (Array.isArray(savedLocalLogs) && savedLocalLogs.length) { autoFollowLogs = savedLocalLogs; renderLogsModal(); }
  const savedComments = await chrome.storage.local.get(['commentTracking', 'commentTrackingStatus', 'commentAutoFollowSettings']);
  let commentCfg = savedComments.commentAutoFollowSettings || savedComments.commentTracking?.autoFollow;
  if (!commentCfg) {
    commentCfg = await loadPersistedAutoFollowSettings('comment');
  }
  commentTracking = {
    ...commentTracking,
    ...(savedComments.commentTracking || {}),
    autoFollow: normalizeAutoFollowConfig(commentCfg || {})
  };
  commentTrackingStatus = savedComments.commentTrackingStatus || null;
  renderCommentAutoFollowSettings();
  chrome.runtime.sendMessage({cmd:'configureCommentAutoFollow', config:commentTracking.autoFollow}).catch(() => {});
  renderCommentTracking();
} catch (error) { $('commentTrackingStatus').textContent = `评论追踪记录加载失败：${error.message}`; }

try {
  const savedUnrecip = await chrome.storage.local.get(['unreciprocatedTracker', 'unreciprocatedSettings', 'unreciprocatedLogs']);
  if (savedUnrecip.unreciprocatedLogs && Array.isArray(savedUnrecip.unreciprocatedLogs)) {
    unreciprocatedLogs = savedUnrecip.unreciprocatedLogs;
  }
  let unrecipCfg = savedUnrecip.unreciprocatedSettings || savedUnrecip.unreciprocatedTracker?.config;
  if (!unrecipCfg) {
    try {
      if (chrome.storage?.sync) {
        const syncData = await chrome.storage.sync.get('unreciprocatedSettings');
        if (syncData?.unreciprocatedSettings) unrecipCfg = syncData.unreciprocatedSettings;
      }
    } catch {}
  }
  unreciprocatedTracker = {
    users: savedUnrecip.unreciprocatedTracker?.users || [],
    config: normalizeUnreciprocatedConfig(unrecipCfg || {}),
    updatedAt: savedUnrecip.unreciprocatedTracker?.updatedAt || ''
  };
  syncAllActiveFollowedUsers();
  renderUnreciprocatedSettingsDrawer();
  renderUnreciprocatedUI();
} catch (error) {
  console.warn('回关监测记录初始化错误：', error);
}

if (sanitizeMojibakeCollections()) {
  chrome.storage.local.set({monitor, mutualNetwork, profileCache}).catch(() => {});
  persist('monitor', monitor);
  persist('mutualNetwork', mutualNetwork);
  persist('profileCache', profileCache);
  renderMonitorList();
  renderMutualNetwork();
}

setTab('monitor');

Promise.all([
  durableGet('rows'),
  durableGet('monitor'),
  durableGet('analysisRows'),
  durableGet('profileCache'),
  durableGet('mutualNetwork'),
  durableGet('commentTracking'),
  durableGet('autoFollowLogs'),
  durableGet('mutualAutoFollowSettings'),
  durableGet('commentAutoFollowSettings'),
  durableGet('unreciprocatedTracker'),
  durableGet('unreciprocatedLogs')
]).then(async ([savedRows, savedMonitor, savedAnalysis, savedProfiles, savedNetwork, savedComments, savedLogs, durableMutualAuto, durableCommentAuto, durableUnrecip, durableUnrecipLogs]) => {
  if (durableUnrecip && Array.isArray(durableUnrecip.users) && (!unreciprocatedTracker.users.length || (durableUnrecip.updatedAt && durableUnrecip.updatedAt > unreciprocatedTracker.updatedAt))) {
    unreciprocatedTracker = {
      ...durableUnrecip,
      config: normalizeUnreciprocatedConfig(durableUnrecip.config || unreciprocatedTracker.config)
    };
    await chrome.storage.local.set({ unreciprocatedTracker });
    syncAllActiveFollowedUsers();
    renderUnreciprocatedSettingsDrawer();
    renderUnreciprocatedUI();
  }
  if (Array.isArray(durableUnrecipLogs) && durableUnrecipLogs.length && !unreciprocatedLogs.length) {
    unreciprocatedLogs = durableUnrecipLogs;
    await chrome.storage.local.set({ unreciprocatedLogs });
  }
  if (durableMutualAuto) {
    mutualNetwork.autoFollow = normalizeAutoFollowConfig({ ...mutualNetwork.autoFollow, ...durableMutualAuto });
    await chrome.storage.local.set({ mutualAutoFollowSettings: mutualNetwork.autoFollow });
    renderMutualSettingsDrawer();
  }
  if (durableCommentAuto) {
    commentTracking.autoFollow = normalizeAutoFollowConfig({ ...commentTracking.autoFollow, ...durableCommentAuto });
    await chrome.storage.local.set({ commentAutoFollowSettings: commentTracking.autoFollow });
    renderCommentAutoFollowSettings();
  }
  if (Array.isArray(savedLogs) && savedLogs.length && !autoFollowLogs.length) { autoFollowLogs = savedLogs; await chrome.storage.local.set({autoFollowLogs}); renderLogsModal(); }
  if (!rows.length && Array.isArray(savedRows) && savedRows.length) {
    rows = savedRows;
    await chrome.storage.local.set({rows});
  }
  if (!monitor.lastScan && savedMonitor) { monitor = {...monitor, ...savedMonitor}; if (!Array.isArray(monitor.followingUsers)) monitor.followingUsers = []; await chrome.storage.local.set({monitor}); renderQueue(); renderMonitorList(); }
  if (!analysisRows.length && Array.isArray(savedAnalysis) && savedAnalysis.length) { analysisRows = savedAnalysis; await chrome.storage.local.set({analysisRows}); analysisStatus(`已从 X 本地数据库恢复 ${analysisRows.length} 个历史分析账号。`); }
  if (!Object.keys(profileCache).length && savedProfiles && typeof savedProfiles === 'object') { profileCache=savedProfiles; await chrome.storage.local.set({profileCache}); }
  if (!(mutualNetwork.users || []).length && savedNetwork) {
    mutualNetwork = {
      ...mutualNetwork,
      ...savedNetwork,
      autoFollow: normalizeAutoFollowConfig(savedNetwork.autoFollow || mutualNetwork.autoFollow || {})
    };
    await chrome.storage.local.set({mutualNetwork});
    renderMutualNetwork();
    renderMutualSettingsDrawer();
    networkStatus(`已从 X 本地数据库恢复 ${mutualNetwork.users?.length || 0} 个去重账号。`);
  }
  if (!(commentTracking.users || []).length && savedComments?.users?.length) {
    commentTracking = {...savedComments, autoFollow:normalizeAutoFollowConfig(savedComments.autoFollow || commentTracking.autoFollow || {})};
    await chrome.storage.local.set({commentTracking});
    renderCommentTracking();
    renderCommentAutoFollowSettings();
    chrome.runtime.sendMessage({cmd:'configureCommentAutoFollow', config:commentTracking.autoFollow}).catch(() => {});
  }
  if (sanitizeMojibakeCollections()) {
    await chrome.storage.local.set({monitor, mutualNetwork, profileCache});
    persist('monitor', monitor);
    persist('mutualNetwork', mutualNetwork);
    persist('profileCache', profileCache);
    renderMonitorList();
    renderMutualNetwork();
  }
}).catch(() => {});



function bindSaveButton(id, saveFn, onError) {
  const button = $(id);
  if (!button) return;
  button.addEventListener('click', async () => {
    const label = button.textContent;
    button.disabled = true;
    try { await saveFn(); button.textContent = '已保存 ✓'; }
    catch (error) { button.textContent = '保存失败'; onError?.(error); }
    setTimeout(() => { button.textContent = label; button.disabled = false; }, 1500);
  });
}
// 失焦/切换自动保存之外，保留显式「保存配置」按钮，让用户安心
bindSaveButton('saveSettingsDrawer', () => saveMonitorSettings(), error => monitorStatus(error.message));
bindSaveButton('saveMutualSettings', () => saveMutualAutoFollowSettings(), error => networkStatus(error.message));
bindSaveButton('saveCommentAutoSettings', () => saveCommentAutoFollowSettings(), error => { $('commentTrackingStatus').textContent = error.message; });



// ==================== 定时看帖关注执行日志模块 ====================

async function recordAutoFollowLog(entry) {
  const now = new Date();
  const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const logItem = {
    id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    at: now.toISOString(),
    timeStr,
    scope: entry.scope || 'mutual', // 'mutual' | 'comment'
    source: entry.source || 'auto', // 'alarm' | 'manual'
    handle: String(entry.handle || '').replace(/^@/, ''),
    name: entry.name || '',
    result: entry.result || 'followed', // followed, skipped, failed, rate_limited
    detail: entry.detail || '',
    posts: (entry.posts || []).slice(0, 10).map(p => ({
      text: typeof p === 'string' ? p : (p?.text || ''),
      url: p?.url || '',
      time: p?.time || ''
    })),
    grokComment: entry.grokComment || '',
    grokCommentPost: entry.grokCommentPost || '',
    grokCommentPostUrl: entry.grokCommentPostUrl || ''
  };
  autoFollowLogs.unshift(logItem);
  if (autoFollowLogs.length > 300) autoFollowLogs = autoFollowLogs.slice(0, 300);
  await chrome.storage.local.set({autoFollowLogs});
  persist('autoFollowLogs', autoFollowLogs);
  renderLogsModal();
}

function renderLogsModal() {
  const modal = $('logsModal');
  if (!modal) return;
  const isUnrecip = currentLogsScope === 'unreciprocated';
  const logsData = isUnrecip ? unreciprocatedLogs : autoFollowLogs;
  const badge = $('logsTotalBadge');
  if (badge) badge.textContent = `${logsData.length} 条记录`;
  const empty = $('logsEmpty');
  const list = $('logsList');
  if (empty) empty.hidden = logsData.length > 0;
  if (!list) return;
  list.replaceChildren();

  if (isUnrecip) {
    for (const log of logsData) {
      const card = document.createElement('div');
      card.className = 'log-card';

      const header = document.createElement('div');
      header.className = 'log-card-header';

      const meta = document.createElement('div');
      meta.className = 'log-card-meta';

      const timeSpan = document.createElement('span');
      timeSpan.className = 'log-time';
      timeSpan.textContent = log.at ? new Date(log.at).toLocaleString() : '未知时间';

      const scopeSpan = document.createElement('span');
      scopeSpan.className = 'log-scope-badge';
      scopeSpan.textContent = '回关监测';

      const sourceSpan = document.createElement('span');
      sourceSpan.className = 'log-scope-badge';
      sourceSpan.textContent = log.source === 'manual' ? '手动检测' : '定时执行';

      meta.append(timeSpan, scopeSpan, sourceSpan);

      const resultBadge = document.createElement('span');
      resultBadge.className = 'badge';
      if (log.result === 'success') {
        resultBadge.classList.add('candidate');
        resultBadge.textContent = '执行完成 ✓';
      } else {
        resultBadge.style.background = '#fbe9e7';
        resultBadge.style.color = '#c62828';
        resultBadge.textContent = '执行失败';
      }
      header.append(meta, resultBadge);
      card.append(header);

      const summaryRow = document.createElement('div');
      summaryRow.style.padding = '8px 12px';
      summaryRow.style.fontSize = '13px';
      summaryRow.style.color = '#263238';
      summaryRow.textContent = log.summary || '';
      card.append(summaryRow);

      if (log.unfollowedHandles && log.unfollowedHandles.length > 0) {
        const unfollowRow = document.createElement('div');
        unfollowRow.style.padding = '0 12px 8px';
        unfollowRow.style.fontSize = '12px';
        unfollowRow.style.color = '#c62828';
        unfollowRow.textContent = '已取关账号：' + log.unfollowedHandles.map(h => '@' + h).join('， ');
        card.append(unfollowRow);
      }

      list.append(card);
    }
    return;
  }

  for (const log of autoFollowLogs) {
    const card = document.createElement('div');
    card.className = 'log-card';

    // 头部：时间、作用域、状态徽章
    const header = document.createElement('div');
    header.className = 'log-card-header';

    const meta = document.createElement('div');
    meta.className = 'log-card-meta';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = log.timeStr || (log.at ? new Date(log.at).toLocaleString() : '未知时间');

    const scopeSpan = document.createElement('span');
    scopeSpan.className = 'log-scope-badge';
    scopeSpan.textContent = log.scope === 'comment' ? '评论追踪' : '互关追踪';

    const sourceSpan = document.createElement('span');
    sourceSpan.className = 'log-scope-badge';
    sourceSpan.textContent = log.source === 'manual' ? '手动测试' : '定时执行';

    meta.append(timeSpan, scopeSpan, sourceSpan);

    const resultBadge = document.createElement('span');
    resultBadge.className = 'badge';
    if (log.result === 'followed') {
      resultBadge.classList.add('candidate');
      resultBadge.textContent = '关注成功 ✓';
    } else if (log.result === 'skipped') {
      resultBadge.classList.add('review');
      resultBadge.textContent = '已跳过';
    } else if (log.result === 'rate_limited') {
      resultBadge.style.background = '#fde8e4';
      resultBadge.style.color = '#a23924';
      resultBadge.textContent = '频率限制';
    } else {
      resultBadge.style.background = '#fbe9e7';
      resultBadge.style.color = '#c62828';
      resultBadge.textContent = '未成功';
    }
    header.append(meta, resultBadge);
    card.append(header);

    // 账号信息：@handle 链接
    const targetRow = document.createElement('div');
    targetRow.className = 'log-card-target';

    const targetLink = document.createElement('a');
    targetLink.className = 'log-target-link';
    targetLink.href = `https://x.com/${encodeURIComponent(log.handle)}`;
    targetLink.target = '_blank';
    targetLink.rel = 'noopener noreferrer';
    targetLink.textContent = '@' + log.handle;

    const targetName = document.createElement('span');
    targetName.className = 'log-target-name';
    targetName.textContent = log.name ? repairMojibake(log.name) : '';

    targetRow.append(targetLink, targetName);
    card.append(targetRow);

    // 执行描述
    if (log.detail) {
      const desc = document.createElement('p');
      desc.className = 'log-detail-text';
      desc.textContent = log.detail;
      card.append(desc);
    }

    // 扫描帖子展示
    const postsBox = document.createElement('div');
    postsBox.className = 'log-posts-box';

    const postsTitle = document.createElement('strong');
    postsTitle.className = 'log-posts-title';
    postsTitle.textContent = log.posts?.length ? `扫描主页帖子（共 ${log.posts.length} 条）：` : '未扫描到主页公开帖子';
    postsBox.append(postsTitle);

    if (log.posts?.length) {
      const postsList = document.createElement('ol');
      postsList.className = 'log-posts-list';
      for (const p of log.posts) {
        const li = document.createElement('li');
        li.className = 'log-post-item';

        if (p.time) {
          const t = document.createElement('span');
          t.className = 'log-post-time';
          t.textContent = `[${p.time.slice(0, 10)}] `;
          li.append(t);
        }

        const txt = document.createElement('span');
        txt.textContent = repairMojibake(p.text || '(无正文)').slice(0, 160);
        li.append(txt);

        if (p.url) {
          const a = document.createElement('a');
          a.className = 'log-post-link';
          a.href = p.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = '查看原帖 ↗';
          li.append(a);
        }
        postsList.append(li);
      }
      postsBox.append(postsList);
    }
    if (log.grokComment) {
      const grokBox = document.createElement('div');
      grokBox.className = 'log-grok-box';

      const grokHeader = document.createElement('div');
      grokHeader.className = 'log-grok-header';

      const grokTag = document.createElement('span');
      grokTag.className = 'log-grok-tag';
      grokTag.textContent = '🤖 Grok 互动回评建议';
      grokHeader.append(grokTag);

      if (log.grokCommentPostUrl) {
        const postLink = document.createElement('a');
        postLink.className = 'log-grok-post-link';
        postLink.href = log.grokCommentPostUrl;
        postLink.target = '_blank';
        postLink.rel = 'noopener noreferrer';
        postLink.textContent = '原推链接 ↗';
        grokHeader.append(postLink);
      }

      const copyBtn = document.createElement('button');
      copyBtn.className = 'log-copy-btn';
      copyBtn.textContent = '一键复制回评';
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(log.grokComment);
          copyBtn.textContent = '已复制！';
          setTimeout(() => { copyBtn.textContent = '一键复制回评'; }, 1800);
        } catch {
          copyBtn.textContent = '复制失败';
        }
      });
      grokHeader.append(copyBtn);
      grokBox.append(grokHeader);

      if (log.grokCommentPost) {
        const postPreview = document.createElement('div');
        postPreview.style.fontSize = '11px';
        postPreview.style.color = 'var(--text-subtle)';
        postPreview.style.marginBottom = '4px';
        postPreview.style.paddingLeft = '6px';
        postPreview.style.borderLeft = '2px solid var(--border-soft)';
        postPreview.style.maxHeight = '38px';
        postPreview.style.overflow = 'hidden';
        postPreview.style.textOverflow = 'ellipsis';
        postPreview.textContent = '针对推文：' + log.grokCommentPost;
        grokBox.append(postPreview);
      }

      const grokBody = document.createElement('div');
      grokBody.className = 'log-grok-body';
      grokBody.textContent = log.grokComment;
      grokBox.append(grokBody);

      card.append(grokBox);
    }

    card.append(postsBox);
    list.append(card);
  }
}

let currentLogsScope = 'autoFollow';

function openLogsModal(scope = 'autoFollow') {
  currentLogsScope = scope;
  const modal = $('logsModal');
  const mask = $('logsModalMask');
  const title = $('logsModalTitle');
  if (title) {
    title.textContent = scope === 'unreciprocated' ? '回关监测 · 定时检测与取关日志' : '定时看帖关注 · 执行日志';
  }
  if (modal) modal.hidden = false;
  if (mask) mask.hidden = false;
  renderLogsModal();
}

function closeLogsModal() {
  const modal = $('logsModal');
  const mask = $('logsModalMask');
  if (modal) modal.hidden = true;
  if (mask) mask.hidden = true;
}

async function clearAutoFollowLogs() {
  if (currentLogsScope === 'unreciprocated') {
    if (!confirm('确定清空所有回关监测执行日志吗？此操作不可撤销。')) return;
    unreciprocatedLogs = [];
    await chrome.storage.local.set({unreciprocatedLogs});
    persist('unreciprocatedLogs', unreciprocatedLogs);
    renderLogsModal();
    return;
  }
  if (!confirm('确定清空所有执行日志记录吗？此操作不可撤销。')) return;
  autoFollowLogs = [];
  await chrome.storage.local.set({autoFollowLogs});
  persist('autoFollowLogs', autoFollowLogs);
  renderLogsModal();
}

// 绑定日志弹窗事件
async function handleTestGrokClick(buttonId, displayId) {
  const btn = $(buttonId);
  const handleEl = $(displayId);
  if (!btn) return;
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '探测中…';
  if (handleEl) handleEl.textContent = '正在并发探测 x.com 与 grok.com 运行环境…';

  try {
    const res = await checkGrokAvailability(true);
    if (handleEl) {
      handleEl.textContent = res.message;
      handleEl.style.color = res.available ? '#1d5c3a' : '#c62828';
    }
    alert(res.available ? `Grok 可用 ✓\n${res.message}` : `Grok 暂不可用 ✕\n${res.message}\n\n此时定时关注将自动跳过生成评论，不影响正常看帖和关注。如需使用评论建议，请先登录 grok.com 或开通 X Premium。`);
  } catch (err) {
    if (handleEl) handleEl.textContent = '探测失败：' + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

$('testMutualGrokBtn')?.addEventListener('click', () => handleTestGrokClick('testMutualGrokBtn', 'mutualGrokStatusHandle'));
$('testCommentGrokBtn')?.addEventListener('click', () => handleTestGrokClick('testCommentGrokBtn', 'commentGrokStatusHandle'));

$('openMutualLogs')?.addEventListener('click', openLogsModal);
$('openCommentLogs')?.addEventListener('click', openLogsModal);
$('viewMutualLogsLink')?.addEventListener('click', openLogsModal);
$('viewCommentLogsLink')?.addEventListener('click', openLogsModal);
$('closeLogsModal')?.addEventListener('click', closeLogsModal);
$('logsModalMask')?.addEventListener('click', closeLogsModal);
$('clearLogsBtn')?.addEventListener('click', clearAutoFollowLogs);

// ==============================================================================
// 回关监测模块核心实现 (Unreciprocated Followback Tracker Module)
// ==============================================================================

function normalizeUnreciprocatedConfig(cfg = {}) {
  const defaults = {
    enabled: false,
    every: 60,
    jitter: 10,
    overdueDays: 14,
    autoUnfollow: false,
    batchLimit: 10,
    unfollowDelay: 3,
    whitelist: '',
    lastRunAt: null,
    lastSummary: '尚未执行回关监测'
  };
  const res = { ...defaults, ...(cfg || {}) };
  res.every = Math.max(5, Math.min(1440, Number(res.every) || 60));
  res.jitter = Math.max(0, Math.min(60, Number(res.jitter) ?? 10));
  res.overdueDays = Math.max(1, Math.min(90, Number(res.overdueDays) || 14));
  res.autoUnfollow = Boolean(res.autoUnfollow);
  res.batchLimit = Math.max(1, Math.min(50, Number(res.batchLimit) || 10));
  res.unfollowDelay = Math.max(1, Math.min(30, Number(res.unfollowDelay) || 3));
  res.whitelist = String(res.whitelist || '').trim();
  return res;
}

async function saveUnreciprocatedTracker() {
  unreciprocatedTracker.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({
    unreciprocatedTracker,
    unreciprocatedSettings: unreciprocatedTracker.config
  });
  persist('unreciprocatedTracker', unreciprocatedTracker);
  persist('unreciprocatedSettings', unreciprocatedTracker.config);
  try {
    if (chrome.storage?.sync) {
      await chrome.storage.sync.set({ unreciprocatedSettings: unreciprocatedTracker.config });
    }
  } catch {}
}

async function appendUnreciprocatedLog(logEntry) {
  const entry = {
    at: new Date().toISOString(),
    ...logEntry
  };
  unreciprocatedLogs.unshift(entry);
  if (unreciprocatedLogs.length > 300) unreciprocatedLogs = unreciprocatedLogs.slice(0, 300);
  await chrome.storage.local.set({ unreciprocatedLogs });
  persist('unreciprocatedLogs', unreciprocatedLogs);
  if (currentLogsScope === 'unreciprocated') {
    renderLogsModal();
  }
}

function registerTrackedFollow(user) {
  if (!user?.handle) return;
  const key = String(user.handle).toLowerCase();
  const now = new Date().toISOString();
  let item = (unreciprocatedTracker.users || []).find(u => String(u.handle || '').toLowerCase() === key);
  if (!item) {
    item = {
      id: user.id || '',
      handle: user.handle,
      name: user.name || user.handle,
      avatarUrl: user.avatarUrl || '',
      bio: user.bio || '',
      followersText: user.followersText || '',
      followingText: user.followingText || '',
      followedAt: now,
      followBackAt: null,
      relationship: { following: true, followedBy: false },
      status: 'pending',
      lastCheckedAt: now,
      exempt: false
    };
    unreciprocatedTracker.users.unshift(item);
  } else {
    item.followedAt = item.followedAt || now;
    item.relationship = { ...(item.relationship || {}), following: true, followedBy: false };
    if (item.status !== 'mutual') item.status = 'pending';
    item.lastCheckedAt = now;
  }
  saveUnreciprocatedTracker();
  renderUnreciprocatedUI();
}

function syncAllActiveFollowedUsers() {
  const existingMap = new Map((unreciprocatedTracker.users || []).map(u => [String(u.handle || '').toLowerCase(), u]));
  const now = new Date().toISOString();
  let added = 0;

  const candidatePool = [
    ...(monitor.followingUsers || []),
    ...(monitor.users || []).filter(u => u.relationship?.following === true || u.state === 'following'),
    ...(mutualNetwork.users || []).filter(u => u.relationship?.following === true || u.followedAt),
    ...(commentTracking.users || []).filter(u => u.relationship?.following === true || u.followedAt)
  ];

  for (const user of candidatePool) {
    if (!user?.handle) continue;
    const key = String(user.handle).toLowerCase();
    let item = existingMap.get(key);
    if (!item) {
      item = {
        id: user.id || '',
        handle: user.handle,
        name: user.name || user.handle,
        avatarUrl: user.avatarUrl || '',
        bio: user.bio || '',
        followersText: user.followersText || '',
        followingText: user.followingText || '',
        followedAt: user.followedAt || now,
        followBackAt: user.followBackAt || null,
        relationship: { following: true, followedBy: user.relationship?.followedBy === true },
        status: user.relationship?.followedBy === true ? 'mutual' : 'pending',
        lastCheckedAt: now,
        exempt: false
      };
      existingMap.set(key, item);
      unreciprocatedTracker.users.unshift(item);
      added++;
    } else {
      if (user.id && !item.id) item.id = user.id;
      if (user.name && !item.name) item.name = user.name;
      if (user.avatarUrl && !item.avatarUrl) item.avatarUrl = user.avatarUrl;
      if (user.bio && !item.bio) item.bio = user.bio;
      if (user.followersText && !item.followersText) item.followersText = user.followersText;
      if (user.followingText && !item.followingText) item.followingText = user.followingText;
      if (user.followedAt && (!item.followedAt || Date.parse(user.followedAt) < Date.parse(item.followedAt))) {
        item.followedAt = user.followedAt;
      }
    }
  }
  return added;
}

function evaluateUnreciprocatedUser(item, followerHandles, overdueDays) {
  const key = String(item.handle || '').toLowerCase();
  const isMutual = followerHandles.has(key) || item.relationship?.followedBy === true;
  if (isMutual) {
    item.relationship = { ...(item.relationship || {}), following: true, followedBy: true };
    item.status = 'mutual';
    item.followBackAt = item.followBackAt || new Date().toISOString();
  } else {
    item.relationship = { ...(item.relationship || {}), following: true, followedBy: false };
    const followedTime = Date.parse(item.followedAt) || Date.now();
    const elapsedDays = Math.floor((Date.now() - followedTime) / (24 * 3600 * 1000));
    item.daysSinceFollowed = Math.max(0, elapsedDays);
    if (elapsedDays >= overdueDays) {
      item.status = 'overdue';
    } else {
      item.status = 'pending';
    }
  }
  item.lastCheckedAt = new Date().toISOString();
}

async function runUnreciprocatedCheckCycle(source = 'manual') {
  if (unreciprocatedCheckRunning) return { ok: false, error: '回关检测任务已在运行中' };
  unreciprocatedCheckRunning = true;
  const cfg = normalizeUnreciprocatedConfig(unreciprocatedTracker.config);
  const statusEl = $('unreciprocatedStatus');
  if (statusEl) statusEl.textContent = '正在对比最新粉丝列表检测回关状态…';

  try {
    syncAllActiveFollowedUsers();
    const followerHandles = ownFollowerHandles();
    let mutualCount = 0;
    let pendingCount = 0;
    let overdueCount = 0;
    const overdueCandidates = [];
    const whitelistSet = new Set(
      cfg.whitelist.split(/[,，\n\s]+/).map(s => s.replace(/^@/, '').toLowerCase()).filter(Boolean)
    );

    for (const item of unreciprocatedTracker.users) {
      if (item.status === 'unfollowed') continue;
      evaluateUnreciprocatedUser(item, followerHandles, cfg.overdueDays);
      if (item.status === 'mutual') {
        mutualCount++;
      } else if (item.status === 'overdue') {
        overdueCount++;
        const key = item.handle.toLowerCase();
        if (!item.exempt && !whitelistSet.has(key)) {
          overdueCandidates.push(item);
        }
      } else {
        pendingCount++;
      }
    }

    let unfollowedCount = 0;
    let unfollowedHandles = [];

    if (cfg.autoUnfollow && overdueCandidates.length > 0) {
      overdueCandidates.sort((a,b) => (Date.parse(a.followedAt) || 0) - (Date.parse(b.followedAt) || 0));
      const targets = overdueCandidates.slice(0, cfg.batchLimit);
      if (statusEl) statusEl.textContent = `检测完毕：发现 ${overdueCount} 个超时未回关，正在自动安全取关前 ${targets.length} 人…`;

      let tabId = null;
      try {
        tabId = await backgroundXActionTab();
      } catch (err) {
        console.warn('获取后台 X 标签页失败，跳过自动取关：', err);
      }

      if (tabId != null) {
        for (let i = 0; i < targets.length; i++) {
          const user = targets[i];
          try {
            const res = await unfollowViaNetwork(tabId, user);
            if (res.ok) {
              user.status = 'unfollowed';
              user.unfollowedAt = new Date().toISOString();
              removeUnfollowedUser(user.handle);
              unfollowedCount++;
              unfollowedHandles.push(user.handle);
            }
          } catch (e) {
            console.error('自动取关失败：', user.handle, e);
          }
          if (i < targets.length - 1) {
            await sleep((cfg.unfollowDelay || 3) * 1000);
          }
        }
      }
    }

    const summaryText = `检测完成：监测中 ${unreciprocatedTracker.users.length} 人，已回关 ${mutualCount} 人，缓冲期待回关 ${pendingCount} 人，超时未回关 ${overdueCount} 人${unfollowedCount > 0 ? `，已自动取关 ${unfollowedCount} 人` : ''}。`;
    cfg.lastRunAt = new Date().toISOString();
    cfg.lastSummary = summaryText;
    unreciprocatedTracker.config = cfg;
    await saveUnreciprocatedTracker();

    await appendUnreciprocatedLog({
      source,
      totalTracked: unreciprocatedTracker.users.length,
      mutualCount,
      pendingCount,
      overdueCount,
      unfollowedCount,
      unfollowedHandles,
      summary: summaryText,
      result: 'success'
    });

    renderUnreciprocatedUI();
    renderUnreciprocatedSettingsDrawer();
    if (statusEl) statusEl.textContent = summaryText;
    return { ok: true, summary: summaryText };
  } catch (err) {
    if (statusEl) statusEl.textContent = `检测出错：${err.message}`;
    await appendUnreciprocatedLog({
      source,
      summary: `检测失败：${err.message}`,
      result: 'failed'
    });
    return { ok: false, error: err.message };
  } finally {
    unreciprocatedCheckRunning = false;
  }
}

async function unfollowOneUnreciprocated(user, btn) {
  const key = String(user.handle || '').toLowerCase();
  if (!key || unreciprocatedBusy.has(key)) return;
  unreciprocatedBusy.add(key);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '取关中…';
  }
  const statusEl = $('unreciprocatedStatus');
  if (statusEl) statusEl.textContent = `正在取消关注 @${user.handle}…`;

  try {
    const tabId = await backgroundXActionTab();
    const result = await unfollowViaNetwork(tabId, user);
    if (result.ok) {
      user.status = 'unfollowed';
      user.unfollowedAt = new Date().toISOString();
      removeUnfollowedUser(user.handle);
      await saveUnreciprocatedTracker();
      await chrome.storage.local.set({ monitor, mutualNetwork });
      persist('monitor', monitor);
      persist('mutualNetwork', mutualNetwork);
      renderUnreciprocatedUI();
      if (statusEl) statusEl.textContent = `已成功取消关注 @${user.handle}。`;
      return;
    }
    if (statusEl) statusEl.textContent = `@${user.handle} 取关未完成：${result.error || result.reason}`;
  } catch (error) {
    if (statusEl) statusEl.textContent = `@${user.handle} 取关失败：${error.message}`;
  } finally {
    unreciprocatedBusy.delete(key);
    if (btn && btn.isConnected) {
      btn.disabled = false;
      btn.textContent = '取消关注';
    }
  }
}

async function batchUnfollowUnreciprocated(targetsOverride = null) {
  if (unreciprocatedUnfollowRunning) {
    unreciprocatedUnfollowStopped = true;
    const statusEl = $('unreciprocatedStatus');
    if (statusEl) statusEl.textContent = '正在停止批量取关…';
    return;
  }
  let targets = targetsOverride;
  if (!targets) {
    const activeList = getFilteredUnreciprocatedUsers();
    targets = activeList.filter(u => selectedUnreciprocatedHandles.has(u.handle.toLowerCase()) && u.status !== 'unfollowed');
  }
  if (!targets.length) {
    const statusEl = $('unreciprocatedStatus');
    if (statusEl) statusEl.textContent = '请先勾选需要取消关注的账号。';
    return;
  }
  if (!confirm(`确定要批量取消关注这 ${targets.length} 个账号吗？减少无信用的浑水摸鱼粉丝。`)) return;

  unreciprocatedUnfollowRunning = true;
  unreciprocatedUnfollowStopped = false;
  const batchBtn = $('batchUnfollowUnreciprocatedBtn');
  const allOverdueBtn = $('unfollowAllOverdueBtn');
  if (batchBtn) { batchBtn.textContent = '停止取关'; batchBtn.disabled = false; }
  if (allOverdueBtn) { allOverdueBtn.disabled = true; }

  const statusEl = $('unreciprocatedStatus');
  if (statusEl) statusEl.textContent = `准备批量取关 ${targets.length} 个账号…`;

  let tabId;
  try {
    tabId = await backgroundXActionTab();
  } catch (err) {
    unreciprocatedUnfollowRunning = false;
    if (batchBtn) batchBtn.textContent = '批量取关';
    if (allOverdueBtn) allOverdueBtn.disabled = false;
    if (statusEl) statusEl.textContent = `X 后台会话不可用：${err.message}`;
    return;
  }

  let completed = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      if (unreciprocatedUnfollowStopped) {
        if (statusEl) statusEl.textContent = `已停止批量取关，本次成功取关 ${completed} 个，剩余 ${targets.length - completed} 个。;`
        break;
      }
      const user = targets[i];
      if (statusEl) statusEl.textContent = `正在取关 (${i + 1}/${targets.length})：@${user.handle}…`;
      try {
        const result = await unfollowViaNetwork(tabId, user);
        if (result.ok) {
          user.status = 'unfollowed';
          user.unfollowedAt = new Date().toISOString();
          removeUnfollowedUser(user.handle);
          selectedUnreciprocatedHandles.delete(user.handle.toLowerCase());
          completed++;
        }
      } catch (e) {
        console.error('取关出错：', user.handle, e);
      }
      if (i % 3 === 0 || i === targets.length - 1) {
        await saveUnreciprocatedTracker();
        await chrome.storage.local.set({ monitor, mutualNetwork });
        persist('monitor', monitor);
        persist('mutualNetwork', mutualNetwork);
        renderUnreciprocatedUI();
      }
      if (i < targets.length - 1 && !unreciprocatedUnfollowStopped) {
        await sleep(1500 + Math.floor(Math.random() * 1500));
      }
    }
  } finally {
    unreciprocatedUnfollowRunning = false;
    if (batchBtn) { batchBtn.textContent = '批量取关'; batchBtn.disabled = selectedUnreciprocatedHandles.size === 0; }
    if (allOverdueBtn) allOverdueBtn.disabled = false;
    await saveUnreciprocatedTracker();
    await chrome.storage.local.set({ monitor, mutualNetwork });
    persist('monitor', monitor);
    persist('mutualNetwork', mutualNetwork);
    renderUnreciprocatedUI();
    if (!unreciprocatedUnfollowStopped && statusEl) {
      statusEl.textContent = `批量取关完成，本次成功取关 ${completed} 个账号。`;
    }
  }
}

function getFilteredUnreciprocatedUsers() {
  const users = (unreciprocatedTracker.users || []).filter(u => u.status !== 'unfollowed');
  const keyword = unreciprocatedSearch.trim().toLowerCase();

  return users.filter(user => {
    // 状态分类 Tab 过滤
    if (activeUnreciprocatedTab === 'overdue' && user.status !== 'overdue') return false;
    if (activeUnreciprocatedTab === 'pending' && user.status !== 'pending') return false;
    if (activeUnreciprocatedTab === 'mutual' && user.status !== 'mutual') return false;

    // 搜索过滤
    if (keyword) {
      const h = String(user.handle || '').toLowerCase();
      const n = String(user.name || '').toLowerCase();
      const b = String(user.bio || '').toLowerCase();
      if (!h.includes(keyword) && !n.includes(keyword) && !b.includes(keyword)) return false;
    }
    return true;
  }).sort((a,b) => {
    // 超时账号排在前，超期天数大的排在前
    if (a.status === 'overdue' && b.status !== 'overdue') return -1;
    if (a.status !== 'overdue' && b.status === 'overdue') return 1;
    return (Date.parse(a.followedAt) || 0) - (Date.parse(b.followedAt) || 0);
  });
}

function renderUnreciprocatedUI() {
  const allActive = (unreciprocatedTracker.users || []).filter(u => u.status !== 'unfollowed');
  const overdueCount = allActive.filter(u => u.status === 'overdue').length;
  const pendingCount = allActive.filter(u => u.status === 'pending').length;
  const mutualCount = allActive.filter(u => u.status === 'mutual').length;
  const totalCount = allActive.length;

  if ($('unreciprocatedOverdueBadge')) $('unreciprocatedOverdueBadge').textContent = overdueCount;
  if ($('unreciprocatedPendingBadge')) $('unreciprocatedPendingBadge').textContent = pendingCount;
  if ($('unreciprocatedTotalBadge')) $('unreciprocatedTotalBadge').textContent = totalCount;
  if ($('unreciprocatedCount')) $('unreciprocatedCount').textContent = overdueCount;

  if ($('tabOverdueCount')) $('tabOverdueCount').textContent = overdueCount;
  if ($('tabPendingCount')) $('tabPendingCount').textContent = pendingCount;
  if ($('tabMutualCount')) $('tabMutualCount').textContent = mutualCount;
  if ($('tabAllCount')) $('tabAllCount').textContent = totalCount;

  const filtered = getFilteredUnreciprocatedUsers();
  const totalPages = Math.max(1, Math.ceil(filtered.length / unreciprocatedPageSize));
  if (unreciprocatedPage > totalPages) unreciprocatedPage = totalPages;

  const start = (unreciprocatedPage - 1) * unreciprocatedPageSize;
  const pageUsers = filtered.slice(start, start + unreciprocatedPageSize);

  if ($('unreciprocatedPageSummary')) {
    $('unreciprocatedPageSummary').textContent = `第 ${unreciprocatedPage} / ${totalPages} 页（共 ${filtered.length} 人）`;
  }
  if ($('unreciprocatedPrevPage')) $('unreciprocatedPrevPage').disabled = unreciprocatedPage <= 1;
  if ($('unreciprocatedNextPage')) $('unreciprocatedNextPage').disabled = unreciprocatedPage >= totalPages;

  if ($('unreciprocatedSelectedCount')) $('unreciprocatedSelectedCount').textContent = selectedUnreciprocatedHandles.size;
  if ($('unreciprocatedTotalVisibleCount')) $('unreciprocatedTotalVisibleCount').textContent = filtered.length;
  if ($('batchUnfollowUnreciprocatedBtn')) {
    $('batchUnfollowUnreciprocatedBtn').disabled = selectedUnreciprocatedHandles.size === 0 || unreciprocatedUnfollowRunning;
  }

  const tbody = $('unreciprocatedResults');
  const emptyEl = $('unreciprocatedEmpty');
  if (!tbody) return;
  tbody.replaceChildren();

  if (!pageUsers.length) {
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  const overdueDaysCfg = Number(unreciprocatedTracker.config?.overdueDays) || 14;

  for (const user of pageUsers) {
    const key = String(user.handle || '').toLowerCase();
    const tr = document.createElement('tr');

    // 1. 复选框
    const tdCheck = document.createElement('td');
    tdCheck.className = 'col-check';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = selectedUnreciprocatedHandles.has(key);
    check.addEventListener('change', () => {
      if (check.checked) selectedUnreciprocatedHandles.add(key);
      else selectedUnreciprocatedHandles.delete(key);
      if ($('unreciprocatedSelectedCount')) $('unreciprocatedSelectedCount').textContent = selectedUnreciprocatedHandles.size;
      if ($('batchUnfollowUnreciprocatedBtn')) $('batchUnfollowUnreciprocatedBtn').disabled = selectedUnreciprocatedHandles.size === 0;
    });
    tdCheck.append(check);
    tr.append(tdCheck);

    // 2. 账号与简介
    const tdAccount = document.createElement('td');
    tdAccount.className = 'col-account';
    const accBox = document.createElement('div');
    accBox.style.display = 'flex';
    accBox.style.alignItems = 'flex-start';
    accBox.style.gap = '8px';

    if (user.avatarUrl) {
      const img = document.createElement('img');
      img.src = user.avatarUrl;
      img.style.width = '32px';
      img.style.height = '32px';
      img.style.borderRadius = '50%';
      img.style.flexShrink = '0';
      accBox.append(img);
    }
    const accMeta = document.createElement('div');
    const nameLink = document.createElement('a');
    nameLink.href = `https://x.com/${encodeURIComponent(user.handle)}`;
    nameLink.target = '_blank';
    nameLink.rel = 'noopener noreferrer';
    nameLink.style.fontWeight = '600';
    nameLink.style.color = '#18302e';
    nameLink.textContent = repairMojibake(user.name || user.handle);

    const handleSpan = document.createElement('span');
    handleSpan.style.fontSize = '12px';
    handleSpan.style.color = '#52685d';
    handleSpan.style.marginLeft = '4px';
    handleSpan.textContent = '@' + user.handle;

    const bioP = document.createElement('div');
    bioP.style.fontSize = '12px';
    bioP.style.color = '#455a64';
    bioP.style.marginTop = '2px';
    bioP.style.lineHeight = '1.3';
    bioP.textContent = repairMojibake(user.bio || '暂无简介');

    accMeta.append(nameLink, handleSpan, bioP);
    accBox.append(accMeta);
    tdAccount.append(accBox);
    tr.append(tdAccount);

    // 3. 关注记录与等待时长
    const tdRecord = document.createElement('td');
    tdRecord.className = 'col-record';
    const followedTime = Date.parse(user.followedAt);
    const dateStr = followedTime ? new Date(followedTime).toLocaleDateString() : '未知';
    const elapsedDays = Math.max(0, Math.floor((Date.now() - (followedTime || Date.now())) / (24 * 3600 * 1000)));

    const timeDiv = document.createElement('div');
    timeDiv.className = 'record-time-text';
    timeDiv.textContent = `关注于 ${dateStr}`;

    const waitDiv = document.createElement('div');
    if (user.status === 'overdue') {
      waitDiv.className = 'record-overdue-warn';
      waitDiv.textContent = `已等待 ${elapsedDays} 天（超期 ${elapsedDays - overdueDaysCfg} 天）`;
    } else if (user.status === 'mutual') {
      waitDiv.style.color = '#2e7d32';
      waitDiv.textContent = '已成功回关';
    } else {
      waitDiv.style.color = '#b78103';
      waitDiv.textContent = `已等待 ${elapsedDays} 天（缓冲期内）`;
    }
    tdRecord.append(timeDiv, waitDiv);
    tr.append(tdRecord);

    // 4. 回关状态徽章
    const tdRelation = document.createElement('td');
    tdRelation.className = 'col-relation';
    const badge = document.createElement('span');
    badge.className = 'badge-status';

    if (user.status === 'overdue') {
      badge.classList.add('badge-overdue');
      badge.textContent = '超时未回关 ✕';
      badge.title = `关注超过 ${overdueDaysCfg} 天仍未回关，疑似浑水摸鱼`;
    } else if (user.status === 'mutual') {
      badge.classList.add('badge-mutual');
      badge.textContent = '双向互关 ✓';
    } else {
      badge.classList.add('badge-pending');
      badge.textContent = '待回关中…';
      badge.title = '关注仍在两周观察缓冲期内';
    }
    tdRelation.append(badge);

    if (user.exempt) {
      const exBadge = document.createElement('span');
      exBadge.className = 'badge-status badge-exempt';
      exBadge.textContent = '豁免';
      exBadge.title = '白名单保护，定时任务不会自动取关';
      tdRelation.append(exBadge);
    }
    tr.append(tdRelation);

    // 5. 粉丝
    const tdFollowers = document.createElement('td');
    tdFollowers.className = 'col-count';
    tdFollowers.textContent = user.followersText || '-';
    tr.append(tdFollowers);

    // 6. 关注
    const tdFollowing = document.createElement('td');
    tdFollowing.className = 'col-count';
    tdFollowing.textContent = user.followingText || '-';
    tr.append(tdFollowing);

    // 7. 操作列
    const tdActions = document.createElement('td');
    tdActions.className = 'col-actions';
    tdActions.style.whiteSpace = 'nowrap';

    const unfollowBtn = document.createElement('button');
    unfollowBtn.className = 'secondary danger-btn';
    unfollowBtn.style.padding = '3px 8px';
    unfollowBtn.style.fontSize = '12px';
    unfollowBtn.textContent = '取消关注';
    unfollowBtn.disabled = unreciprocatedBusy.has(key);
    unfollowBtn.addEventListener('click', () => unfollowOneUnreciprocated(user, unfollowBtn));

    const exemptBtn = document.createElement('button');
    exemptBtn.className = 'secondary';
    exemptBtn.style.padding = '3px 8px';
    exemptBtn.style.fontSize = '12px';
    exemptBtn.style.marginLeft = '4px';
    exemptBtn.textContent = user.exempt ? '取消豁免' : '豁免';
    exemptBtn.title = user.exempt ? '取消保护，允许自动清理' : '加入保护白名单，绝不自动取关';
    exemptBtn.addEventListener('click', async () => {
      user.exempt = !user.exempt;
      await saveUnreciprocatedTracker();
      renderUnreciprocatedUI();
    });

    tdActions.append(unfollowBtn, exemptBtn);
    tr.append(tdActions);

    tbody.append(tr);
  }
}

function renderUnreciprocatedSettingsDrawer() {
  const cfg = normalizeUnreciprocatedConfig(unreciprocatedTracker.config);
  if ($('unreciprocatedAutoEvery')) $('unreciprocatedAutoEvery').value = cfg.every;
  if ($('unreciprocatedAutoJitter')) $('unreciprocatedAutoJitter').value = cfg.jitter;
  if ($('unreciprocatedOverdueDays')) $('unreciprocatedOverdueDays').value = cfg.overdueDays;
  if ($('unreciprocatedAutoUnfollow')) $('unreciprocatedAutoUnfollow').checked = cfg.autoUnfollow;
  if ($('unreciprocatedBatchLimit')) $('unreciprocatedBatchLimit').value = cfg.batchLimit;
  if ($('unreciprocatedUnfollowDelay')) $('unreciprocatedUnfollowDelay').value = cfg.unfollowDelay;
  if ($('unreciprocatedWhitelist')) $('unreciprocatedWhitelist').value = cfg.whitelist;
  if ($('unreciprocatedAutoEnabled')) $('unreciprocatedAutoEnabled').checked = cfg.enabled;

  if ($('unreciprocatedAutoSummary')) {
    $('unreciprocatedAutoSummary').textContent = cfg.lastSummary || '尚未执行回关监测';
  }
  if ($('unreciprocatedAutoLastTime')) {
    $('unreciprocatedAutoLastTime').textContent = cfg.lastRunAt ? new Date(cfg.lastRunAt).toLocaleString() : '';
  }
}

function openUnreciprocatedDrawer() {
  const drawer = $('unreciprocatedSettingsDrawer');
  const mask = $('profileDrawerMask');
  if (drawer) drawer.hidden = false;
  if (mask) mask.hidden = false;
  renderUnreciprocatedSettingsDrawer();
}

function closeUnreciprocatedDrawer() {
  const drawer = $('unreciprocatedSettingsDrawer');
  const mask = $('profileDrawerMask');
  if (drawer) drawer.hidden = true;
  if (mask) mask.hidden = true;
}

async function saveUnreciprocatedSettingsFromDrawer() {
  const cfg = normalizeUnreciprocatedConfig({
    every: $('unreciprocatedAutoEvery')?.value,
    jitter: $('unreciprocatedAutoJitter')?.value,
    overdueDays: $('unreciprocatedOverdueDays')?.value,
    autoUnfollow: $('unreciprocatedAutoUnfollow')?.checked,
    batchLimit: $('unreciprocatedBatchLimit')?.value,
    unfollowDelay: $('unreciprocatedUnfollowDelay')?.value,
    whitelist: $('unreciprocatedWhitelist')?.value,
    enabled: $('unreciprocatedAutoEnabled')?.checked,
    lastRunAt: unreciprocatedTracker.config?.lastRunAt || null,
    lastSummary: unreciprocatedTracker.config?.lastSummary || ''
  });
  unreciprocatedTracker.config = cfg;
  await saveUnreciprocatedTracker();
  chrome.runtime.sendMessage({ cmd: 'configureUnreciprocatedTracker', config: cfg }).catch(() => {});
  renderUnreciprocatedUI();
}

// 绑定回关监测面板交互事件
$('openUnreciprocatedSettingsDrawer')?.addEventListener('click', openUnreciprocatedDrawer);
$('closeUnreciprocatedSettingsDrawer')?.addEventListener('click', closeUnreciprocatedDrawer);
$('openUnreciprocatedLogs')?.addEventListener('click', () => openLogsModal('unreciprocated'));

bindSaveButton('saveUnreciprocatedSettings', () => saveUnreciprocatedSettingsFromDrawer(), err => alert('保存失败：' + err.message));

$('runUnreciprocatedNow')?.addEventListener('click', async () => {
  const btn = $('runUnreciprocatedNow');
  const oldText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '检测中…'; }
  try {
    await runUnreciprocatedCheckCycle('manual');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
  }
});

$('checkUnreciprocatedBtn')?.addEventListener('click', async () => {
  const btn = $('checkUnreciprocatedBtn');
  const oldText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '正在检测…'; }
  try {
    await runUnreciprocatedCheckCycle('manual');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldText; }
  }
});

$('batchUnfollowUnreciprocatedBtn')?.addEventListener('click', () => batchUnfollowUnreciprocated());

$('unfollowAllOverdueBtn')?.addEventListener('click', () => {
  const overdueTargets = (unreciprocatedTracker.users || []).filter(u => u.status === 'overdue' && !u.exempt);
  if (!overdueTargets.length) {
    alert('当前没有超时未回关且未豁免的账号！');
    return;
  }
  batchUnfollowUnreciprocated(overdueTargets);
});

// 分类 Tabs
document.querySelectorAll('.unreciprocated-tab').forEach(tabBtn => {
  tabBtn.addEventListener('click', () => {
    document.querySelectorAll('.unreciprocated-tab').forEach(b => b.classList.remove('active'));
    tabBtn.classList.add('active');
    activeUnreciprocatedTab = tabBtn.dataset.unreciprocatedTab || 'overdue';
    unreciprocatedPage = 1;
    renderUnreciprocatedUI();
  });
});

// 搜索
$('unreciprocatedSearch')?.addEventListener('input', debounce(() => {
  unreciprocatedSearch = $('unreciprocatedSearch')?.value || '';
  unreciprocatedPage = 1;
  renderUnreciprocatedUI();
}, 250));
$('unreciprocatedSearchBtn')?.addEventListener('click', () => {
  unreciprocatedSearch = $('unreciprocatedSearch')?.value || '';
  unreciprocatedPage = 1;
  renderUnreciprocatedUI();
});

// 分页
$('unreciprocatedPageSize')?.addEventListener('change', () => {
  unreciprocatedPageSize = Number($('unreciprocatedPageSize')?.value) || 50;
  unreciprocatedPage = 1;
  renderUnreciprocatedUI();
});
$('unreciprocatedPrevPage')?.addEventListener('click', () => {
  if (unreciprocatedPage > 1) {
    unreciprocatedPage--;
    renderUnreciprocatedUI();
  }
});
$('unreciprocatedNextPage')?.addEventListener('click', () => {
  unreciprocatedPage++;
  renderUnreciprocatedUI();
});

// 全选
$('unreciprocatedSelectAll')?.addEventListener('change', () => {
  const checked = $('unreciprocatedSelectAll')?.checked;
  const filtered = getFilteredUnreciprocatedUsers();
  const start = (unreciprocatedPage - 1) * unreciprocatedPageSize;
  const pageUsers = filtered.slice(start, start + unreciprocatedPageSize);
  for (const u of pageUsers) {
    const key = u.handle.toLowerCase();
    if (checked) selectedUnreciprocatedHandles.add(key);
    else selectedUnreciprocatedHandles.delete(key);
  }
  renderUnreciprocatedUI();
});
