import test from 'node:test';
import assert from 'node:assert/strict';
import {nextTick} from 'vue';
import {cloudflareImagesController} from '../src/entries/panel/composables/useCloudflareImages.js';
import {
  DEFAULT_SETTINGS,
  SETTINGS_BOUNDS,
  STATE_LABELS,
  MODULE_LABELS,
  summarizeQueueSources,
  safeHttpsUrl,
  safeHandleUrl,
  normalizeSettings,
  mountFollowQueuePanel
} from '../src/entries/panel/follow-queue-panel.js';

test('retry refresh prunes stale selections and defers list refresh until the batch finishes', async () => {
  const root=createMockElement('div');
  let jobs=['a','b','c','d'].map(id=>({id,handle:id,state:'retry',sources:[]}));
  let release,reads=0;const calls=[];
  const panel=mountFollowQueuePanel(root,{accountId:'owner',request:async m=>{
    if(m.cmd==='followQueueSettings')return {ok:true,settings:DEFAULT_SETTINGS};
    if(m.cmd==='followQueueList'){reads++;return {ok:true,jobs};}
    if(m.cmd==='followQueueRetryBatch'){calls.push(m);return new Promise(resolve=>release=()=>resolve({ok:true,accepted:[],rejected:[{id:'a',handle:'a',reason:'暂不可重试'}]}));}
    return {ok:true};
  }});
  const wait=()=>new Promise(r=>setTimeout(r,20));
  try {
    await wait();root.querySelectorAll('.fq-filter-tab').find(b=>b.textContent==='等待重试').click();
    root.querySelector('thead input').dispatchEvent({type:'change',target:{checked:true}});
    jobs=jobs.slice(0,1);await panel.refresh();
    assert.match(root.querySelector('.fq-selection-info').textContent,/已选 1 项/);
    root.querySelectorAll('button').find(b=>b.textContent==='批量重试').click();await wait();
    const before=reads;await panel.refresh();assert.equal(reads,before);
    assert.equal(root.querySelector('tbody input').checked,true);
    assert.deepEqual(calls[0].jobIds,['a']);
    release();await wait();assert.equal(reads,before+1);
    assert.match(root.querySelector('.fq-batch-toast').textContent,/暂不可重试/);
    assert.match(root.querySelector('.fq-batch-countdown').textContent,/3 秒后关闭/);
  } finally {panel.destroy();}
});

test('uncertain batch verification is sequential, confirms once and retains failures for retry', async () => {
  const root=createMockElement('div');
  let jobs=['a','b','c'].map(id=>({id,handle:id,state:'uncertain',sources:[]}));
  const calls=[];let release,confirmed=false,confirmations=0;
  const prior=globalThis.confirm;globalThis.confirm=()=>{confirmations++;return confirmed;};
  const request=async m=>{
    if(m.cmd==='followQueueSettings')return {ok:true,settings:DEFAULT_SETTINGS};
    if(m.cmd==='followQueueList')return {ok:true,jobs};
    if(m.cmd==='followQueueVerify'){
      calls.push(m);
      if(m.jobId==='a')await new Promise(resolve=>{release=resolve;});
      if(m.jobId==='b')return {ok:false,error:'无法读取关系'};
      jobs=jobs.map(j=>j.id===m.jobId?{...j,state:'followed'}:j);return {ok:true};
    }
    return {ok:true};
  };
  const delays=[];
  const panel=mountFollowQueuePanel(root,{accountId:'owner',request,batchVerifyWait:async ms=>{
    delays.push(ms);
    assert.ok(root.querySelectorAll('tbody input').every(input=>input.checked), 'selection stays checked between verification requests');
  },batchVerifyRandom:()=>0.5});
  const wait=()=>new Promise(r=>setTimeout(r,20));
  try {
    await wait();root.querySelectorAll('.fq-filter-tab').find(b=>b.textContent==='待核实').click();
    root.querySelector('thead input').dispatchEvent({type:'change',target:{checked:true}});
    const start=()=>root.querySelectorAll('button').find(b=>b.textContent==='批量核对').click();
    start();await wait();assert.equal(calls.length,0);
    confirmed=true;start();await wait();assert.equal(calls.length,1);
    assert.ok(root.querySelector('.fq-filter-tab').disabled);
    assert.match(root.querySelector('.fq-batch-feedback').textContent,/已处理 0\/3/);
    release();await wait();
    assert.deepEqual(calls.map(m=>m.jobId),['a','b','c']);
    assert.deepEqual(delays,[3500,3500]);
    assert.ok(calls.every(m=>m.accountId==='owner'&&m.mode==='check'));
    assert.equal(confirmations,2);
    assert.match(root.querySelector('.fq-batch-feedback').textContent,/成功 2，失败 1/);
    assert.match(root.querySelector('.fq-batch-feedback').textContent,/@b：无法读取关系/);
    assert.match(root.querySelector('.fq-selection-info').textContent,/已选 1 项/);
  } finally {panel.destroy();globalThis.confirm=prior;}
});

test('uncertain bulk exclude and delete reuse single-item commands and stop after the in-flight item', async () => {
  for(const mode of ['exclude','delete']){
    const root=createMockElement('div');let jobs=['a','b'].map(id=>({id,handle:id,state:'uncertain',sources:[]}));
    const calls=[];let release;
    const prior=globalThis.confirm;globalThis.confirm=()=>true;
    const panel=mountFollowQueuePanel(root,{accountId:'owner',request:async m=>{
      if(m.cmd==='followQueueSettings')return {ok:true,settings:DEFAULT_SETTINGS};
      if(m.cmd==='followQueueList')return {ok:true,jobs};
      calls.push(m);await new Promise(r=>{release=r;});jobs=jobs.filter(j=>j.id!==m.jobId);return {ok:true};
    }});
    const wait=()=>new Promise(r=>setTimeout(r,20));
    try{
      await wait();root.querySelectorAll('.fq-filter-tab').find(b=>b.textContent==='待核实').click();
      root.querySelector('thead input').dispatchEvent({type:'change',target:{checked:true}});
      root.querySelectorAll('button').find(b=>b.textContent===(mode==='delete'?'批量删除':'批量排除')).click();
      await wait();root.querySelector('[data-batch-stop="true"]').click();release();await wait();
      assert.equal(calls.length,1);
      assert.equal(calls[0].cmd,mode==='delete'?'followQueueDelete':'followQueueVerify');
      assert.equal(mode==='delete'?calls[0].confirmed:calls[0].mode,mode==='delete'?true:'exclude');
      assert.match(root.querySelector('.fq-batch-feedback').textContent,/已停止：已处理 1\/2/);
      assert.match(root.querySelector('.fq-selection-info').textContent,/已选 1 项/);
    }finally{panel.destroy();globalThis.confirm=prior;}
  }
});

test('Grok settings stay in accessible header help instead of the task summary', async () => {
  const root = createMockElement('div');
  const settings = {...DEFAULT_SETTINGS, grokEnabled:true, publicationMode:'article', quoteParticipationRate:75, quoteLengthMode:'deep', autoPublish:false};
  const panel = mountFollowQueuePanel(root, {accountId:'1485853007346827264', accountHandle:'owner', request:async message => message.cmd === 'followQueueSettings' ? {ok:true, settings} : {ok:true, jobs:[]}});
  try {
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.doesNotMatch(root.querySelector('.fq-summary-bar').textContent, /Grok|发帖形式|创作概率/);
    const status = root.querySelector('.fq-grok-status');
    assert.equal(status.textContent, '');
    assert.equal(status.getAttribute('aria-label'), 'Grok 创作设置');
    assert.equal(status.getAttribute('data-panel-tip'), '自动生成已开启；发帖形式：文章；创作概率：75%；篇幅：深入；自动发布：关闭');
    assert.match(status.className, /is-active/);
    const actions = root.querySelector('.fq-header-actions');
    assert.equal(actions.children.length, 7);
    for (const control of actions.children) {
      assert.equal(control.textContent, '');
      assert.ok(control.querySelector('svg'));
      assert.ok(control.getAttribute('data-panel-tip'));
    }
    const identity = root.querySelector('.fq-account-badge');
    assert.match(identity.getAttribute('data-panel-tip'), /队列执行账号：@owner/);
    assert.match(identity.getAttribute('data-panel-tip'), /任务和设置按此账号隔离/);
    assert.match(identity.getAttribute('data-panel-tip'), /1485853007346827264/);
    assert.equal(identity.getAttribute('tabindex'), '0');
    assert.equal(root.querySelector('.fq-switch-checkbox').getAttribute('aria-label'), '定时调度');
    status.click();
    assert.ok(root.querySelector('.fq-drawer'));
    assert.match(root.querySelector('.fq-drawer').textContent, /评论开关/);
    assert.doesNotMatch(root.querySelector('.fq-drawer').textContent, /仅推荐或互粉账号|Grok 自动创作/);
    assert.equal(root.querySelector('#fq_onlyRecommended'), null);
  } finally { panel.destroy(); }
});

test('evaluation retry displays progress and the returned skip reason instead of silently refreshing',async()=>{
  const prior=globalThis.chrome;let listener,finish;
  globalThis.chrome={runtime:{onMessage:{addListener:fn=>{listener=fn;},removeListener:()=>{listener=null;}}}};
  const root=createMockElement('div');
  const job={id:'retry-feedback',handle:'author',accountId:'owner',state:'followed',sources:[],evaluations:[{taskId:'task',status:'skipped',reasonCode:'quality_skip',reason:'上次内容不足'}]};
  const request=async m=>m.cmd==='followQueueSettings'?{ok:true,settings:DEFAULT_SETTINGS}:m.cmd==='followQueueRetryEvaluation'?new Promise(r=>{finish=r;}):{ok:true,jobs:[job]};
  const panel=mountFollowQueuePanel(root,{accountId:'owner',request});
  try{
    await new Promise(r=>setTimeout(r,15));
    root.querySelectorAll('button').find(b=>b.getAttribute('aria-label')==='重新评估').click();
    assert.match(root.querySelector('.fq-evaluation-feedback').textContent,/正在开始/);
    listener({cmd:'followQueueEvaluationProgress',accountId:'owner',jobId:job.id,label:'正在读取原帖 2…'});
    assert.equal(root.querySelector('.fq-evaluation-feedback').textContent,'正在读取原帖 2…');
    finish({ok:true,summary:'本次内容未达到创作质量要求，未发布'});
    await new Promise(r=>setTimeout(r,15));
    assert.equal(root.querySelector('.fq-evaluation-feedback').textContent,'本次内容未达到创作质量要求，未发布');
  }finally{panel.destroy();globalThis.chrome=prior;}
  assert.equal(listener,null);
});

test('image binding updates the settings entry without recreating unsaved controls',async()=>{
  const c=cloudflareImagesController,refresh=c.refreshStatus,previous=c.connected.value;
  c.refreshStatus=async()=>{c.connected.value=true;};
  const root=createMockElement('div');
  const panel=mountFollowQueuePanel(root,{accountId:'owner',request:async message=>message.cmd==='followQueueSettings'?{ok:true,settings:DEFAULT_SETTINGS}:{ok:true,jobs:[]}});
  try{
    await new Promise(r=>setTimeout(r,15));root.querySelector('[aria-label="关注队列设置"]').click();
    const button=root.querySelector('#fq_cloudflare_connection'),control=root.querySelector('#fq_publicationMode_article');
    assert.match(button.textContent,/已绑定/);
    c.connected.value=false;await nextTick();assert.equal(button.textContent,'连接文章配图服务');
    c.connected.value=true;await nextTick();assert.match(button.textContent,/已绑定/);
    assert.equal(root.querySelector('#fq_publicationMode_article'),control);
  }finally{panel.destroy();c.refreshStatus=refresh;c.connected.value=previous;}
});

test('settings cannot snapshot defaults before the account settings finish loading',async()=>{
  const root=createMockElement('div');let release, saved;
  const loaded={...DEFAULT_SETTINGS,every:15,jitter:5,batchLimit:15,inspectLimit:30,followBackAllowAll:true,quoteTagsEnabled:true};
  const waiting=new Promise(resolve=>{release=resolve;});
  const request=async message=>{
    if(message.cmd==='followQueueSettings')return waiting;
    if(message.cmd==='followQueueSaveSettings'){saved=message.settings;return {ok:true,settings:message.settings};}
    return {ok:true,jobs:[]};
  };
  const panel=mountFollowQueuePanel(root,{request,accountId:'owner'});
  try{
    await new Promise(r=>setTimeout(r,0));
    const initial=root.querySelector('[aria-label="关注队列设置"]');
    assert.equal(initial.disabled,true);initial.click();assert.equal(root.querySelector('.fq-drawer'),null);
    release({ok:true,settings:loaded});await new Promise(r=>setTimeout(r,15));
    const ready=root.querySelector('[aria-label="关注队列设置"]');assert.equal(ready.disabled,false);ready.click();
    root.querySelector('#fq_publicationMode_article').click();
    root.querySelector('.fq-drawer-footer .fq-btn-primary').click();await new Promise(r=>setTimeout(r,15));
    assert.equal(saved.publicationMode,'article');
    for(const key of ['every','jitter','batchLimit','inspectLimit','followBackAllowAll','quoteTagsEnabled'])assert.equal(saved[key],loaded[key]);
  }finally{release({ok:true,settings:loaded});panel.destroy();}
});

