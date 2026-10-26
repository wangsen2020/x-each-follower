import test from 'node:test';
import assert from 'node:assert/strict';
import {greetingDue, operateGreetingChatOnPage, sendGreetingViaChat} from '../src/features/relationships/greeting-chat.js';

test('greeting is due only for a confirmed pending follow after the configured delay', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const user = {status: 'pending', followedAtSource: 'confirmed', followedAt: new Date(now - 86400000).toISOString()};
  assert.equal(greetingDue(user, 1, now), true);
  assert.equal(greetingDue(user, 2, now), false);
  assert.equal(greetingDue({...user, status: 'mutual'}, 1, now), false);
  assert.equal(greetingDue({...user, followedAtSource: 'estimated'}, 1, now), true);
});

test('ambiguous Send execution keeps the message claim locked', async () => {
  let claimed = 0;
  let removed = 0;
  const api = {
    windows: {
      create: async () => ({id: 7, tabs: [{id: 8}]}),
      remove: async () => { removed++; }
    },
    scripting: {executeScript: async ({args}) => {
      const action = args[0].action;
      if (action === 'open') return [{result: {opened: true}}];
      if (action === 'prepare') return [{result: {prepared: true, priorRows: []}}];
      throw new Error('CDP detached after Send dispatch');
    }}
  };
  const result = await sendGreetingViaChat({
    ownerHandle: 'owner', ownerId: '1', targetHandle: 'recipient', targetId: '2', text: 'test',
    beforeSubmit: async () => { claimed++; }, api
  });
  assert.equal(result.ok, false);
  assert.equal(result.submitted, true);
  assert.equal(claimed, 1);
  assert.equal(removed, 1);
});

test('a confirmed receipt is returned only after the one-time claim and one Send call', async () => {
  const actions = [];
  const api = {
    windows: {create: async () => ({id: 7, tabs: [{id: 8}]}), remove: async () => {}},
    scripting: {executeScript: async ({args}) => {
      const action = args[0].action;
      actions.push(action);
      if (action === 'open') return [{result: {opened: true}}];
      if (action === 'prepare') return [{result: {prepared: true, priorRows: ['old']}}];
      if (action === 'send') return [{result: {submitted: true}}];
      return [{result: {sent: true, messageId: 'new'}}];
    }}
  };
  const result = await sendGreetingViaChat({
    ownerHandle: 'owner', ownerId: '1', targetHandle: 'recipient', targetId: '2', text: 'test',
    beforeSubmit: async () => { actions.push('claim'); }, api
  });
  assert.deepEqual(actions, ['open', 'prepare', 'claim', 'send', 'receipt']);
  assert.equal(result.ok,true);assert.equal(result.messageId,'new');assert.equal(result.diagnostics.receiptConfirmed,true);assert.equal(result.diagnostics.attemptedSubmit,true);
});

test('legacy conversations use the verified sender only after the claim', async () => {
  const actions = [];
  const api = {
    windows: {create: async () => ({id: 7, tabs: [{id: 8}]}), remove: async () => {}},
    scripting: {executeScript: async ({args}) => {
      const action = args[0].action;
      actions.push(action);
      if (action === 'open') return [{result: {opened: true}}];
      if (action === 'prepare') return [{result: {prepared: true, priorRows: []}}];
      if (action === 'send') return [{result: {submitted: true}}];
      return [{result: {sent: true, messageId: 'legacy-id'}}];
    }}
  };
  const result = await sendGreetingViaChat({
    ownerHandle: 'owner', ownerId: '1', targetHandle: 'recipient', targetId: '2', text: 'test',
    beforeSubmit: async () => { actions.push('claim'); }, api
  });
  assert.deepEqual(actions, ['open', 'prepare', 'claim', 'send', 'receipt']);
  assert.equal(result.ok, true);
});

