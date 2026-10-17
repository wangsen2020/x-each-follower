import test from 'node:test';
import assert from 'node:assert/strict';
import {extractGrokComment, buildGrokCommentPrompt, tweetWeight, makeNonce, START, END, postQuoteOnTab, buildBackgroundGrokWindowOptions, submitGrokPromptAndWaitForCopyIconOnPage, driveGrokInput, createStableAnswerGate, readGrokPageAnswer} from '../grok-comment.js';
import {openQuoteComposerOnPage, inspectQuoteComposerOnPage, publishQuotePostOnPage, dismissQuoteComposerOnPage} from '../page-reader.js';

test('extractGrokComment takes the body between markers', () => {
  assert.equal(extractGrokComment(`好的\n${START}恭喜达成 8k，一步一个脚印真扎实！你下一个目标是多少？${END}\n希望有帮助`), '恭喜达成 8k，一步一个脚印真扎实！你下一个目标是多少？');
});

test('extractGrokComment uses the last marked block and strips wrapping quotes', () => {
  assert.equal(extractGrokComment(`${START}旧的草稿内容很长很长${END} 修改后：${START}“新的评论内容在这里”${END}`), '新的评论内容在这里');
});

test('extractGrokComment rejects missing markers, unterminated output, placeholders and empty bodies', () => {
  assert.equal(extractGrokComment('只是一段话，没有标记'), '');
  assert.equal(extractGrokComment(`${START}还没写完就被截断`), '');
  assert.equal(extractGrokComment(`${START}你的评论内容${END}`), '');
  assert.equal(extractGrokComment(`${START}  ${END}`), '');
  assert.equal(extractGrokComment(''), '');
  assert.equal(extractGrokComment(null), '');
});

test('the prompt echo (which contains the markers) is never mistaken for an answer', () => {
  const nonce = makeNonce();
  const prompt = buildGrokCommentPrompt({handle: 'alice', name: 'Alice', postText: '今天发布了新版本', nonce});
  // 页面里提示词原样出现时：说明里的标记之间没有评论正文，必须取不到
  assert.equal(extractGrokComment(prompt), '');
  assert.ok(prompt.includes(nonce));
});

test('extractGrokComment rejects comments over the 280-weight X limit', () => {
  assert.equal(extractGrokComment(`${START}${'好'.repeat(150)}${END}`), '');
  assert.ok(extractGrokComment(`${START}${'好'.repeat(100)}${END}`));
});

test('tweetWeight counts CJK as 2 and latin as 1', () => {
  assert.equal(tweetWeight('abc'), 3);
  assert.equal(tweetWeight('你好'), 4);
  assert.equal(tweetWeight('a你'), 3);
});

test('makeNonce is unique per call', () => {
  assert.notEqual(makeNonce(), makeNonce());
});

test('stable answer gate ignores early copy controls until completion and repeated text', () => {
  const stable = createStableAnswerGate(4);
  assert.equal(stable('partial answer', false), false);
  assert.equal(stable('complete answer', true), false);
  assert.equal(stable('complete answer', true), false);
  assert.equal(stable('complete answer', true), false);
  assert.equal(stable('complete answer', true), true);
  assert.equal(stable('changed final answer', true), false);
  assert.equal(stable('changed final answer', false), false);
});

test('Grok windows use a visible, compact popup without taking focus', () => {
  assert.deepEqual(buildBackgroundGrokWindowOptions('https://grok.com/'), {
    url: 'https://grok.com/', type: 'popup', state: 'normal', focused: false,
    width: 800, height: 600
  });
});