test('queue deletion requires confirmation, keeps failed rows and disables running jobs', async () => {
  const root = createMockElement('div');
  let jobs = ['uncertain', 'running'].map((state, index) => ({id:`del-${index}`, handle:`User${index}`, accountId:'owner', state, sources:[], evaluations:[]}));
  let confirmed = false, fail = true;
  const calls = [];
  const prior = globalThis.confirm;
  globalThis.confirm = () => confirmed;
  const request = async message => {
    calls.push(message);
    if (message.cmd === 'followQueueList') return {ok:true, jobs};
    if (message.cmd === 'followQueueSettings') return {ok:true, settings:DEFAULT_SETTINGS};
    if (message.cmd === 'followQueueDelete') {
      if (fail) return {ok:false, reason:'模拟删除失败'};
      jobs = jobs.filter(job => job.id !== message.jobId);
      return {ok:true};
    }
    return {ok:true};
  };
  const panel = mountFollowQueuePanel(root, {request, accountId:'owner'});
  const wait = () => new Promise(resolve => setTimeout(resolve, 15));
  try {
    await wait();
    const buttons = root.querySelectorAll('.fq-delete-job');
    assert.equal(buttons.length, 2);
    assert.equal(buttons[1].disabled, true);
    const actions = root.querySelector('tbody .fq-actions-group');
    assert.match(actions.className, /panel-action-bar/);
    assert.deepEqual(actions.querySelectorAll('button').map(button=>button.getAttribute('aria-label')), ['核对关系','排除','溯源详情','删除']);
    for (const button of actions.querySelectorAll('button')) {
      assert.equal(button.textContent, '');
      assert.ok(button.querySelector('svg'));
      assert.ok(button.getAttribute('data-panel-tip'));
    }
    assert.match(buttons[1].getAttribute('data-panel-tip'), /任务正在执行/);
    buttons[0].click(); await wait();
    assert.equal(calls.some(call=>call.cmd === 'followQueueDelete'), false);
    confirmed = true;
    root.querySelector('.fq-delete-job').click(); await wait();
    assert.equal(jobs.length, 2);
    assert.match(root.textContent, /模拟删除失败/);
    fail = false;
    root.querySelector('.fq-delete-job').click(); await wait();
    assert.equal(jobs.length, 1);
    assert.equal(root.querySelectorAll('.fq-delete-job').length, 1);
    assert.ok(calls.some(call=>call.cmd === 'followQueueDelete' && call.confirmed && call.accountId === 'owner'));
  } finally { panel.destroy(); globalThis.confirm = prior; }
});

test('automatic schedule switch enables scheduling when toggled on', async () => {
  const root=createMockElement('div'), calls=[];
  const request=async payload=>{
    calls.push(payload);
    if(payload.cmd==='followQueueList') return {ok:true,jobs:[],summary:{isPaused:true}};
    if(payload.cmd==='followQueueSettings') return {ok:true,settings:{...DEFAULT_SETTINGS, enabled:false}};
    return {ok:true};
  };
  const panel=mountFollowQueuePanel(root,{request,accountId:'123'});
  await new Promise(r=>setTimeout(r,15));
  const toggle = root.querySelector('.fq-switch-checkbox');
  assert.ok(toggle);
  toggle.checked = true;
  toggle.dispatchEvent({type: 'change', target: {checked: true}});
  await new Promise(r=>setTimeout(r,15));
  assert.ok(calls.some(call=>call.cmd==='followQueueSaveSettings' && call.settings.enabled===true));
  assert.equal(calls.some(call=>call.cmd==='followQueuePause'),false);
  panel.destroy();
});

// --- Minimal Mock DOM Environment ---

function createMockElement(tagName) {
  const listeners = new Map();
  const attributes = new Map();
  const children = [];
  const classListSet = new Set();

  const element = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    id: '',
    dataset: {},
    style: {},
    disabled: false,
    checked: false,
    indeterminate: false,
    value: '',
    type: '',
    min: '',
    max: '',
    step: '',
    placeholder: '',
    parentNode: null,

    get children() {
      return children.filter(c => c && c.nodeType === 1);
    },
    get childNodes() {
      return [...children];
    },

    get className() {
      return Array.from(classListSet).join(' ');
    },
    set className(val) {
      classListSet.clear();
      if (val) {
        val.split(/\s+/).filter(Boolean).forEach(cls => classListSet.add(cls));
      }
    },

    classList: {
      add(...classes) {
        classes.forEach(cls => classListSet.add(cls));
      },
      remove(...classes) {
        classes.forEach(cls => classListSet.delete(cls));
      },
      contains(cls) {
        return classListSet.has(cls);
      },
      toggle(cls, force) {
        if (force === true) classListSet.add(cls);
        else if (force === false) classListSet.delete(cls);
        else if (classListSet.has(cls)) classListSet.delete(cls);
        else classListSet.add(cls);
      }
    },

    get textContent() {
      return children.map(c => c.textContent || '').join('');
    },
    set textContent(val) {
      children.length = 0;
      if (val !== '') {
        children.push(createMockTextNode(String(val)));
      }
    },

    appendChild(child) {
      if (child.parentNode) {
        const idx = child.parentNode.childNodes.indexOf(child);
        if (idx !== -1) child.parentNode.childNodes.splice(idx, 1);
      }
      child.parentNode = element;
      children.push(child);
      return child;
    },

    replaceChildren(...newChildren) {
      children.forEach(c => { c.parentNode = null; });
      children.length = 0;
      for (const child of newChildren) {
        if (!child) continue;
        child.parentNode = element;
        children.push(child);
      }
    },

    setAttribute(name, value) {
      attributes.set(name, String(value));
      if (name === 'id') element.id = String(value);
      if (name === 'type') element.type = String(value);
      if (name === 'class') element.className = String(value);
      if (name === 'value') element.value = String(value);
      if (name === 'checked') element.checked = true;
      if (name === 'disabled') element.disabled = true;
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    removeAttribute(name) {
      attributes.delete(name);
      if (name === 'checked') element.checked = false;
      if (name === 'disabled') element.disabled = false;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },

    addEventListener(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
    },
    removeEventListener(event, listener) {
      if (!listeners.has(event)) return;
      const list = listeners.get(event).filter(l => l !== listener);
      listeners.set(event, list);
    },
    dispatchEvent(event) {
      const type = event.type || event;
      const list = listeners.get(type) || [];
      const ev = typeof event === 'object' ? event : { type };
      ev.target = ev.target || element;
      ev.currentTarget = element;
      for (const listener of list) {
        listener.call(element, ev);
      }
    },
    click() {
      element.dispatchEvent({ type: 'click', target: element, currentTarget: element });
    },

    querySelector(selector) {
      return findSelector(element, selector, false);
    },
    querySelectorAll(selector) {
      const results = [];
      findSelector(element, selector, true, results);
      return results;
    }
  };

  return element;
}

function createMockTextNode(text) {
  return {
    nodeType: 3,
    textContent: String(text),
    parentNode: null
  };
}

function matchesSelector(el, selector) {
  if (!el || el.nodeType !== 1) return false;
  const parts = selector.trim().split(/\s+/);
  if (parts.length > 1) {
    // descendant selector not handled here; handled recursively in findSelector
    return false;
  }
  const s = parts[0];

  // Attribute selector [attr="val"] or [attr]
  const attrMatch = s.match(/^([a-zA-Z0-9_-]*)\[([a-zA-Z0-9_-]+)(?:=["']?([^"']*)["']?)?\]$/);
  if (attrMatch) {
    const [, tag, attr, val] = attrMatch;
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    if (val !== undefined) {
      if (attr === 'type' && el.type === val) return true;
      if (attr === 'value' && el.value === val) return true;
      return el.getAttribute(attr) === val;
    }
    return el.hasAttribute(attr);
  }

  // ID selector #id or tag#id
  if (s.startsWith('#')) {
    const id = s.slice(1);
    return el.id === id || el.getAttribute('id') === id;
  }
  if (s.includes('#')) {
    const [tag, id] = s.split('#');
    return el.tagName === tag.toUpperCase() && (el.id === id || el.getAttribute('id') === id);
  }

  // Class selector .cls or tag.cls
  if (s.startsWith('.')) {
    return el.classList.contains(s.slice(1));
  }
  if (s.includes('.')) {
    const [tag, cls] = s.split('.');
    return el.tagName === tag.toUpperCase() && el.classList.contains(cls);
  }

  // Tag name
  return el.tagName === s.toUpperCase();
}

function findSelector(root, selector, multiple = false, results = []) {
  const parts = selector.trim().split(/\s+/);
  if (parts.length === 1) {
    for (const child of root.children) {
      if (matchesSelector(child, parts[0])) {
        if (!multiple) return child;
        results.push(child);
      }
      const found = findSelector(child, parts[0], multiple, results);
      if (!multiple && found) return found;
    }
    return multiple ? results : null;
  }

  // Multi-part descendant selector, e.g. "table tbody tr"
  const [first, ...rest] = parts;
  const restSelector = rest.join(' ');
  for (const child of root.children) {
    if (matchesSelector(child, first)) {
      const sub = findSelector(child, restSelector, multiple, results);
      if (!multiple && sub) return sub;
    } else {
      const sub = findSelector(child, selector, multiple, results);
      if (!multiple && sub) return sub;
    }
  }
  return multiple ? results : null;
}

// Setup global mock DOM
function setupDOM() {
  const docListeners = new Map();
  globalThis.document = {
    createElement(tag) { return createMockElement(tag); },
    createElementNS(namespace, tag) { return createMockElement(tag); },
    createTextNode(text) { return createMockTextNode(text); },
    addEventListener(event, listener) {
      if (!docListeners.has(event)) docListeners.set(event, []);
      docListeners.get(event).push(listener);
    },
    removeEventListener(event, listener) {
      if (!docListeners.has(event)) return;
      docListeners.set(event, docListeners.get(event).filter(l => l !== listener));
    },
    dispatchEvent(event) {
      const list = docListeners.get(event.type || event) || [];
      for (const fn of list) fn(event);
    }
  };
}

setupDOM();

// --- Test Suites ---

test('normalizeSettings returns contract defaults when raw is empty or missing', () => {
  const settings = normalizeSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.every, 8);
  assert.equal(settings.jitter, 2);
  assert.equal(settings.batchLimit, 5);
  assert.equal(settings.inspectLimit, 20);
  assert.equal(settings.timeBudgetMinutes, 10);
  assert.equal(settings.scrollRounds, 5);
  assert.equal(settings.dwellSeconds, 15);
  assert.equal(settings.dwellJitter, 5);
  assert.equal(settings.minFollowers, 50);
  assert.equal(settings.ratioThreshold, 0.8);
  assert.equal('onlyRecommended' in settings, false);
  assert.equal(settings.grokEnabled, false);
  assert.equal(settings.autoPublish, false);
  assert.equal(settings.publicationMode, 'quote');
  assert.equal(settings.quoteParticipationRate, 60);
  assert.equal(settings.quoteLengthMode, 'adaptive');
});

test('normalizeSettings clamps out-of-bounds numeric values and respects bounds', () => {
  const clamped = normalizeSettings({
    every: 5000, // max 240
    jitter: -10, // min 1
    batchLimit: 999, // max 50
    inspectLimit: 0, // min 1
    timeBudgetMinutes: 500, // max 120
    scrollRounds: 50, // max 8
    dwellSeconds: 1, // min 2
    dwellJitter: 100, // max 30
    minFollowers: -5, // min 0
    ratioThreshold: 3.5, // max 1.0
    onlyRecommended: false,
    grokEnabled: true,
    autoPublish: true,
    enabled: true
  });

  assert.equal(clamped.every, 240);
  assert.equal(clamped.jitter, 1);
  assert.equal(clamped.batchLimit, 50);
  assert.equal(clamped.inspectLimit, 1);
  assert.equal(clamped.timeBudgetMinutes, 120);
  assert.equal(clamped.scrollRounds, 8);
  assert.equal(clamped.dwellSeconds, 2);
  assert.equal(clamped.dwellJitter, 30);
  assert.equal(clamped.minFollowers, 0);
  assert.equal(clamped.ratioThreshold, 1.0);
  assert.equal('onlyRecommended' in clamped, false);
  assert.equal(clamped.grokEnabled, true);
  assert.equal(clamped.autoPublish, true);
  assert.equal(clamped.enabled, true);
});