test('a newly mounted recipient header is not mistaken for a ready encrypted conversation', async () => {
  const oldLocation = globalThis.location;
  const oldDocument = globalThis.document;
  const state = {isLegacy: false, isLegacyOrLoading: false, trustState: null, currentText: '', isReadOnly: false, attachments: {asJsReadonlyArrayView: () => []}};
  const sender = Object.create({send: eval('(function(e,t,n,r,i){return x(this.y,e,t,n,r,i)})')});
  const composer = {state: {state}, sender};
  const input = {value: '', disabled: false, '__reactFiber$test': {memoizedProps: {component: {composer}}}};
  const root = {querySelector: selector => {
    if (selector.includes('password') || selector.includes('one-time-code')) return null;
    if (selector.includes('dm-composer-textarea')) return input;
    return {};
  }, querySelectorAll: () => []};
  globalThis.location = {origin: 'https://x.com', pathname: '/i/chat/1-2'};
  globalThis.document = {querySelector: selector => selector.includes('AppTabBar_Profile_Link') ? {getAttribute: () => '/owner'} : {shadowRoot: root}};
  const args = {ownerHandle: 'owner', ownerId: '1', targetHandle: 'recipient', targetId: '2', text: 'test', action: 'prepare'};
  try {
    assert.deepEqual(await operateGreetingChatOnPage(args), {ready: false, stage: 'trust-state'});
    state.isLegacy = true;
    state.isLegacyOrLoading = true;
    assert.deepEqual(await operateGreetingChatOnPage(args), {prepared: true, priorRows: []});
  } finally {
    globalThis.location = oldLocation;
    globalThis.document = oldDocument;
  }
});


test('X Chat dollar identifiers prepare without sending and submit through the same sender', async () => {
  const oldLocation = globalThis.location;
  const oldDocument = globalThis.document;
  const calls = [];
  const $Pl = (...args) => calls.push(args);
  const sender = Object.create({send: eval('(function(e,t,n,r,i){return $Pl(this.$controller,e,t,n,r,i)})')});
  sender.$controller = {};
  const state = {isLegacy: true, currentText: '', attachments: {asJsReadonlyArrayView: () => []}};
  const composer = {state: {state}, sender};
  const input = {value: '', disabled: false, '__reactFiber$test': {memoizedProps: {component: {composer}}}};
  const root = {querySelector: selector => selector.includes('password') ? null : selector.includes('dm-composer-textarea') ? input : {}, querySelectorAll: () => []};
  globalThis.location = {origin: 'https://x.com', pathname: '/i/chat/1-2'};
  globalThis.document = {querySelector: selector => selector.includes('AppTabBar_Profile_Link') ? {getAttribute: () => '/owner'} : {shadowRoot: root}};
  const args = {ownerHandle: 'owner', ownerId: '1', targetHandle: 'recipient', targetId: '2', text: 'test'};
  try {
    assert.deepEqual(await operateGreetingChatOnPage({...args, action: 'prepare'}), {prepared: true, priorRows: []});
    assert.equal(calls.length, 0);
    assert.deepEqual(await operateGreetingChatOnPage({...args, action: 'send'}), {submitted: true});
    assert.deepEqual(calls, [[sender.$controller, 'test', state.attachments, null, null, null]]);
    input.value = 'existing draft';
    assert.equal((await operateGreetingChatOnPage({...args, action: 'send'})).blocked, true);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.location = oldLocation;
    globalThis.document = oldDocument;
  }
});

test('a conversation with closed inbox or passcode requirement directly returns blocked', async () => {
  const oldLocation = globalThis.location;
  const oldDocument = globalThis.document;
  const root = {
    textContent: '@user 的收件箱已关闭。如果你知道他们的 X 安全码，你仍然可以给他们发私信。暂时不用 使用 X 安全码',
    querySelector: selector => {
      if (selector.includes('dm-conversation-header') || selector.includes('dm-conversation-panel')) return {};
      if (selector.includes('dm-composer-textarea')) return null;
      return null;
    },
    querySelectorAll: () => []
  };
  globalThis.location = {origin: 'https://x.com', pathname: '/i/chat/1-2'};
  globalThis.document = {querySelector: selector => selector.includes('AppTabBar_Profile_Link') ? {getAttribute: () => '/owner'} : {shadowRoot: root}};
  const args = {ownerHandle: 'owner', ownerId: '1', targetHandle: 'recipient', targetId: '2', text: 'test', action: 'prepare'};
  try {
    const res = await operateGreetingChatOnPage(args);
    assert.equal(res.blocked,true);assert.equal(res.reason,'该账号已关闭收件箱，无法私信');assert.equal(res.diagnostics.code,'CHAT_INBOX_CLOSED');
    root.textContent='请输入会话安全码';const passcode=await operateGreetingChatOnPage(args);assert.equal(passcode.diagnostics.code,'CHAT_PASSCODE_REQUIRED');assert.match(passcode.reason,/安全码/);
  } finally {
    globalThis.location = oldLocation;
    globalThis.document = oldDocument;
  }
});

test('unavailable accounts never become due for a greeting', () => {
  const user={status:'pending',followedAt:'2020-01-01T00:00:00Z',followedAtSource:'confirmed'};
  for(const status of ['not_found','suspended']) assert.equal(greetingDue({...user,accountAvailability:{status}},1),false);
  assert.equal(greetingDue({...user,accountAvailability:{status:'ok'}},1),true);
});