test('Grok analysis waits for a new copy control and a structured target result', async () => {
  const previous = {
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
    InputEvent: globalThis.InputEvent,
    Event: globalThis.Event
  };
  let observer;
  let resolveObserved;
  const input = {tagName:'DIV', dispatchEvent() {}};
  const send = {disabled:false, innerText:'Send', getAttribute:() => null, click() {
    buttons.push({innerText:'', getAttribute:() => 'Copy response'});
    buttons.push(stop);
    observer.callback();
    setTimeout(() => {
      body.innerText = '[@alice | 互粉意向: 有 | 互粉标签: 互粉]';
      observer.callback();
      setTimeout(() => {
        buttons.splice(buttons.indexOf(stop), 1);
        const span = {innerText:'后续建议', textContent:'后续建议', closest:() => suggestion};
        suggestion = {innerText:'后续建议', getAttribute:() => null, querySelector:() => span};
        observer.callback();
      }, 20);
    }, 0);
  }};
  const stop = {innerText:'', getAttribute: name => name === 'aria-label' ? 'Stop generating' : null};
  let suggestion = null;
  const buttons = [send];
  const nonceLeaf = {children:[], textContent:'任务编号abc', compareDocumentPosition:() => 4};
  const body = {innerText:'prompt asking for @alice analysis'};
  globalThis.document = {
    body,
    documentElement:body,
    querySelector:() => input,
    querySelectorAll(selector) {
      if (selector === 'button') return [...buttons, ...(suggestion ? [suggestion] : [])];
      if (selector === 'button span.min-w-0.overflow-x-clip.text-ellipsis.whitespace-nowrap') return suggestion ? [suggestion.querySelector()] : [];
      if (selector === '*') return [nonceLeaf];
      return buttons;
    }
  };
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {}
    disconnect() {}
  };
  globalThis.InputEvent = class {};
  globalThis.Event = class {};
  try {
    const result = await submitGrokPromptAndWaitForCopyIconOnPage('analyze @alice\n任务编号abc', 1000, ['alice'], 5);
    assert.equal(result.submitted, true);
    assert.equal(result.completed, true);
    assert.match(result.text, /\[@alice \| 互粉意向: 有/);
  } finally {
    globalThis.document = previous.document;
    globalThis.MutationObserver = previous.MutationObserver;
    globalThis.InputEvent = previous.InputEvent;
    globalThis.Event = previous.Event;
  }
});

test('X Grok Copy message alone is not a completion signal; a later suggestion chip is', () => {
  const previous = {document:globalThis.document, location:globalThis.location};
  const nonce = '任务编号abc';
  const nonceLeaf = {children:[],textContent:nonce,compareDocumentPosition:() => 4};
  const copy = {getAttribute: name => name === 'aria-label' ? 'Copy message' : '',innerText:''};
  let suggestion = null;
  let stop = null;
  const body = {innerText:`${nonce}\n${START}完整评价内容${END}`};
  globalThis.location = {hostname:'x.com'};
  globalThis.document = {
    body,
    getElementById:() => ({ }),
    querySelector:() => body,
    querySelectorAll(selector) {
      if (selector === 'button') return [copy, ...(stop ? [stop] : []), ...(suggestion ? [suggestion] : [])];
      if (selector === '*') return [nonceLeaf];
      if (selector === 'button span.min-w-0.overflow-x-clip.text-ellipsis.whitespace-nowrap') return suggestion ? [suggestion.span] : [];
      return [];
    }
  };
  try {
    assert.equal(readGrokPageAnswer(nonce).done, false);
    suggestion = {innerText:'新建议',getAttribute:() => '',span:{innerText:'新建议',textContent:'新建议',closest:() => suggestion}};
    assert.equal(readGrokPageAnswer(nonce).done, true);
    stop = {getAttribute:name => name === 'aria-label' ? 'Stop generating' : '',innerText:''};
    assert.equal(readGrokPageAnswer(nonce).done, false);
  } finally {
    globalThis.document = previous.document;
    globalThis.location = previous.location;
  }
});