test('mountFollowQueuePanel renders missing account warning when accountId is missing', async () => {
  const root = createMockElement('div');
  const requests = [];
  const request = async payload => {
    requests.push(payload);
    return { ok: true, jobs: [] };
  };

  const handle = mountFollowQueuePanel(root, { request, accountId: '' });
  // Missing account should not dispatch followQueueList
  assert.equal(requests.length, 0);

  const alertBox = root.querySelector('.fq-alert-warning');
  assert.ok(alertBox);
  assert.ok(alertBox.textContent.includes('未检测到有效 X 账号'));

  handle.destroy();
  assert.equal(root.childNodes.length, 0);
});

test('mountFollowQueuePanel loads list and renders jobs with status badges and source tags', async () => {
  const root = createMockElement('div');
  const mockJobs = [
    {
      id: 'job-1',
      accountId: 'WatsonTaylor23',
      targetUserId: '123456789',
      handle: 'TargetUserOne',
      sources: [
        { module: 'fans', url: 'https://x.com/WatsonTaylor23/followers', enabled: true, discoveredAt: 1729170000000 },
        { module: 'mutual', url: 'https://x.com/anchor/following', enabled: false, discoveredAt: 1729171000000 }
      ],
      state: 'followed',
      stage: 'completed',
      createdAt: 1729170000000,
      updatedAt: 1729172000000,
      nextEligibleAt: null,
      lease: null,
      followResult: { following: true },
      evaluations: [
        {
          taskId: 'eval-101',
          followJobId: 'job-1',
          targetUserId: '123456789',
          originalAuthorId: '123456789',
          originalPostId: '987654321',
          originalPostUrl: 'https://x.com/TargetUserOne/status/987654321',
          text: '很深刻的观点，值得思考。有关必回',
          status: 'published',
          publishedPostId: '1122334455',
          publishedPostUrl: 'https://x.com/WatsonTaylor23/status/1122334455',
          attempts: 1
        }
      ]
    },
    {
      id: 'job-2',
      accountId: 'WatsonTaylor23',
      targetUserId: '987654321',
      handle: 'TargetUserTwo',
      sources: [{ module: 'comments', url: 'https://x.com/post/123', enabled: true, discoveredAt: 1729172000000 }],
      state: 'pending',
      stage: 'waiting_lease',
      createdAt: 1729172000000,
      updatedAt: 1729172000000,
      followResult: null,
      evaluations: []
    }
  ];

  const request = async ({ cmd, accountId }) => {
    if (cmd === 'followQueueList') {
      return { ok: true, jobs: mockJobs, summary: { stats: { total: 2, pending: 1, followed: 1, running: 0, skipped: 0, retry: 0, uncertain: 0, excluded: 0 } } };
    }
    if (cmd === 'followQueueSettings') {
      return { ok: true, settings: { ...DEFAULT_SETTINGS, autoPublish: true } };
    }
    return { ok: true };
  };

  const handle = mountFollowQueuePanel(root, { request, accountId: 'WatsonTaylor23' });
  await new Promise(r => setTimeout(r, 10));

  // Verify header account info
  const accountBadge = root.querySelector('.fq-account-badge');
  assert.ok(accountBadge);
  assert.equal(accountBadge.textContent, '');
  assert.ok(accountBadge.getAttribute('data-panel-tip').includes('WatsonTaylor23'));

  // Verify rendered rows
  const rows = root.querySelectorAll('tbody tr');
  assert.equal(rows.length, 2);

  // Check row 1 handle and badges
  assert.ok(rows[0].textContent.includes('@TargetUserOne'));
  assert.ok(rows[0].textContent.includes('粉丝跟进'));
  assert.ok(rows[0].textContent.includes('互关追踪'));
  assert.ok(rows[0].textContent.includes('已关注'));
  assert.ok(rows[0].textContent.includes('已发布帖子'));

  // Check row 2 handle and badges
  assert.ok(rows[1].textContent.includes('@TargetUserTwo'));
  assert.ok(rows[1].textContent.includes('评论追踪'));
  assert.ok(rows[1].textContent.includes('待关注'));
  assert.ok(rows[1].textContent.includes('无评价'));

  handle.destroy();
});

test('source column shows one module tag while trace keeps every discovery record', async () => {
  const sources = [
    {module:'fans',url:'https://x.com/target',enabled:true,discoveredAt:1},
    {module:'fans',url:'',enabled:true,discoveredAt:2},
    {module:'comments',url:'https://x.com/author/status/1',enabled:true,discoveredAt:3},
    {module:'comments',url:'https://x.com/author/status/2',enabled:true,discoveredAt:4},
    {module:'mutual',url:'https://x.com/anchor/followers',enabled:true,discoveredAt:5}
  ];
  assert.deepEqual(summarizeQueueSources(sources).map(group => [group.module, group.count, group.url]), [
    ['fans', 2, 'https://x.com/target'],
    ['comments', 2, null],
    ['mutual', 1, 'https://x.com/anchor/followers']
  ]);
  const root = createMockElement('div');
  const job = {id:'multi-source',accountId:'WatsonTaylor23',targetUserId:'123',handle:'target',sources,state:'pending',stage:'queued',createdAt:1,updatedAt:2,evaluations:[]};
  const request = async ({cmd}) => cmd === 'followQueueList'
    ? {ok:true,jobs:[job]}
    : {ok:true,settings:{...DEFAULT_SETTINGS}};
  const mounted = mountFollowQueuePanel(root,{request,accountId:'WatsonTaylor23'});
  await new Promise(resolve => setTimeout(resolve, 15));
  const row = root.querySelector('tbody tr');
  const sourceCell = row.querySelector('.fq-col-sources');
  assert.deepEqual(sourceCell.querySelectorAll('.fq-tag').map(tag => tag.textContent), ['粉丝跟进','评论追踪','互关追踪']);
  assert.equal(sourceCell.querySelectorAll('.fq-source-link').length, 2);
  row.querySelector('.fq-col-actions button').click();
  const trace = root.querySelector('.fq-drawer');
  assert.ok(trace.textContent.includes('候选来源记录 (5)'));
  assert.ok(trace.textContent.includes('https://x.com/author/status/1'));
  assert.ok(trace.textContent.includes('https://x.com/author/status/2'));
  mounted.destroy();
});

test('mountFollowQueuePanel renders untrusted strings safely without HTML interpretation', async () => {
  const root = createMockElement('div');
  const untrustedHandle = '<script>alert("xss")</script>';
  const untrustedId = '<img src=x onerror=alert(1)>';
  const mockJobs = [
    {
      id: 'job-xss',
      accountId: 'WatsonTaylor23',
      targetUserId: untrustedId,
      handle: untrustedHandle,
      sources: [{ module: 'fans', url: 'https://x.com/fake', enabled: true }],
      state: 'pending',
      followResult: null,
      evaluations: []
    }
  ];

  const request = async () => ({ ok: true, jobs: mockJobs });
  const handle = mountFollowQueuePanel(root, { request, accountId: 'WatsonTaylor23' });
  await new Promise(r => setTimeout(r, 10));

  const rows = root.querySelectorAll('tbody tr');
  assert.equal(rows.length, 1);
  // Verify the text contains the raw string safely via textContent
  assert.ok(rows[0].textContent.includes('<script>alert("xss")</script>'));
  assert.ok(rows[0].textContent.includes('<img src=x onerror=alert(1)>'));

  handle.destroy();
});

test('stable selection across page size changes and pagination', async () => {
  const root = createMockElement('div');
  const mockJobs = Array.from({ length: 25 }, (_, i) => ({
    id: `job-${i + 1}`,
    accountId: 'WatsonTaylor23',
    targetUserId: `uid-${i + 1}`,
    handle: `User${i + 1}`,
    sources: [{ module: 'fans', enabled: true }],
    state: 'pending',
    followResult: null,
    evaluations: []
  }));

  const request = async () => ({ ok: true, jobs: mockJobs });
  const handle = mountFollowQueuePanel(root, { request, accountId: 'WatsonTaylor23' });
  await new Promise(r => setTimeout(r, 10));

  // Default page size is 20 -> 20 rows visible
  let rows = root.querySelectorAll('tbody tr');
  assert.equal(rows.length, 20);

  // Select job-1 and job-2
  const checkboxes = root.querySelectorAll('tbody tr input[type="checkbox"]');
  checkboxes[0].checked = true;
  checkboxes[0].dispatchEvent({ type: 'change', target: { checked: true } });
  checkboxes[1].checked = true;
  checkboxes[1].dispatchEvent({ type: 'change', target: { checked: true } });

  // Verify selection summary
  const selectionInfo = root.querySelector('.fq-selection-info');
  assert.ok(selectionInfo);
  assert.ok(selectionInfo.textContent.includes('已选 2 项'));

  // Change page size to 10
  const pageSizeSelect = root.querySelector('.fq-pagesize-select');
  pageSizeSelect.value = '10';
  pageSizeSelect.dispatchEvent({ type: 'change', target: { value: '10' } });

  // Rows should now be 10, but selection count MUST still be 2
  rows = root.querySelectorAll('tbody tr');
  assert.equal(rows.length, 10);
  const updatedSelection = root.querySelector('.fq-selection-info');
  assert.ok(updatedSelection);
  assert.ok(updatedSelection.textContent.includes('已选 2 项'));

  // Checkboxes on page 1 for job-1 and job-2 must still be checked
  const newCheckboxes = root.querySelectorAll('tbody tr input[type="checkbox"]');
  assert.equal(newCheckboxes[0].checked, true);
  assert.equal(newCheckboxes[1].checked, true);

  handle.destroy();
});

test('traceability drawer opens with complete chain and closes cleanly', async () => {
  const root = createMockElement('div');
  const mockJob = {
    id: 'job-trace-1',
    accountId: 'WatsonTaylor23',
    targetUserId: '55667788',
    handle: 'TraceCandidate',
    sources: [
      { module: 'mutual', url: 'https://x.com/anchor/followers', enabled: true, discoveredAt: 1729170000000 }
    ],
    state: 'skipped',
    stage: 'profile_evaluated',
    createdAt: 1729170000000,
    updatedAt: 1729171000000,
    nextEligibleAt: null,
    lease: { owner: 'worker-a', version: 1 },
    followResult: { reason: '回关比率偏低 (12/4938)' },
    evaluations: [
      {
        taskId: 'eval-trace-1',
        followJobId: 'job-trace-1',
        targetUserId: '55667788',
        originalAuthorId: '55667788',
        originalPostId: 'post-111',
        originalPostUrl: 'https://x.com/TraceCandidate/status/post-111',
        text: '这是一段测试引用草稿',
        status: 'drafted',
        publishedPostId: null,
        publishedPostUrl: null,
        attempts: 1
      }
    ]
  };

  const request = async () => ({ ok: true, jobs: [mockJob] });
  const handle = mountFollowQueuePanel(root, { request, accountId: 'WatsonTaylor23' });
  await new Promise(r => setTimeout(r, 10));

  // No drawer initially
  assert.equal(root.querySelector('.fq-drawer'), null);

  // Click "溯源详情" button
  const traceBtn = root.querySelector('.fq-col-actions button');
  assert.ok(traceBtn);
  traceBtn.click();

  // Drawer should now be visible
  const drawer = root.querySelector('.fq-drawer');
  assert.ok(drawer);
  assert.ok(drawer.textContent.includes('关注任务溯源 · @TraceCandidate'));
  assert.ok(drawer.textContent.includes('目标 Rest ID:'));
  assert.ok(drawer.textContent.includes('55667788'));
  assert.ok(drawer.textContent.includes('互关追踪'));
  assert.ok(drawer.textContent.includes('回关比率偏低'));
  assert.ok(drawer.textContent.includes('这是一段测试引用草稿'));

  // Close drawer via close button
  const closeBtn = drawer.querySelector('.panel-close-button');
  assert.ok(closeBtn);
  assert.equal(closeBtn.getAttribute('aria-label'), '关闭');
  closeBtn.click();

  assert.equal(root.querySelector('.fq-drawer'), null);
  handle.destroy();
});

test('settings drawer opens, reflects contract defaults, and saves clamped settings', async () => {
  const root = createMockElement('div');
  let savedSettings = null;

  const request = async payload => {
    if (payload.cmd === 'followQueueList') return { ok: true, jobs: [] };
    if (payload.cmd === 'followQueueSettings') return { ok: true, settings: { ...DEFAULT_SETTINGS } };
    if (payload.cmd === 'followQueueSaveSettings') {
      savedSettings = payload.settings;
      return { ok: true, settings: payload.settings };
    }
    return { ok: true };
  };

  const handle = mountFollowQueuePanel(root, { request, accountId: 'WatsonTaylor23' });
  await new Promise(r => setTimeout(r, 10));

  // Open settings drawer
  const settingsBtn = root.querySelector('.fq-header-actions button[aria-label="关注队列设置"]');
  assert.ok(settingsBtn);
  settingsBtn.click();

  const drawer = root.querySelector('.fq-drawer');
  assert.ok(drawer);
  assert.ok(drawer.textContent.includes('关注队列设置'));

  // Verify contract default fields exist
  const batchInput = drawer.querySelector('#fq_batchLimit');
  assert.ok(batchInput);
  assert.equal(batchInput.value, '5');

  const ratioInput = drawer.querySelector('#fq_ratioThreshold');
  assert.ok(ratioInput);
  assert.equal(ratioInput.value, '0.8');

  const autoPublishSwitch = drawer.querySelector('#fq_autoPublish');
  assert.ok(autoPublishSwitch);
  assert.equal(autoPublishSwitch.checked, false);
  const followBackSuffix = drawer.querySelector('#fq_followBackSuffixEnabled');
  assert.ok(followBackSuffix);assert.equal(followBackSuffix.checked,false);
  followBackSuffix.checked=true;followBackSuffix.dispatchEvent({type:'change',target:{checked:true}});
  const fanBypass = drawer.querySelector('#fq_followBackAllowAll');
  assert.ok(fanBypass);
  assert.equal(fanBypass.checked, false);
  fanBypass.checked = true;
  fanBypass.dispatchEvent({type:'change',target:{checked:true}});
  const blueOnly = drawer.querySelector('#fq_blueVerifiedOnly');
  assert.ok(blueOnly);
  assert.equal(blueOnly.checked, false);
  blueOnly.checked = true;
  blueOnly.dispatchEvent({type:'change',target:{checked:true}});

  // Edit fields
  batchInput.value = '10';
  batchInput.dispatchEvent({ type: 'input', target: { value: '10' } });

  autoPublishSwitch.checked = true;
  autoPublishSwitch.dispatchEvent({ type: 'change', target: { checked: true } });

  // Click "保存配置"
  const saveBtn = drawer.querySelector('.fq-drawer-footer .fq-btn-primary');
  assert.ok(saveBtn);
  saveBtn.click();
  await new Promise(r => setTimeout(r, 10));

  assert.ok(savedSettings);
  assert.equal(savedSettings.batchLimit, 10);
  assert.equal(savedSettings.autoPublish, true);
  assert.equal(savedSettings.followBackSuffixEnabled, true);
  assert.equal(savedSettings.followBackAllowAll, true);
  assert.equal(savedSettings.blueVerifiedOnly, true);
  assert.equal(savedSettings.enabled, false);
  root.querySelector('.fq-header-actions button[aria-label="关注队列设置"]').click();
  assert.equal(root.querySelector('#fq_followBackSuffixEnabled').checked,true);
  assert.equal(root.querySelector('#fq_blueVerifiedOnly').checked,true);

  handle.destroy();
});

test('manual actions run, pause, and refresh dispatch expected commands', async () => {
  const root = createMockElement('div');
  const commands = [];

  const request = async payload => {
    commands.push(payload.cmd);
    if (payload.cmd === 'followQueueList') return { ok: true, jobs: [] };
    if (payload.cmd === 'followQueueSettings') return { ok: true, settings: { ...DEFAULT_SETTINGS } };
    if (payload.cmd === 'followQueueRun') return { ok: true, summary: { lastRunAt: Date.now() } };
    if (payload.cmd === 'followQueuePause') return { ok: true, summary: { isPaused: true } };
    return { ok: true };
  };

  const handle = mountFollowQueuePanel(root, { request, accountId: 'WatsonTaylor23' });
  await new Promise(r => setTimeout(r, 10));

  // Run Now button
  const runBtn = root.querySelector('.fq-header-actions .fq-btn-primary');
  assert.ok(runBtn);
  runBtn.click();
  await new Promise(r => setTimeout(r, 10));
  assert.ok(commands.includes('followQueueRun'));

  // Pause / disable scheduling via toggle switch
  const switchCheckbox = root.querySelector('.fq-switch-checkbox');
  assert.ok(switchCheckbox);
  switchCheckbox.checked = false;
  switchCheckbox.dispatchEvent({ type: 'change', target: { checked: false } });
  await new Promise(r => setTimeout(r, 10));
  assert.ok(commands.includes('followQueuePause'));

  // Refresh
  await handle.refresh();
  assert.ok(commands.filter(c => c === 'followQueueList').length >= 3);

  handle.destroy();
});

test('stale async responses are safely ignored when newer request is active', async () => {
  const root = createMockElement('div');
  let slowResolve;

  const request = async payload => {
    if (payload.cmd === 'followQueueList') {
      if (!slowResolve) {
        return new Promise(resolve => {
          slowResolve = resolve;
        });
      }
      return { ok: true, jobs: [{ id: 'job-fast', handle: 'FastUser', state: 'pending' }] };
    }
    return { ok: true };
  };

  const handle = mountFollowQueuePanel(root, { request, accountId: 'WatsonTaylor23' });

  // Trigger a second, faster refresh before the first one completes
  await handle.refresh();

  // Fast response has arrived
  let rows = root.querySelectorAll('tbody tr');
  assert.equal(rows.length, 1);
  assert.ok(rows[0].textContent.includes('@FastUser'));

  // Now the slow response resolves with stale data
  slowResolve({ ok: true, jobs: [{ id: 'job-slow', handle: 'SlowUser', state: 'pending' }] });
  await new Promise(r => setTimeout(r, 10));

  // Table must still show FastUser and ignore the stale SlowUser response!
  rows = root.querySelectorAll('tbody tr');
  assert.equal(rows.length, 1);
  assert.ok(rows[0].textContent.includes('@FastUser'));

  handle.destroy();
});

test('SETTINGS_BOUNDS and normalizeSettings match store bounds and clamp jitter to every', () => {
  assert.equal(SETTINGS_BOUNDS.every.min, 1);
  assert.equal(SETTINGS_BOUNDS.every.max, 240);
  assert.equal(SETTINGS_BOUNDS.jitter.min, 1);
  assert.equal(SETTINGS_BOUNDS.jitter.max, 120);
  assert.equal(SETTINGS_BOUNDS.batchLimit.min, 1);
  assert.equal(SETTINGS_BOUNDS.batchLimit.max, 50);
  assert.equal(SETTINGS_BOUNDS.inspectLimit.min, 1);
  assert.equal(SETTINGS_BOUNDS.inspectLimit.max, 200);
  assert.equal(SETTINGS_BOUNDS.timeBudgetMinutes.min, 1);
  assert.equal(SETTINGS_BOUNDS.timeBudgetMinutes.max, 120);
  assert.equal(SETTINGS_BOUNDS.scrollRounds.min, 1);
  assert.equal(SETTINGS_BOUNDS.scrollRounds.max, 8);
  assert.equal(SETTINGS_BOUNDS.dwellSeconds.min, 2);
  assert.equal(SETTINGS_BOUNDS.dwellSeconds.max, 60);
  assert.equal(SETTINGS_BOUNDS.dwellJitter.min, 1);
  assert.equal(SETTINGS_BOUNDS.dwellJitter.max, 30);
  assert.equal(SETTINGS_BOUNDS.minFollowers.min, 0);
  assert.equal(SETTINGS_BOUNDS.minFollowers.max, 100_000_000);
  assert.equal(SETTINGS_BOUNDS.ratioThreshold.min, 0);
  assert.equal(SETTINGS_BOUNDS.ratioThreshold.max, 1.0);

  // When jitter > every, jitter must clamp to every
  const normalized = normalizeSettings({ every: 5, jitter: 15 });
  assert.equal(normalized.every, 5);
  assert.equal(normalized.jitter, 5);
});