test('X Grok input accepts Lexical-normalized multiline text and sends after React input sync', async () => {
  const prompt = '测试 Grok 提示词\n\n附带任务凭证';
  const events = [];
  let value = '';
  const input = {
    tagName: 'DIV', innerText: '', textContent: '',
    getBoundingClientRect: () => ({width:556,height:48,top:100,bottom:148}),
    focus() { events.push('focus'); },
    dispatchEvent(event) { events.push(event.type); return true; }
  };
  let activeInput = input;
  const send = {
    disabled:false,
    getAttribute: name => name === 'aria-label' ? 'Send' : null,
    innerText:'',
    click() { events.push('send'); value=''; activeInput.innerText=''; activeInput.textContent=''; }
  };
  globalThis.window = {innerHeight:900};
  globalThis.document = {
    body:{},
    getElementById: () => ({contains: () => true}),
    querySelectorAll(selector) {
      if (selector === 'textarea,[contenteditable="true"]') return [activeInput];
      if (selector === 'button,[role="button"]') return [send];
      return [];
    },
    execCommand(command, _ui, text) {
      assert.equal(command, 'insertText');
      value = text; events.push('insertText');
      activeInput = {
        tagName:'DIV', innerText:text.replace(/\s+/g, ' '), textContent:text,
        getBoundingClientRect: () => ({width:556,height:48,top:100,bottom:148}),
        focus() { events.push('focus'); },
        dispatchEvent(event) { events.push(event.type); return true; }
      };
      activeInput.dispatchEvent(new Event('input', {bubbles:true}));
      return true;
    }
  };
  const result = await driveGrokInput(prompt);
  assert.deepEqual(result, {ok:true});
  assert.deepEqual(events, ['focus','insertText','input','send']);
  assert.equal(value, '');
});

test('publishQuotePostOnPage refuses when the page is not the target status page', async () => {
  globalThis.location = {pathname: '/someone/status/999'};
  globalThis.document = {querySelectorAll: () => [], querySelector: () => null};
  const res = await publishQuotePostOnPage('https://x.com/alice/status/123', '评价');
  assert.equal(res.ok, false);
  assert.match(res.reason, /不是目标原帖/);
  const empty = await publishQuotePostOnPage('https://x.com/alice/status/123', '  ');
  assert.equal(empty.ok, false);
});

test('dismissQuoteComposerOnPage only closes the draft for the requested source post', async () => {
  let closeClicks = 0;
  const closeButton = {click() { closeClicks++; }, getAttribute: () => 'Close', innerText: ''};
  const targetDialog = {
    querySelectorAll(selector) {
      if (selector === 'a') return [{href:'https://x.com/alice/status/123'}];
      if (selector === 'button') return [closeButton];
      return [];
    },
    querySelector: selector => selector === '[data-testid="app-bar-close"]' ? closeButton : null
  };
  globalThis.document = {querySelectorAll: selector => selector === '[role="dialog"]' ? [targetDialog] : []};
  const otherPost = await dismissQuoteComposerOnPage('https://x.com/alice/status/456');
  assert.deepEqual(otherPost, {ok:true, closed:false});
  assert.equal(closeClicks, 0);
  const targetPost = await dismissQuoteComposerOnPage('https://x.com/alice/status/123');
  assert.deepEqual(targetPost, {ok:true, closed:true});
  assert.equal(closeClicks, 1);
});

function makeQuotePage({embeddedOriginal = true, articleQuote = false, pageComposer = false} = {}) {
  globalThis.location = {pathname: '/alice/status/123'};
  globalThis.window = {innerHeight: 900};
  const events = [];
  let closed = false;
  let composerOpen = false;
  let reactInputSynced = false;
  const rect = (top, width, height) => ({top, bottom: top + height, width, height});
  const box = {
    innerText: '', getBoundingClientRect: () => rect(120, 500, 28),
    closest(selector) { return selector === '[role="dialog"]' ? (pageComposer ? null : dialog) : selector === 'main' ? (pageComposer ? main : null) : null; },
    focus() { events.push('focus'); },
    dispatchEvent(event) { if (event.type === 'input') { reactInputSynced = true; events.push('input'); } return true; }
  };
  const send = {
    get disabled() { return !reactInputSynced; },
    getAttribute: () => null,
    click() { events.push('publish'); closed = true; }
  };
  const quoteItem = {innerText: 'Quote', getBoundingClientRect: () => rect(160, 200, 40), click() { events.push('quote'); composerOpen = true; globalThis.location.pathname = '/compose/post'; }};
  const retweet = {click() { events.push('retweet'); }};
  const originalLink = {href: 'https://x.com/alice/status/123'};
  const sourceAuthor = {getAttribute: () => 'UserAvatar-Container-alice'};
  const currentAuthor = {getAttribute: () => 'UserAvatar-Container-me'};
  const embeddedAuthor = {getAttribute: () => 'UserAvatar-Container-alice'};
  const sourceText = {innerText: 'A post to quote'};
  const articleTitle = {innerText: 'An article to quote'};
  const embeddedText = {innerText: 'A post to quote'};
  const article = {
    querySelectorAll: selector => selector === 'a' ? [originalLink] : [],
    querySelector(selector) {
      if (selector === '[data-testid="retweet"]') return retweet;
      if (selector.includes('/status/123')) return originalLink;
      if (selector.includes('UserAvatar-Container-')) return sourceAuthor;
      if (selector === '[data-testid="tweetText"]') return articleQuote ? null : sourceText;
      if (selector === '[data-testid="twitter-article-title"]') return articleQuote ? articleTitle : null;
      return null;
    }
  };
  const dialog = {
    getBoundingClientRect: () => rect(50, 600, 640),
    contains: element => element === box,
    querySelectorAll(selector) {
      if (selector === '[data-testid="tweetTextarea_0"]') return composerOpen && !closed ? [box] : [];
      if (selector === 'a') return embeddedOriginal ? [originalLink] : [];
      if (selector.includes('UserAvatar-Container-')) return articleQuote ? [currentAuthor, embeddedAuthor] : [];
      return [];
    },
    innerText: articleQuote ? 'Quote\n@alice\nAn article to quote' : embeddedOriginal ? 'Quote\n@alice\nA post to quote' : 'Quote',
    querySelector(selector) {
    if (selector.includes('/status/123')) return embeddedOriginal ? originalLink : null;
    if (selector.includes('UserAvatar-Container-')) return currentAuthor;
    if (selector === '[data-testid="tweetText"]') return articleQuote ? embeddedText : null;
    if (selector === '[data-testid="tweetTextarea_0"]') return composerOpen && !closed ? box : null;
    if (selector === '[data-testid="tweetButton"]') return composerOpen && !closed ? send : null;
    return null;
  }};
  const hiddenDialog = {
    getBoundingClientRect: () => rect(0, 1920, 0),
    contains: element => element === box,
    querySelectorAll: selector => selector === '[data-testid="tweetTextarea_0"]' && composerOpen && !closed ? [box] : [],
    querySelector: selector => selector === '[data-testid="tweetTextarea_0"]' && composerOpen && !closed ? box : null
  };
  const main = {
    innerText: articleQuote ? 'Quote\n@alice\nAn article to quote' : embeddedOriginal ? 'Quote\n@alice\nA post to quote' : 'Quote',
    getBoundingClientRect: () => rect(10, 800, 700),
    querySelectorAll(selector) {
      if (selector === 'a') return embeddedOriginal ? [originalLink] : [];
      if (selector.includes('UserAvatar-Container-')) return articleQuote ? [currentAuthor, embeddedAuthor] : [];
      if (selector === '[data-testid="tweetTextarea_0"]') return composerOpen && !closed ? [box] : [];
      return [];
    },
    querySelector(selector) {
      if (selector === '[data-testid="app-bar-close"]') return composerOpen && !closed ? {click() { events.push('close'); closed = true; }} : null;
      if (selector === '[data-testid^="UserAvatar-Container-"]') return currentAuthor;
      if (selector === '[data-testid="tweetText"]') return articleQuote ? embeddedText : sourceText;
      if (selector === '[data-testid="tweetButton"]') return composerOpen && !closed ? send : null;
      return null;
    }
  };
  globalThis.document = {
    querySelectorAll(selector) {
      if (selector === 'article') return [article];
      if (selector === '[role="menuitem"]') return events.includes('retweet') ? [quoteItem] : [];
      if (selector === '[role="dialog"]') return !pageComposer && composerOpen && !closed ? [hiddenDialog, dialog] : [];
      if (selector === '[data-testid="tweetTextarea_0"]') return composerOpen && !closed ? [box] : [];
      if (selector === 'main') return pageComposer && composerOpen && !closed ? [main] : [];
      return [];
    },
    querySelector(selector) {
      if (selector === '[data-testid="toast"]') return null;
      return null;
    },
    execCommand(command, _ui, text) {
      assert.equal(command, 'insertText');
      box.innerText = text;
      events.push('type');
      reactInputSynced = true;
      events.push('input');
      return true;
    }
  };
  return {events};
}