test('safeHttpsUrl and safeHandleUrl validate URLs and encode handle path', () => {
  // safeHttpsUrl
  assert.equal(safeHttpsUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpsUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(safeHttpsUrl('http://insecure.example.com'), null);
  assert.equal(safeHttpsUrl('ftp://example.com/file'), null);
  assert.equal(safeHttpsUrl('not-a-url'), null);
  assert.equal(safeHttpsUrl(''), null);
  assert.equal(safeHttpsUrl(null), null);
  assert.equal(safeHttpsUrl('https://x.com/test_user'), 'https://x.com/test_user');
  assert.equal(safeHttpsUrl('  https://x.com/with_spaces  '), 'https://x.com/with_spaces');

  // safeHandleUrl
  assert.equal(safeHandleUrl('valid_user'), 'https://x.com/valid_user');
  assert.equal(safeHandleUrl('@valid_user'), 'https://x.com/valid_user');
  assert.equal(safeHandleUrl('evil/path?param=1#hash'), 'https://x.com/evil%2Fpath%3Fparam%3D1%23hash');
  assert.equal(safeHandleUrl(''), null);
  assert.equal(safeHandleUrl('@'), null);
  assert.equal(safeHandleUrl(null), null);
});

test('mountFollowQueuePanel rejects javascript, data, and http links and never renders them clickable', async () => {
  const root = createMockElement('div');
  const mockJob = {
    id: 'job-sec-1',
    accountId: 'WatsonTaylor23',
    targetUserId: '10001',
    handle: 'attack/user?query=1',
    sources: [
      { module: 'fans', url: 'javascript:alert(document.cookie)', enabled: true },
      { module: 'mutual', url: 'https://x.com/safe/mutual', enabled: true }
    ],
    state: 'pending',
    stage: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    evaluations: [
      {
        taskId: 'eval-sec-1',
        originalPostUrl: 'data:text/html,<script>alert(1)</script>',
        publishedPostUrl: 'http://insecure-post.com/status/123',
        status: 'drafted'
      }
    ]
  };

  const request = async payload => {
    if (payload.cmd === 'followQueueList') return { ok: true, jobs: [mockJob] };
    if (payload.cmd === 'followQueueSettings') return { ok: true, settings: { ...DEFAULT_SETTINGS } };
    return { ok: true };
  };

  const handle = mountFollowQueuePanel(root, { request, accountId: 'WatsonTaylor23' });
  await new Promise(r => setTimeout(r, 15));

  // Verify target handle link is properly URL-encoded
  const handleLink = root.querySelector('.fq-user-handle');
  assert.equal(handleLink.tagName, 'A');
  assert.equal(handleLink.getAttribute('href'), 'https://x.com/attack%2Fuser%3Fquery%3D1');

  // Verify source links: javascript: url must NOT be an <a> link!
  const allAnchors = root.querySelectorAll('a');
  for (const a of allAnchors) {
    const href = a.getAttribute('href') || '';
    assert.ok(!href.startsWith('javascript:'), `Unsafe javascript link rendered clickable: ${href}`);
    assert.ok(!href.startsWith('data:'), `Unsafe data link rendered clickable: ${href}`);
    assert.ok(!href.startsWith('http://'), `Unsafe http link rendered clickable: ${href}`);
    assert.ok(href.startsWith('https://'), `External link must start with https://: ${href}`);
  }

  // Check the safe source link exists
  const safeSourceLink = root.querySelector('.fq-source-link');
  assert.ok(safeSourceLink);
  assert.equal(safeSourceLink.getAttribute('href'), 'https://x.com/safe/mutual');

  // Check unsafe evals rendered as non-clickable span
  const evalCell = root.querySelector('.fq-col-eval');
  assert.ok(evalCell);
  assert.equal(evalCell.querySelectorAll('a').length, 0); // No clickable links for data: or http://

  // Open traceability drawer
  const traceBtn = root.querySelector('.fq-col-actions button');
  traceBtn.click();

  const drawer = root.querySelector('.fq-drawer');
  assert.ok(drawer);

  // Verify all anchors in drawer are strictly safe
  const drawerAnchors = drawer.querySelectorAll('a');
  for (const a of drawerAnchors) {
    const href = a.getAttribute('href') || '';
    assert.ok(!href.startsWith('javascript:'), `Drawer contains javascript href: ${href}`);
    assert.ok(!href.startsWith('data:'), `Drawer contains data href: ${href}`);
    assert.ok(!href.startsWith('http://'), `Drawer contains http href: ${href}`);
    assert.ok(href.startsWith('https://'), `Drawer link must be https: ${href}`);
  }

  handle.destroy();
});

test('run and pause handlers surface res.ok:false errors and do not erase them with fetchAll', async () => {
  const root = createMockElement('div');
  let listFetchCount = 0;

  const request = async payload => {
    if (payload.cmd === 'followQueueList') {
      listFetchCount++;
      return { ok: true, jobs: [] };
    }
    if (payload.cmd === 'followQueueSettings') return { ok: true, settings: { ...DEFAULT_SETTINGS } };
    if (payload.cmd === 'followQueueRun') {
      return { ok: false, error: '调度器互斥锁冲突，请稍后' };
    }
    if (payload.cmd === 'followQueuePause') {
      return { ok: false, error: '权限不足，无法切换暂停' };
    }
    return { ok: true };
  };

  const handle = mountFollowQueuePanel(root, { request, accountId: 'WatsonTaylor23' });
  await new Promise(r => setTimeout(r, 15));
  assert.equal(listFetchCount, 1);

  // Trigger Run Now which fails
  const runBtn = root.querySelector('.fq-header-actions .fq-btn-primary');
  runBtn.click();
  await new Promise(r => setTimeout(r, 15));

  // Error must be surfaced in .fq-alert-error
  const runAlert = root.querySelector('.fq-alert-error');
  assert.ok(runAlert);
  assert.ok(runAlert.textContent.includes('调度器互斥锁冲突，请稍后'));

  // fetchAll must NOT have been called to erase the error!
  assert.equal(listFetchCount, 1);

  // Trigger Pause which fails
  const switchCheckbox = root.querySelector('.fq-switch-checkbox');
  assert.ok(switchCheckbox);
  switchCheckbox.checked = false;
  switchCheckbox.dispatchEvent({ type: 'change', target: { checked: false } });
  await new Promise(r => setTimeout(r, 15));

  // Error must be surfaced in .fq-alert-error
  const pauseAlert = root.querySelector('.fq-alert-error');
  assert.ok(pauseAlert);
  assert.ok(pauseAlert.textContent.includes('权限不足，无法切换暂停'));

  // fetchAll still not called to erase the error
  assert.equal(listFetchCount, 1);

  handle.destroy();
});

test('stale mutation responses and destroyed panel do not update state', async () => {
  const root = createMockElement('div');
  let runResolve;

  const request = async payload => {
    if (payload.cmd === 'followQueueList') {
      return { ok: true, jobs: [{ id: `job-${payload.accountId}`, handle: payload.accountId, state: 'pending' }] };
    }
    if (payload.cmd === 'followQueueSettings') return { ok: true, settings: { ...DEFAULT_SETTINGS } };
    if (payload.cmd === 'followQueueRun') {
      return new Promise(resolve => {
        runResolve = resolve;
      });
    }
    return { ok: true };
  };

  const handle = mountFollowQueuePanel(root, { request, accountId: 'AccountAlpha' });
  await new Promise(r => setTimeout(r, 15));

  // Click Run Now for AccountAlpha
  const runBtn = root.querySelector('.fq-header-actions .fq-btn-primary');
  runBtn.click();

  // Switch to AccountBeta while run is awaiting
  await handle.refresh({ accountId: 'AccountBeta' });
  await new Promise(r => setTimeout(r, 15));

  // Now resolve AccountAlpha's run with an error
  runResolve({ ok: false, error: 'Alpha failed execution' });
  await new Promise(r => setTimeout(r, 15));

  // Verify AccountBeta's panel did NOT surface AccountAlpha's error!
  const alertBox = root.querySelector('.fq-alert-error');
  assert.equal(alertBox, null);

  // Verify AccountBeta is rendered
  const rows = root.querySelectorAll('tbody tr');
  assert.equal(rows.length, 1);
  assert.ok(rows[0].textContent.includes('@AccountBeta'));

  handle.destroy();
});

test('account change clears old jobs, selections, settings, and drawers before rendering', async () => {
  const root = createMockElement('div');
  let betaResolve;

  const request = async payload => {
    if (payload.cmd === 'followQueueList') {
      if (payload.accountId === 'AccountA') {
        return {
          ok: true,
          jobs: [
            { id: 'job-a1', handle: 'UserA1', state: 'pending', sources: [{ module: 'fans' }] },
            { id: 'job-a2', handle: 'UserA2', state: 'pending', sources: [{ module: 'mutual' }] }
          ]
        };
      }
      if (payload.accountId === 'AccountB') {
        return new Promise(resolve => {
          betaResolve = resolve;
        });
      }
    }
    if (payload.cmd === 'followQueueSettings') return { ok: true, settings: { ...DEFAULT_SETTINGS } };
    return { ok: true };
  };

  const handle = mountFollowQueuePanel(root, { request, accountId: 'AccountA' });
  await new Promise(r => setTimeout(r, 15));

  // Verify AccountA has 2 jobs rendered
  let rows = root.querySelectorAll('tbody tr');
  assert.equal(rows.length, 2);

  // Select a job
  const checkbox = root.querySelector('tbody tr input[type="checkbox"]');
  checkbox.checked = true;
  checkbox.dispatchEvent({ type: 'change', target: { checked: true } });
  assert.ok(root.querySelector('.fq-selection-info'));

  // Open traceability drawer
  const traceBtn = root.querySelector('.fq-col-actions button');
  traceBtn.click();
  assert.ok(root.querySelector('.fq-drawer'));

  // Switch account to AccountB (its fetch response is delayed)
  const refreshPromise = handle.refresh({ accountId: 'AccountB' });

  // IMMEDIATELY: Old jobs, selection, and drawer must be completely cleared!
  assert.equal(root.querySelector('.fq-drawer'), null, 'Drawer must be closed on account change');
  assert.equal(root.querySelector('.fq-selection-info'), null, 'Selections must be cleared on account change');
  const emptyCell = root.querySelector('.fq-empty-cell');
  assert.ok(emptyCell, 'Jobs table must be empty or showing empty message immediately on account change');

  // Now resolve AccountB's fetch
  betaResolve({
    ok: true,
    jobs: [{ id: 'job-b1', handle: 'UserB1', state: 'pending', sources: [{ module: 'comments' }] }]
  });
  await refreshPromise;
  await new Promise(r => setTimeout(r, 15));

  // AccountB jobs are rendered
  rows = root.querySelectorAll('tbody tr');
  assert.equal(rows.length, 1);
  assert.ok(rows[0].textContent.includes('@UserB1'));

  handle.destroy();
});

test('settings fetch failure displays error banner and disables save button', async () => {
  const root = createMockElement('div');
  let saveAttempted = false;

  const request = async payload => {
    if (payload.cmd === 'followQueueList') return { ok: true, jobs: [] };
    if (payload.cmd === 'followQueueSettings') {
      return { ok: false, error: '配置存储损坏，无法读取' };
    }
    if (payload.cmd === 'followQueueSaveSettings') {
      saveAttempted = true;
      return { ok: true };
    }
    return { ok: true };
  };

  const handle = mountFollowQueuePanel(root, { request, accountId: 'WatsonTaylor23' });
  await new Promise(r => setTimeout(r, 15));

  // Notice error banner must display failure
  const alertBox = root.querySelector('.fq-alert-error');
  assert.ok(alertBox);
  assert.ok(alertBox.textContent.includes('配置加载失败'));
  assert.ok(alertBox.textContent.includes('配置存储损坏，无法读取'));

  // Open settings drawer
  const settingsBtn = root.querySelector('.fq-header-actions button[aria-label="关注队列设置"]');
  settingsBtn.click();

  const drawer = root.querySelector('.fq-drawer');
  assert.ok(drawer);

  // Drawer must display error alert
  const drawerAlert = drawer.querySelector('.fq-alert-error');
  assert.ok(drawerAlert);
  assert.ok(drawerAlert.textContent.includes('获取配置失败'));

  // Save button must be disabled
  const saveBtn = drawer.querySelector('.fq-drawer-footer .fq-btn-primary');
  assert.ok(saveBtn);
  assert.equal(saveBtn.disabled, true, 'Save button must be disabled when settings fetch failed');

  // Attempt to click save button anyway
  saveBtn.click();
  await new Promise(r => setTimeout(r, 15));

  assert.equal(saveAttempted, false, 'Save request must NOT be dispatched when settings fetch failed');

  handle.destroy();
});

test('uncertain job and non-posted evaluation render verify/retry actions and array attempts count', async () => {
  const root = createMockElement('div');
  const calls = [];
  const jobsData = [
    {
      id: 'job-uncertain',
      createdAt: 1,
      accountId: 'WatsonTaylor23',
      targetUserId: '101',
      handle: 'UncertainUser',
      state: 'uncertain',
      sources: [{ module: 'mutual', enabled: true }],
      evaluations: []
    },
    {
      id: 'job-eval-retry',
      createdAt: 2,
      accountId: 'WatsonTaylor23',
      targetUserId: '102',
      handle: 'FollowedDraftUser',
      state: 'followed',
      sources: [{ module: 'comments', url: 'https://x.com/FollowedDraftUser/status/555', enabled: true }],
      evaluations: [{
        taskId: 'comments:https://x.com/FollowedDraftUser/status/555',
        originalPostUrl: 'https://x.com/FollowedDraftUser/status/555',
        originalPostId: '555',
        status: 'draft',
        text: '很赞的观点',
        attempts: [{ at: '2026-10-17T00:00:00Z' }, { at: '2026-10-17T00:05:00Z' }]
      }]
    }
  ];

  const request = async payload => {
    calls.push(payload);
    if (payload.cmd === 'followQueueList') return { ok: true, jobs: jobsData };
    if (payload.cmd === 'followQueueSettings') return { ok: true, settings: { ...DEFAULT_SETTINGS } };
    if (payload.cmd === 'followQueueVerify') {
      jobsData[0] = { ...jobsData[0], state: 'followed' };
      return { ok: true, resolvedState: 'followed' };
    }
    if (payload.cmd === 'followQueueRetryEvaluation') {
      jobsData[1] = {
        ...jobsData[1],
        evaluations: [{ ...jobsData[1].evaluations[0], status: 'posted', publishedPostUrl: 'https://x.com/WatsonTaylor23/status/777' }]
      };
      return { ok: true };
    }
    return { ok: true };
  };

  const handle = mountFollowQueuePanel(root, { request, accountId: 'WatsonTaylor23' });
  await new Promise(r => setTimeout(r, 15));

  const rows = root.querySelectorAll('tbody tr');
  assert.equal(rows.length, 2);

  // First row has verify button
  const row0Btns = rows[0].querySelectorAll('.fq-col-actions button');
  assert.equal(row0Btns[0].getAttribute('aria-label'), '核对关系');
  row0Btns[0].click();
  await new Promise(r => setTimeout(r, 15));
  assert.ok(calls.some(c => c.cmd === 'followQueueVerify' && c.jobId === 'job-uncertain' && c.mode === 'check'));

  // Open traceability drawer on second row and verify array attempts length is rendered as '2'
  const updatedRows = root.querySelectorAll('tbody tr');
  const row1Btns = updatedRows[1].querySelectorAll('.fq-col-actions button');
  assert.equal(row1Btns[0].getAttribute('aria-label'), '发布评价');
  const traceBtn = Array.from(row1Btns).find(button => button.getAttribute('aria-label') === '溯源详情');
  traceBtn.click();

  const drawer = root.querySelector('.fq-drawer');
  assert.ok(drawer);
  assert.ok(drawer.textContent.includes('尝试次数:2'), 'Array attempts should render numeric length 2');

  // Trigger retry evaluation from drawer
  const retryBtn = drawer.querySelector('.fq-eval-card .fq-btn-primary');
  assert.ok(retryBtn);
  assert.equal(retryBtn.textContent, '发布现有草稿');
  retryBtn.click();
  await new Promise(r => setTimeout(r, 15));
  assert.ok(calls.some(c => c.cmd === 'followQueueRetryEvaluation' && c.jobId === 'job-eval-retry' && c.publish === true));

  // Verify Run Now button re-enables after followQueueRun + fetchAll completes
  const runBtn = root.querySelector('.fq-header-actions .fq-exec-run-btn');
  assert.ok(runBtn);
  assert.equal(runBtn.getAttribute('data-panel-tip'), '立即执行');
  runBtn.click();
  await new Promise(r => setTimeout(r, 20));
  const runBtnAfter = root.querySelector('.fq-header-actions .fq-exec-run-btn');
  assert.ok(runBtnAfter);
  assert.equal(runBtnAfter.disabled, false, 'Run button must re-enable after followQueueRun + fetchAll completes');
  assert.equal(runBtnAfter.getAttribute('data-panel-tip'), '立即执行');
  assert.equal(runBtnAfter.textContent, '');
  assert.ok(runBtnAfter.querySelector('svg'));

  handle.destroy();
});

test('paged next stays available when the total is unknown and a bad cursor reloads the first page', async () => {
  const root = createMockElement('div');
  const lists = [];
  let phase = 'first';
  const request = async payload => {
    if (payload.cmd === 'followQueueList') {
      lists.push(payload);
      if (payload.cursor && phase === 'bad-cursor') {
        phase = 'reset';
        return {ok: false, error: 'invalid follow queue cursor'};
      }
      if (payload.cursor) {
        return {ok: true, paged: true, jobs: [{id: 'job-2', handle: 'Second', state: 'pending', sources: []}], hasMore: false, nextCursor: null, total: null, totalKnown: false};
      }
      const pageJobs = Array.from({length: payload.limit}, (_, index) => ({
        id: index === 0 ? 'job-1' : `job-pad-${index}`,
        handle: index === 0 ? 'First' : `Pad${index}`,
        state: 'pending',
        sources: []
      }));
      return {ok: true, paged: true, jobs: pageJobs, hasMore: true, nextCursor: 'cursor-2', total: null, totalKnown: false};
    }
    return {ok: true, settings: {}};
  };
  const handle = mountFollowQueuePanel(root, {request, accountId: 'acc'});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(root.textContent.includes('总数未知'));
  const next = [...root.querySelectorAll('.fq-page-nav-btn')].find(button => button.getAttribute('aria-label') === '下一页');
  assert.equal(next.disabled, false);
  next.click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(root.textContent.includes('@Second'));
  const nextAfter = [...root.querySelectorAll('.fq-page-nav-btn')].find(button => button.getAttribute('aria-label') === '下一页');
  assert.equal(nextAfter.disabled, true);
  const prev = [...root.querySelectorAll('.fq-page-nav-btn')].find(button => button.getAttribute('aria-label') === '上一页');
  prev.click();
  await new Promise(resolve => setTimeout(resolve, 20));
  phase = 'bad-cursor';
  const again = [...root.querySelectorAll('.fq-page-btn')].find(button => button.textContent === '2');
  again.click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(root.textContent.includes('@First'));
  assert.equal(lists.at(-1).cursor, null);
  handle.destroy();
});

test('search keeps scanning past an empty batch and does not treat it as the final page', async () => {
  const root = createMockElement('div');
  const cursors = [];
  const request = async payload => {
    if (payload.cmd !== 'followQueueList') return {ok: true, settings: {}};
    if (payload.q !== 'late') return {ok: true, paged: true, jobs: [], hasMore: false, totalKnown: false};
    cursors.push(payload.cursor || null);
    if (!payload.cursor) return {ok: true, paged: true, jobs: [], hasMore: true, nextCursor: 'cursor-late', totalKnown: false};
    return {ok: true, paged: true, jobs: [{id: 'late', handle: 'LateMatch', state: 'pending', sources: []}], hasMore: false, totalKnown: false};
  };
  const handle = mountFollowQueuePanel(root, {request, accountId: 'acc'});
  await new Promise(resolve => setTimeout(resolve, 20));
  const input = root.querySelector('.fq-search-input');
  input.value = 'late';
  input.dispatchEvent({type: 'input', target: {value: 'late'}});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(cursors, [null, 'cursor-late']);
  assert.ok(root.textContent.includes('@LateMatch'));
  assert.equal(root.textContent.includes('关注队列暂无匹配任务'), false);
  handle.destroy();
});

test('an account change cancels a search batch that resolves later', async () => {
  const root = createMockElement('div');
  let release = null;
  let searches = 0;
  const request = async payload => {
    if (payload.cmd !== 'followQueueList') return {ok: true, settings: {}};
    if (payload.accountId === 'other') {
      return {ok: true, paged: true, jobs: [{id: 'other', handle: 'OtherUser', state: 'pending', sources: []}], hasMore: false, totalKnown: true, total: 1};
    }
    if (payload.q !== 'slow') return {ok: true, paged: true, jobs: [], hasMore: false, totalKnown: false};
    searches += 1;
    if (searches === 1) return {ok: true, paged: true, jobs: [], hasMore: true, nextCursor: 'cursor-slow', totalKnown: false};
    return new Promise(resolve => {
      release = () => resolve({ok: true, paged: true, jobs: [{id: 'late', handle: 'LateUser', state: 'pending', sources: []}], hasMore: false});
    });
  };
  const handle = mountFollowQueuePanel(root, {request, accountId: 'acc'});
  await new Promise(resolve => setTimeout(resolve, 20));
  const input = root.querySelector('.fq-search-input');
  input.value = 'slow';
  input.dispatchEvent({type: 'input', target: {value: 'slow'}});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(typeof release, 'function');
  await handle.refresh({accountId: 'other'});
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(root.textContent.includes('@OtherUser'));
  assert.equal(root.textContent.includes('@LateUser'), false);
  handle.destroy();
});

test('partial search chunks fill one page without duplicating or skipping rows', async () => {
  const root = createMockElement('div');
  const request = async payload => {
    if (payload.cmd !== 'followQueueList') return {ok: true, settings: {}};
    if (payload.q !== 'part') return {ok: true, paged: true, jobs: [], hasMore: false, totalKnown: false};
    if (!payload.cursor) {
      return {ok: true, paged: true, jobs: [{id: 'a', handle: 'Alpha', state: 'pending', sources: []}], hasMore: true, nextCursor: 'cursor-b', totalKnown: false, scanned: 200};
    }
    return {
      ok: true,
      paged: true,
      jobs: [
        {id: 'a', handle: 'Alpha', state: 'pending', sources: []},
        {id: 'b', handle: 'Beta', state: 'pending', sources: []}
      ],
      hasMore: false,
      totalKnown: false,
      scanned: 3
    };
  };
  const handle = mountFollowQueuePanel(root, {request, accountId: 'acc'});
  await new Promise(resolve => setTimeout(resolve, 10));
  const input = root.querySelector('.fq-search-input');
  input.value = 'part';
  input.dispatchEvent({type: 'input', target: {value: 'part'}});
  await new Promise(resolve => setTimeout(resolve, 30));
  const rows = [...root.querySelectorAll('tbody tr')].map(row => row.textContent);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].includes('@Alpha'));
  assert.ok(rows[1].includes('@Beta'));
  assert.ok(root.textContent.includes('已扫描 203 条'));
  handle.destroy();
});