test('publishQuotePostOnPage embeds the exact original and publishes through Quote', async () => {
  const {events} = makeQuotePage();
  await openQuoteComposerOnPage('https://x.com/alice/status/123');
  const inspected = inspectQuoteComposerOnPage('https://x.com/alice/status/123', 'A post to quote', 'alice');
  assert.equal(inspected.ready, true);
  const result = await publishQuotePostOnPage('https://x.com/alice/status/123', '有价值的引用评价内容', 'A post to quote', 'alice');
  assert.deepEqual(result, {ok: true, mode: 'quote'});
  assert.deepEqual(events, ['retweet', 'quote', 'focus', 'type', 'input', 'publish']);
});

test('Quote composer matching tolerates punctuation reshaping while still requiring the source author', async () => {
  makeQuotePage();
  await openQuoteComposerOnPage('https://x.com/alice/status/123');
  const result = inspectQuoteComposerOnPage('https://x.com/alice/status/123', 'A post: to? quote!', 'alice');
  assert.equal(result.ready, true);
});

test('quote composer on /compose/post is detected outside a dialog and React receives input', async () => {
  const {events} = makeQuotePage({pageComposer: true});
  await openQuoteComposerOnPage('https://x.com/alice/status/123');
  const inspected = inspectQuoteComposerOnPage('https://x.com/alice/status/123', 'A post to quote', 'alice');
  assert.equal(inspected.ready, true);
  const result = await publishQuotePostOnPage('https://x.com/alice/status/123', '有价值的引用评价内容', 'A post to quote', 'alice');
  assert.deepEqual(result, {ok: true, mode: 'quote'});
  assert.deepEqual(events, ['retweet', 'quote', 'focus', 'type', 'input', 'publish']);
});

test('an existing inline Reply composer does not suppress opening the Quote composer', async () => {
  globalThis.location = {pathname: '/alice/status/123'};
  globalThis.window = {innerHeight: 900};
  const events = [];
  const rect = {top:100,bottom:140,width:500,height:40};
  const originalLink = {href:'https://x.com/alice/status/123'};
  const replyBox = {
    getBoundingClientRect: () => rect,
    closest: selector => selector === 'main' ? replyMain : null
  };
  const replyMain = {
    innerText:'Replying to @alice\nA post to quote',
    getBoundingClientRect: () => ({top:0,bottom:800,width:800,height:800}),
    querySelectorAll: selector => selector === 'a' ? [originalLink] : []
  };
  const quoteItem = {innerText:'Quote',getBoundingClientRect:()=>rect,click(){events.push('quote');}};
  const retweet = {click(){events.push('retweet');}};
  const article = {
    querySelectorAll: selector => selector === 'a' ? [originalLink] : [],
    querySelector: selector => selector === '[data-testid="retweet"]' ? retweet : null
  };
  globalThis.document = {
    querySelectorAll(selector) {
      if (selector === '[data-testid="tweetTextarea_0"]') return [replyBox];
      if (selector === 'article') return [article];
      if (selector === '[role="menuitem"]') return events.includes('retweet') ? [quoteItem] : [];
      return [];
    }
  };
  const result = await openQuoteComposerOnPage('https://x.com/alice/status/123');
  assert.deepEqual(result, {ok:true,stage:'quote_selected'});
  assert.deepEqual(events, ['retweet','quote']);
});

test('failed quote draft on /compose/post can be dismissed without a dialog', async () => {
  const {events} = makeQuotePage({pageComposer: true});
  await openQuoteComposerOnPage('https://x.com/alice/status/123');
  const result = await dismissQuoteComposerOnPage('https://x.com/alice/status/123');
  assert.deepEqual(result, {ok:true, closed:true});
  assert.deepEqual(events, ['retweet', 'quote', 'close']);
});