test('exhausted search with no matches is a finished empty page', async () => {
  const root = createMockElement('div');
  const request = async payload => {
    if (payload.cmd !== 'followQueueList') return {ok: true, settings: {}};
    if (payload.q !== 'none') return {ok: true, paged: true, jobs: [], hasMore: false, totalKnown: true, total: 0};
    return {ok: true, paged: true, jobs: [], hasMore: false, nextCursor: null, totalKnown: false};
  };
  const handle = mountFollowQueuePanel(root, {request, accountId: 'acc'});
  await new Promise(resolve => setTimeout(resolve, 10));
  const input = root.querySelector('.fq-search-input');
  input.value = 'none';
  input.dispatchEvent({type: 'input', target: {value: 'none'}});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(root.textContent.includes('关注队列暂无匹配任务'));
  assert.ok(root.textContent.includes('已检索完'));
  for (const summary of root.querySelectorAll('.fq-page-summary')) {
    assert.equal((summary.textContent.match(/总数未知/g) || []).length, 1);
    assert.equal(summary.textContent, '第 1 页 · 总数未知 · 已检索完');
  }
  const next = [...root.querySelectorAll('.fq-page-nav-btn')].find(button => button.getAttribute('aria-label') === '下一页');
  assert.equal(next.disabled, true);
  handle.destroy();
});

test('metadata exhausted search says the scan finished once and does not repeat the unknown total', async () => {
  const root = createMockElement('div');
  const request = async payload => {
    if (payload.cmd !== 'followQueueList') return {ok: true, settings: {}};
    if (payload.q !== 'missing') return {ok: true, paged: true, jobs: [], hasMore: false, totalKnown: true, total: 0};
    return {
      ok: true,
      paged: true,
      jobs: [],
      hasMore: false,
      nextCursor: null,
      total: null,
      totalKnown: false,
      scanned: 225,
      scanBatch: 200,
      scanLimited: false,
      scanExhausted: true
    };
  };
  const handle = mountFollowQueuePanel(root, {request, accountId: 'acc'});
  await new Promise(resolve => setTimeout(resolve, 10));
  const input = root.querySelector('.fq-search-input');
  input.value = 'missing';
  input.dispatchEvent({type: 'input', target: {value: 'missing'}});
  await new Promise(resolve => setTimeout(resolve, 20));
  const summaries = [...root.querySelectorAll('.fq-page-summary')].map(node => node.textContent);
  assert.ok(summaries.length >= 1);
  for (const summary of summaries) {
    assert.equal(summary, '第 1 页 · 总数未知 · 已检索完 · 已扫描 225 条');
    assert.equal((summary.match(/总数未知/g) || []).length, 1);
  }
  assert.ok(root.textContent.includes('已检索完'));
  const next = [...root.querySelectorAll('.fq-page-nav-btn')].find(button => button.getAttribute('aria-label') === '下一页');
  assert.equal(next.disabled, true);
  handle.destroy();
});

test('a settings rejection is handled before the list scan finishes', async () => {
  const root = createMockElement('div');
  let releaseList;
  const listGate = new Promise(resolve => { releaseList = resolve; });
  const rejections = [];
  const onRejection = reason => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  const request = async payload => {
    if (payload.cmd === 'followQueueSettings') throw new Error('settings down');
    if (payload.cmd === 'followQueueList') {
      await listGate;
      return {ok: true, paged: true, jobs: [{id: 'kept', handle: 'Kept', state: 'pending', sources: []}], hasMore: false, totalKnown: true, total: 1};
    }
    return {ok: true};
  };
  const handle = mountFollowQueuePanel(root, {request, accountId: 'acc'});
  await new Promise(resolve => setTimeout(resolve, 10));
  releaseList();
  await new Promise(resolve => setTimeout(resolve, 20));
  process.off('unhandledRejection', onRejection);
  assert.equal(rejections.length, 0);
  assert.ok(root.textContent.includes('@Kept'));
  assert.ok(root.textContent.includes('settings down'));
  handle.destroy();
});

test('queue loading bool stays visible and does not claim the list is empty', async () => {
  const root = createMockElement('div');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const request = async payload => {
    if (payload.cmd === 'followQueueList') {
      await gate;
      return {ok: true, jobs: [], summary: {isPaused: true}};
    }
    if (payload.cmd === 'followQueueSettings') return {ok: true, settings: {...DEFAULT_SETTINGS}};
    return {ok: true};
  };
  const handle = mountFollowQueuePanel(root, {request, accountId: '123'});
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.match(root.textContent, /正在加载关注队列/);
  assert.equal(root.textContent.includes('关注队列暂无匹配任务'), false);
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(root.textContent.includes('正在加载关注队列'), false);
  assert.match(root.textContent, /关注队列暂无匹配任务/);
  handle.destroy();
});

test('queue read failure keeps the empty state hidden and offers retry', async () => {
  const root = createMockElement('div');
  const request = async payload => {
    if (payload.cmd === 'followQueueList') return {ok: false, error: '读取中断'};
    if (payload.cmd === 'followQueueSettings') return {ok: true, settings: {...DEFAULT_SETTINGS}};
    return {ok: true};
  };
  const handle = mountFollowQueuePanel(root, {request, accountId: '123'});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(root.textContent, /读取中断/);
  assert.match(root.textContent, /重试/);
  assert.match(root.textContent, /尚未确认列表为空/);
  assert.equal(root.textContent.includes('关注队列暂无匹配任务'), false);
  handle.destroy();
});

test('queue refresh keeps the current row while the loading bool is on', async () => {
  const root = createMockElement('div');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let lists = 0;
  const request = async payload => {
    if (payload.cmd === 'followQueueList') {
      lists += 1;
      const job = {id: 'kept', handle: 'Kept', state: 'pending', sources: []};
      if (lists > 1) await gate;
      return {ok: true, jobs: [job], summary: {}};
    }
    if (payload.cmd === 'followQueueSettings') return {ok: true, settings: {...DEFAULT_SETTINGS}};
    return {ok: true};
  };
  const handle = mountFollowQueuePanel(root, {request, accountId: '123'});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(root.textContent, /@Kept/);
  const refreshing = handle.refresh();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.match(root.textContent, /正在刷新关注队列/);
  assert.match(root.textContent, /@Kept/);
  release();
  await refreshing;
  assert.equal(root.textContent.includes('正在刷新关注队列'), false);
  assert.match(root.textContent, /@Kept/);
  handle.destroy();
});


test('weight column defaults descending and toggle requests ascending from the first page', async () => {
  const root=createMockElement('div'), calls=[];
  const panel=mountFollowQueuePanel(root,{accountId:'123',request:async payload=>{
    calls.push(payload);
    if(payload.cmd==='followQueueSettings') return {ok:true,settings:DEFAULT_SETTINGS};
    return {ok:true,paged:true,jobs:[],total:0,totalKnown:true};
  }});
  await new Promise(r=>setTimeout(r,20));
  assert.equal(calls.find(c=>c.cmd==='followQueueList').order,'desc');
  assert.equal(root.querySelector('.fq-col-priority').getAttribute('aria-sort'),'descending');
  root.querySelector('.fq-priority-sort').dispatchEvent({type:'click'});
  await new Promise(r=>setTimeout(r,20));
  const latest=calls.filter(c=>c.cmd==='followQueueList').at(-1);
  assert.equal(latest.order,'asc'); assert.equal(latest.cursor,null);
  assert.equal(root.querySelector('.fq-col-priority').getAttribute('aria-sort'),'ascending');
  panel.destroy();
});

for (const rejected of [false, true]) {
  test(`first-page scan recovers an invalid cursor without mixing revisions, rejected=${rejected}`, async () => {
    const root = createMockElement('div');
    const cursors = [];
    let restarted = false;
    const request = async payload => {
      if (payload.cmd !== 'followQueueList') return {ok: true, settings: {}};
      cursors.push(payload.cursor);
      if (payload.cursor) {
        restarted = true;
        if (rejected) throw new Error('invalid follow queue cursor');
        return {ok: false, error: 'invalid follow queue cursor'};
      }
      return {ok: true, paged: true, jobs: [{id: restarted ? 'fresh' : 'old', handle: restarted ? 'Fresh' : 'Obsolete', state: 'uncertain', sources: []}], hasMore: !restarted, nextCursor: restarted ? null : 'old-cursor', totalKnown: false};
    };
    const panel = mountFollowQueuePanel(root, {request, accountId: 'acc'});
    try {
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.deepEqual(cursors, [null, 'old-cursor', null]);
      assert.ok(root.textContent.includes('@Fresh'));
      assert.equal(root.textContent.includes('@Obsolete'), false);
      assert.equal(root.textContent.includes('invalid follow queue cursor'), false);
    } finally { panel.destroy(); }
  });
}

test('cursor recovery is bounded and manual retry gets a fresh budget', async () => {
  const root = createMockElement('div');
  let calls = 0;
  const request = async payload => {
    if (payload.cmd !== 'followQueueList') return {ok: true, settings: {}};
    calls++;
    return {ok: false, error: 'invalid follow queue cursor'};
  };
  const panel = mountFollowQueuePanel(root, {request, accountId: 'acc'});
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls, 3);
    assert.ok(root.textContent.includes('队列正在更新，请稍后重试。'));
    const retry = [...root.querySelectorAll('button')].find(button => button.textContent === '重试');
    retry.click();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls, 6);
  } finally { panel.destroy(); }
});

test('settings drawer renders 引用概率 and 篇幅 with accessible help, validates invalid inputs inline without resetting, and reflects persisted values on save', async () => {
  const root = createMockElement('div');
  let persistedSettings = { ...DEFAULT_SETTINGS };
  const saveCalls = [];

  const request = async payload => {
    if (payload.cmd === 'followQueueList') return { ok: true, jobs: [] };
    if (payload.cmd === 'followQueueSettings') return { ok: true, settings: { ...persistedSettings } };
    if (payload.cmd === 'followQueueSaveSettings') {
      saveCalls.push(payload.settings);
      persistedSettings = { ...persistedSettings, ...payload.settings };
      return { ok: true, settings: { ...persistedSettings } };
    }
    return { ok: true };
  };

  const panel = mountFollowQueuePanel(root, { request, accountId: 'WatsonTaylor23' });
  try {
    await new Promise(r => setTimeout(r, 15));

    const settingsBtn = root.querySelector('.fq-header-actions button[aria-label="关注队列设置"]');
    settingsBtn.click();

    let drawer = root.querySelector('.fq-drawer');
    assert.ok(drawer);
    assert.ok(drawer.textContent.includes('发帖形式'));
    assert.ok(drawer.textContent.includes('创作概率'));
    assert.ok(drawer.textContent.includes('篇幅'));

    const rateInput = drawer.querySelector('#fq_quoteParticipationRate');
    const lengthSelect = drawer.querySelector('#fq_quoteLengthMode');
    assert.ok(rateInput);
    assert.ok(lengthSelect);
    assert.equal(rateInput.value, '60');
    assert.equal(lengthSelect.value, 'adaptive');

    // Accessible help tips for 引用概率 and 篇幅
    const tips = drawer.querySelectorAll('.info-tip');
    const rateTip = [...tips].find(node => (node.getAttribute('aria-label') || '').includes('只抽取一次'));
    assert.ok(rateTip, 'Probability help tip must explain single sampling before Grok');
    assert.match(rateTip.getAttribute('aria-label'), /质量/);
    assert.match(rateTip.getAttribute('aria-label'), /0%/);
    assert.equal(rateTip.getAttribute('tabindex'), '0');

    const lengthTip = [...tips].find(node => (node.getAttribute('aria-label') || '').includes('自适应按原帖信息量表达'));
    assert.ok(lengthTip, 'Length mode help tip must be accessible');
    assert.equal(lengthTip.getAttribute('tabindex'), '0');

    // Invalid input: decimal / out-of-range / empty must show inline error, preserve invalid input, and block save
    for (const invalidVal of ['60.5', '-5', '101', '']) {
      drawer = root.querySelector('.fq-drawer');
      const input = drawer.querySelector('#fq_quoteParticipationRate');
      input.value = invalidVal;
      input.dispatchEvent({ type: 'input', target: { value: invalidVal } });

      const saveBtn = drawer.querySelector('.fq-drawer-footer .fq-btn-primary');
      saveBtn.click();
      await new Promise(r => setTimeout(r, 10));

      assert.equal(saveCalls.length, 0, `Invalid rate "${invalidVal}" must not dispatch followQueueSaveSettings`);
      const refreshedDrawer = root.querySelector('.fq-drawer');
      assert.ok(refreshedDrawer, 'Settings drawer must stay open on validation error');
      const refreshedInput = refreshedDrawer.querySelector('#fq_quoteParticipationRate');
      assert.equal(refreshedInput.value, invalidVal, `Invalid input "${invalidVal}" must be preserved and never silently reset to 60`);
      assert.equal(refreshedInput.getAttribute('aria-invalid'), 'true');
      const inlineErr = refreshedDrawer.querySelector('#fq_quoteParticipationRate_error');
      assert.ok(inlineErr);
      assert.match(inlineErr.textContent, /请输入 0—100 的整数/);
    }

    // Valid save at boundary 0% and deep mode
    drawer = root.querySelector('.fq-drawer');
    const validRateInput = drawer.querySelector('#fq_quoteParticipationRate');
    const validLengthSelect = drawer.querySelector('#fq_quoteLengthMode');
    validRateInput.value = '0';
    validRateInput.dispatchEvent({ type: 'input', target: { value: '0' } });
    validLengthSelect.value = 'deep';
    validLengthSelect.dispatchEvent({ type: 'change', target: { value: 'deep' } });

    const saveBtn = drawer.querySelector('.fq-drawer-footer .fq-btn-primary');
    saveBtn.click();
    await new Promise(r => setTimeout(r, 15));

    assert.equal(saveCalls.length, 1);
    assert.equal(saveCalls[0].quoteParticipationRate, 0);
    assert.equal(saveCalls[0].quoteLengthMode, 'deep');
    assert.equal(saveCalls[0].grokEnabled, false);
    assert.equal(saveCalls[0].autoPublish, false);

    // Header help and reopened drawer reflect persisted values
    assert.match(root.querySelector('.fq-grok-status').getAttribute('data-panel-tip'), /创作概率：0%；篇幅：深入/);
    settingsBtn.click();
    drawer = root.querySelector('.fq-drawer');
    assert.equal(drawer.querySelector('#fq_quoteParticipationRate').value, '0');
    assert.equal(drawer.querySelector('#fq_quoteLengthMode').value, 'deep');
  } finally {
    panel.destroy();
  }
});

test('publicationMode radio group enforces exclusivity, keyboard-accessible tips, invalid mode validation, save/reopen roundtrip, and immutable draft mode display', async () => {
  const root = createMockElement('div');
  let persistedSettings = { ...DEFAULT_SETTINGS };
  const saveCalls = [];
  const jobsData = [
    {
      id: 'job-quote-draft',
      createdAt: 1,
      accountId: 'WatsonTaylor23',
      targetUserId: '301',
      handle: 'QuoteDraftUser',
      state: 'followed',
      sources: [{ module: 'comments', url: 'https://x.com/QuoteDraftUser/status/801', enabled: true }],
      evaluations: [{
        taskId: 'eval-quote-draft',
        publicationMode: 'quote',
        originalAuthorId: '301',
        originalPostId: '801',
        originalPostUrl: 'https://x.com/QuoteDraftUser/status/801',
        status: 'draft',
        text: '保留为引用评论形式的草稿',
        attempts: 1
      }]
    },
    {
      id: 'job-original-draft',
      createdAt: 2,
      accountId: 'WatsonTaylor23',
      targetUserId: '302',
      handle: 'OriginalDraftUser',
      state: 'followed',
      sources: [{ module: 'fans', url: 'https://x.com/OriginalDraftUser/status/802', enabled: true }],
      evaluations: [{
        taskId: 'eval-original-draft',
        publicationMode: 'original',
        originalAuthorId: '302',
        originalPostId: '802',
        originalPostUrl: 'https://x.com/OriginalDraftUser/status/802',
        status: 'draft',
        text: '作为独立新帖发布的草稿',
        attempts: 1
      }]
    }
  ];

  const request = async payload => {
    if (payload.cmd === 'followQueueList') return { ok: true, jobs: jobsData };
    if (payload.cmd === 'followQueueSettings') return { ok: true, settings: { ...persistedSettings } };
    if (payload.cmd === 'followQueueSaveSettings') {
      saveCalls.push(payload.settings);
      persistedSettings = { ...persistedSettings, ...payload.settings };
      return { ok: true, settings: { ...persistedSettings } };
    }
    return { ok: true };
  };

  const panel = mountFollowQueuePanel(root, { request, accountId: 'WatsonTaylor23' });
  try {
    await new Promise(r => setTimeout(r, 15));

    // Default header help shows the configured publication mode
    assert.match(root.querySelector('.fq-grok-status').getAttribute('data-panel-tip'), /发帖形式：引用评论/);

    // Table evaluation badges show each evaluation's own publication mode
    const rows = root.querySelectorAll('tbody tr');
    assert.equal(rows.length, 2);
    const quoteRow = [...rows].find(r => r.textContent.includes('@QuoteDraftUser'));
    const origRow = [...rows].find(r => r.textContent.includes('@OriginalDraftUser'));
    assert.match(quoteRow.querySelector('.fq-col-eval').textContent, /引用评论/);
    assert.match(origRow.querySelector('.fq-col-eval').textContent, /新帖/);

    // Open settings drawer
    const settingsBtn = root.querySelector('.fq-header-actions button[aria-label="关注队列设置"]');
    settingsBtn.click();

    let drawer = root.querySelector('.fq-drawer');
    assert.ok(drawer);
    const radioGroup = drawer.querySelector('#fq_publicationMode');
    const quoteRadio = drawer.querySelector('#fq_publicationMode_quote');
    const originalRadio = drawer.querySelector('#fq_publicationMode_article');
    assert.ok(radioGroup);
    assert.equal(radioGroup.getAttribute('role'), 'radiogroup');
    assert.ok(quoteRadio);
    assert.ok(originalRadio);
    assert.equal(quoteRadio.type, 'radio');
    assert.equal(originalRadio.type, 'radio');
    assert.equal(quoteRadio.value, 'quote');
    assert.equal(originalRadio.value, 'article');

    // Default selection is 引用评论 (quote)
    assert.equal(quoteRadio.checked, true);
    assert.equal(quoteRadio.getAttribute('aria-checked'), 'true');
    assert.equal(originalRadio.checked, false);
    assert.equal(originalRadio.getAttribute('aria-checked'), 'false');

    // Keyboard accessible tips explain standalone original post without quote card, independent value & skip, and new tasks only
    const tips = drawer.querySelectorAll('.info-tip');
    const modeTip = [...tips].find(node => (node.getAttribute('aria-label') || '').includes('5:2 封面'));
    assert.ok(modeTip, 'Publication mode help tip must explain standalone post without quote card');
    assert.equal(modeTip.getAttribute('tabindex'), '0');
    assert.match(modeTip.getAttribute('aria-label'), /独立/);
    assert.match(modeTip.getAttribute('aria-label'), /短描述/);
    assert.match(modeTip.getAttribute('aria-label'), /保留草稿/);
    assert.ok(drawer.querySelector('#fq_publicationMode_reply'));
    assert.equal(drawer.querySelectorAll('input[name="publicationMode"]').length,3);

    // Radio mutual exclusivity: selecting 新帖 unchecks 引用评论, and selecting 引用评论 unchecks 新帖
    originalRadio.click();
    assert.equal(originalRadio.checked, true);
    assert.equal(originalRadio.getAttribute('aria-checked'), 'true');
    assert.equal(quoteRadio.checked, false);
    assert.equal(quoteRadio.getAttribute('aria-checked'), 'false');

    quoteRadio.click();
    assert.equal(quoteRadio.checked, true);
    assert.equal(originalRadio.checked, false);

    // Invalid mode validation blocks save and shows actionable Chinese message
    radioGroup.dispatchEvent({ type: 'change', target: { value: 'invalid_mode' } });
    drawer.querySelector('.fq-drawer-footer .fq-btn-primary').click();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(saveCalls.length, 0);
    drawer = root.querySelector('.fq-drawer');
    assert.ok(drawer);
    assert.equal(drawer.querySelector('#fq_publicationMode').getAttribute('aria-invalid'), 'true');
    assert.match(drawer.querySelector('#fq_publicationMode_error').textContent, /发帖形式请选择评论、引用评论或文章/);
    assert.match(drawer.textContent, /发帖形式请选择评论、引用评论或文章/);

    // Select 新帖 (original) and save
    const refreshedOriginalRadio = drawer.querySelector('#fq_publicationMode_article');
    const refreshedQuoteRadio = drawer.querySelector('#fq_publicationMode_quote');
    refreshedOriginalRadio.click();
    assert.equal(refreshedOriginalRadio.checked, true);
    assert.equal(refreshedQuoteRadio.checked, false);

    drawer.querySelector('.fq-drawer-footer .fq-btn-primary').click();
    await new Promise(r => setTimeout(r, 15));

    assert.equal(saveCalls.length, 1);
    assert.equal(saveCalls[0].publicationMode, 'article');
    assert.match(root.querySelector('.fq-grok-status').getAttribute('data-panel-tip'), /发帖形式：文章/);

    // Reopen settings drawer and verify 新帖 remains selected
    settingsBtn.click();
    drawer = root.querySelector('.fq-drawer');
    assert.equal(drawer.querySelector('#fq_publicationMode_article').checked, true);
    assert.equal(drawer.querySelector('#fq_publicationMode_quote').checked, false);
    drawer.querySelector('.panel-close-button').click();

    // Existing saved quote draft in evaluation details STILL shows 引用评论 after settings changed to 新帖
    const updatedQuoteRow = [...root.querySelectorAll('tbody tr')].find(r => r.textContent.includes('@QuoteDraftUser'));
    const quoteTraceBtn = [...updatedQuoteRow.querySelectorAll('.fq-col-actions button')].find(b => b.getAttribute('aria-label') === '溯源详情');
    quoteTraceBtn.click();
    const quoteDrawer = root.querySelector('.fq-drawer');
    assert.ok(quoteDrawer);
    assert.match(quoteDrawer.textContent, /发帖形式:引用评论（附带引用卡片）/);
    quoteDrawer.querySelector('.panel-close-button').click();

    // Original draft in evaluation details shows 新帖（独立发帖，不附带引用卡片）
    const updatedOrigRow = [...root.querySelectorAll('tbody tr')].find(r => r.textContent.includes('@OriginalDraftUser'));
    const origTraceBtn = [...updatedOrigRow.querySelectorAll('.fq-col-actions button')].find(b => b.getAttribute('aria-label') === '溯源详情');
    origTraceBtn.click();
    const origDrawer = root.querySelector('.fq-drawer');
    assert.ok(origDrawer);
    assert.match(origDrawer.textContent, /发帖形式:旧版新帖（独立发帖，不附带引用卡片）/);

  } finally {
    panel.destroy();
  }
});