test('Quote composer without the target original never becomes ready for publish', async () => {
  const {events} = makeQuotePage({embeddedOriginal: false});
  await openQuoteComposerOnPage('https://x.com/alice/status/123');
  const result = inspectQuoteComposerOnPage('https://x.com/alice/status/123', 'A post to quote', 'alice');
  assert.equal(result.ready, false);
  assert.equal(events.includes('publish'), false);
});

test('a main-column Reply composer is not mistaken for a verified Quote composer', () => {
  const targetLink = {href:'https://x.com/alice/status/123'};
  const sourceArticle = {
    innerText:'@alice A post to quote',
    querySelectorAll:() => [targetLink],
    querySelector:selector => selector === '[data-testid="tweetText"]' ? {innerText:'A post to quote'} : null
  };
  const main = {
    innerText:'@alice A post to quote\nReplying to @alice',
    getBoundingClientRect:() => ({width:800,height:700,top:0,bottom:700}),
    querySelectorAll:selector => selector === 'a' ? [targetLink] : selector === '[data-testid="tweetTextarea_0"]' ? [box] : [],
    querySelector:() => null
  };
  const box = {innerText:'',getBoundingClientRect:() => ({width:500,height:30,top:100,bottom:130}),closest:selector => selector === 'main' ? main : null};
  const previous = {document:globalThis.document,location:globalThis.location,window:globalThis.window};
  globalThis.location = {pathname:'/compose/post',href:'https://x.com/compose/post'};
  globalThis.window = {innerHeight:900};
  globalThis.document = {
    querySelectorAll:selector => selector === 'article' ? [sourceArticle] : selector === '[data-testid="tweetTextarea_0"]' ? [box] : selector === 'main' ? [main] : [],
    querySelector:() => null
  };
  try {
    const result = inspectQuoteComposerOnPage('https://x.com/alice/status/123','A post to quote','alice');
    assert.equal(result.ready,false);
  } finally {
    globalThis.document = previous.document;
    globalThis.location = previous.location;
    globalThis.window = previous.window;
  }
});

test('publishQuotePostOnPage verifies X article quotes by matching the source author and article title', async () => {
  const {events} = makeQuotePage({embeddedOriginal: false, articleQuote: true});
  await openQuoteComposerOnPage('https://x.com/alice/status/123');
  const inspected = inspectQuoteComposerOnPage('https://x.com/alice/status/123', 'An article to quote', 'alice');
  assert.equal(inspected.ready, true);
  const result = await publishQuotePostOnPage('https://x.com/alice/status/123', '对原帖的评价', 'An article to quote', 'alice');
  assert.deepEqual(result, {ok: true, mode: 'quote'});
  assert.equal(events.includes('publish'), true);
});

test('postQuoteOnTab recovers when choosing Quote navigates away and destroys the injected page context', async () => {
  const calls = [];
  const targetUrl = 'https://x.com/alice/status/123';
  globalThis.chrome = {
    tabs: {
      update: async (_tabId, update) => { calls.push('navigate:' + update.url); },
      get: async () => ({status: 'complete', url: 'https://x.com/compose/post'})
    },
    scripting: {
      executeScript: async ({func}) => {
        calls.push(func.name);
        if (func === openQuoteComposerOnPage) throw new Error('Execution context was destroyed by X route change');
        if (func.name === 'inspectQuoteComposerOnPage') return [{result: {ok: true, ready: true, originalUrl: targetUrl}}];
        if (func === publishQuotePostOnPage) return [{result: {ok: true, mode: 'quote'}}];
        return [];
      }
    }
  };
  const result = await postQuoteOnTab(1, {url: targetUrl}, '引用评价文本', publishQuotePostOnPage, async () => {});
  assert.deepEqual(result, {ok: true, mode: 'quote'});
  assert.deepEqual(calls, [
    'navigate:' + targetUrl,
    'openQuoteComposerOnPage',
    'inspectQuoteComposerOnPage',
    'publishQuotePostOnPage'
  ]);
});