test('uncertain evaluation checks only and recovered generation is labeled without publishing promises', async () => {
  const root=createMockElement('div');const calls=[];
  let job={id:'recovery-job',handle:'target',accountId:'owner',state:'followed',sources:[],evaluations:[{taskId:'task',status:'uncertain',reasonCode:'generation_uncertain'}]};
  const panel=mountFollowQueuePanel(root,{accountId:'owner',request:async message=>{
    calls.push(message);
    if(message.cmd==='followQueueSettings')return{ok:true,settings:DEFAULT_SETTINGS};
    if(message.cmd==='followQueueRetryEvaluation'){
      job={...job,evaluations:[{...job.evaluations[0],status:'failed',reasonCode:'generation_retry_ready',recoveryDraftOnly:true,
        recoveryHistory:[{id:'generation:1',at:1,evaluation:{status:'uncertain',reason:'原始额度异常',attempts:11,generationAttemptedAt:1}}]}]};
      return{ok:true,evaluation:job.evaluations[0],summary:'可重新生成'};
    }
    return{ok:true,jobs:[job]};
  }});
  try{
    await new Promise(r=>setTimeout(r,20));root.querySelectorAll('button').find(b=>b.getAttribute('aria-label')==='核对评价').click();
    await new Promise(r=>setTimeout(r,20));
    assert.equal(calls.find(m=>m.cmd==='followQueueRetryEvaluation').verifyOnly,true);
    assert.ok(root.querySelectorAll('button').some(b=>b.getAttribute('aria-label')==='重新生成'));
    root.querySelectorAll('button').find(b=>b.getAttribute('aria-label')==='溯源详情').click();
    assert.match(root.querySelector('.fq-recovery-history').textContent,/原始额度异常/);
    assert.doesNotMatch(root.querySelector('.fq-eval-card').textContent,/重新生成并发布/);
  }finally{panel.destroy()}
});

test('successful verification shows a three-second toast and refresh does not resurrect it', async()=>{
 const root=createMockElement('div');let jobs=[{id:'a',handle:'a',state:'uncertain',sources:[]}];
 const prior=globalThis.confirm;globalThis.confirm=()=>true;
 const panel=mountFollowQueuePanel(root,{accountId:'owner',request:async m=>{
  if(m.cmd==='followQueueSettings')return {ok:true,settings:DEFAULT_SETTINGS};
  if(m.cmd==='followQueueList')return {ok:true,jobs};
  if(m.cmd==='followQueueVerify'){jobs=[];return {ok:true};}return {ok:true};
 }});
 try{
  await new Promise(r=>setTimeout(r,20));root.querySelectorAll('.fq-filter-tab').find(b=>b.textContent==='待核实').click();
  root.querySelector('thead input').dispatchEvent({type:'change',target:{checked:true}});
  root.querySelectorAll('button').find(b=>b.textContent==='批量核对').click();await new Promise(r=>setTimeout(r,30));
  assert.match(root.querySelector('.fq-batch-toast').textContent,/3 秒后关闭/);
  await new Promise(r=>setTimeout(r,1050));assert.match(root.querySelector('.fq-batch-countdown').textContent,/2 秒后关闭/);
  await panel.refresh();await new Promise(r=>setTimeout(r,2050));assert.equal(root.querySelector('.fq-batch-feedback'),null);
  await panel.refresh();assert.equal(root.querySelector('.fq-batch-feedback'),null);
 }finally{panel.destroy();globalThis.confirm=prior;}
});


test('retry selection submits one scoped batch and reports queued rather than followed', async () => {
  const root=createMockElement('div'),calls=[];
  const panel=mountFollowQueuePanel(root,{accountId:'owner',request:async m=>{
    if(m.cmd==='followQueueSettings')return {ok:true,settings:DEFAULT_SETTINGS};
    if(m.cmd==='followQueueList')return {ok:true,jobs:[{id:'a',handle:'alpha',state:'retry',sources:[]},{id:'b',handle:'beta',state:'retry',sources:[]}]};
    if(m.cmd==='followQueueRetryBatch'){calls.push(m);return {ok:true,accepted:['a'],rejected:[{id:'b',handle:'beta',reason:'已有操作记录，请先核实结果'}]};}
    return {ok:true};
  }});
  const wait=()=>new Promise(r=>setTimeout(r,20));
  try {
    await wait();root.querySelectorAll('.fq-filter-tab').find(b=>b.textContent==='等待重试').click();
    root.querySelector('thead input').dispatchEvent({type:'change',target:{checked:true}});
    root.querySelectorAll('button').find(b=>b.textContent==='批量重试').click();await wait();
    assert.deepEqual(calls,[{cmd:'followQueueRetryBatch',accountId:'owner',jobIds:['a','b']}]);
    assert.match(root.querySelector('.fq-batch-feedback').textContent,/已加入优先重试 1 项，未加入 1 项/);
    assert.match(root.querySelector('.fq-batch-feedback').textContent,/@beta：已有操作记录/);
    assert.match(root.querySelector('.fq-selection-info').textContent,/已选 1 项/);
  } finally {panel.destroy();}
});

test('switching filter clears batch timer, dismisses toast, and resets row selection', async () => {
  const root = createMockElement('div');
  let jobs = [
    {id: 'a', handle: 'alpha', state: 'uncertain', sources: []},
    {id: 'b', handle: 'beta', state: 'retry', sources: []}
  ];
  const prior = globalThis.confirm; globalThis.confirm = () => true;
  const panel = mountFollowQueuePanel(root, {accountId: 'owner', request: async m => {
    if (m.cmd === 'followQueueSettings') return {ok: true, settings: DEFAULT_SETTINGS};
    if (m.cmd === 'followQueueList') return {ok: true, jobs};
    if (m.cmd === 'followQueueVerify') { jobs = jobs.filter(j => j.id !== m.jobId); return {ok: true}; }
    return {ok: true};
  }});
  const wait = () => new Promise(r => setTimeout(r, 20));
  try {
    await wait();
    root.querySelectorAll('.fq-filter-tab').find(b => b.textContent === '待核实').click();
    await wait();
    root.querySelector('thead input').dispatchEvent({type: 'change', target: {checked: true}});
    root.querySelectorAll('button').find(b => b.textContent === '批量核对').click();
    await wait();
    assert.ok(root.querySelector('.fq-batch-toast'), 'toast is shown after full success');

    // Switch filter tab
    root.querySelectorAll('.fq-filter-tab').find(b => b.textContent === '等待重试').click();
    await wait();
    assert.equal(root.querySelector('.fq-batch-feedback'), null, 'toast dismissed on filter switch');

    // Select row in retry tab
    root.querySelector('thead input').dispatchEvent({type: 'change', target: {checked: true}});
    assert.ok(root.querySelector('.fq-selection-info'), 'selection info present');

    // Switch filter tab again to '全部'
    root.querySelectorAll('.fq-filter-tab').find(b => b.textContent === '全部状态').click();
    await wait();
    assert.equal(root.querySelector('.fq-selection-info'), null, 'selection cleared across filter switch');
  } finally {
    panel.destroy();
    globalThis.confirm = prior;
  }
});

test('triggering next action clears existing batch toast and timer', async () => {
  const root = createMockElement('div');
  let jobs = [
    {id: 'a', handle: 'alpha', state: 'uncertain', sources: []},
    {id: 'b', handle: 'beta', state: 'uncertain', sources: []}
  ];
  const prior = globalThis.confirm; globalThis.confirm = () => true;
  const panel = mountFollowQueuePanel(root, {accountId: 'owner', request: async m => {
    if (m.cmd === 'followQueueSettings') return {ok: true, settings: DEFAULT_SETTINGS};
    if (m.cmd === 'followQueueList') return {ok: true, jobs};
    if (m.cmd === 'followQueueVerify') { return {ok: true}; }
    return {ok: true};
  }});
  const wait = () => new Promise(r => setTimeout(r, 20));
  try {
    await wait();
    root.querySelectorAll('.fq-filter-tab').find(b => b.textContent === '待核实').click();
    await wait();
    // Select only item a
    root.querySelectorAll('tbody input')[0].dispatchEvent({type: 'change', target: {checked: true}});
    root.querySelectorAll('button').find(b => b.textContent === '批量核对').click();
    await wait();
    assert.ok(root.querySelector('.fq-batch-toast'), 'toast is displayed');

    // Trigger single verify on remaining item b as next action
    const singleVerifyBtn = root.querySelectorAll('button').find(b => b.getAttribute('aria-label') === '核对关系');
    assert.ok(singleVerifyBtn, 'single verification control must exist');
    singleVerifyBtn.click();
    assert.equal(root.querySelector('.fq-batch-toast'), null, 'toast cleared when next action starts');
  } finally {
    panel.destroy();
    globalThis.confirm = prior;
  }
});
