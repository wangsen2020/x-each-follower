import test from 'node:test';
import assert from 'node:assert/strict';
import {extractGrokComment, buildGrokCommentPrompt, tweetWeight, makeNonce, START, END, postQuoteOnTab, buildBackgroundGrokWindowOptions, submitGrokPromptAndWaitForCopyIconOnPage, driveGrokInput, createStableAnswerGate, readGrokPageAnswer, appendFollowBackSuffix} from '../grok-comment.js';
import {openQuoteComposerOnPage, inspectQuoteComposerOnPage, publishQuotePostOnPage, dismissQuoteComposerOnPage} from '../page-reader.js';

test('queue publication fence stops sending after composer is ready and closes owned popup',async()=>{
  const prior=globalThis.chrome, closed=[];
  let published=false;
  const url='https://x.com/alice/status/123';
  globalThis.chrome={storage:{session:{set:async()=>{},remove:async()=>{}}},windows:{create:async()=>({id:8,tabs:[{id:80}]}),remove:async id=>closed.push(id)},
    tabs:{update:async()=>{},get:async()=>({status:'complete'})},
    scripting:{executeScript:async({func})=>{
      if(func===inspectQuoteComposerOnPage)return [{result:{ok:true,ready:true,originalUrl:url}}];
      if(func===publishQuotePostOnPage)published=true;
      return [];
    }}};
  try {
    const result=await postQuoteOnTab(1,{url},'引用内容',publishQuotePostOnPage,async()=>{},
      {beforePublish:async()=>{throw new Error('队列已暂停');}});
    assert.equal(result.ok,false); assert.match(result.reason,/暂停/);
    assert.equal(published,false); assert.deepEqual(closed,[8]);
  } finally {globalThis.chrome=prior;}
});

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

test('quote prompt seeks a specific, debatable angle without fabricating facts', () => {
  const prompt = buildGrokCommentPrompt({handle: 'alice', name: 'Alice', postText: '今天发布了新版本', nonce: 'task-1'});
  assert.match(prompt, /原帖一个具体细节/);
  assert.match(prompt, /反常识、隐性代价或矛盾/);
  assert.match(prompt, /鲜明判断.*尖锐、有情绪张力/);
  assert.match(prompt, /不能夸大事实、数字或编造动机/);
  assert.match(prompt, /无争议就别硬造/);
  assert.match(prompt, /只写一句完整评价/);
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

test('X Grok complete delimiters do not require suggestions, but an active Stop still blocks completion', () => {
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
    assert.equal(readGrokPageAnswer(nonce).done, true);
    suggestion = {innerText:'新建议',getAttribute:() => '',span:{innerText:'新建议',textContent:'新建议',closest:() => suggestion}};
    assert.equal(readGrokPageAnswer(nonce).done, true);
    stop = {getAttribute:name => name === 'aria-label' ? 'Stop generating' : '',innerText:''};
    assert.equal(readGrokPageAnswer(nonce).done, false);
    stop = {getAttribute:name => name === 'aria-label' ? 'Stop response' : '',innerText:''};
    assert.equal(readGrokPageAnswer(nonce).done, false);
    assert.equal(readGrokPageAnswer(nonce).stillGenerating, true);
  } finally {
    globalThis.document = previous.document;
    globalThis.location = previous.location;
  }
});

test('X Grok input accepts Lexical-normalized multiline text and sends after React input sync', async () => {
  const prompt = '测试 Grok 提示词\n\nS\n\n附带任务凭证';
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
      assert.ok(!/[\r\n]/.test(text), 'multiline insert must not reach Lexical');
      assert.ok(text.includes('S'), 'isolated paragraph character must survive');
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

function makeQuotePage({embeddedOriginal = true, articleQuote = false, pageComposer = false, quoteLabel = true, longPost = false} = {}) {
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
  let actionsVisible = !longPost;
  const quoteItem = {innerText: 'Quote', getBoundingClientRect: () => rect(actionsVisible ? 160 : 1800, 200, 40), click() { events.push('quote'); composerOpen = true; globalThis.location.pathname = '/compose/post'; }};
  const retweet = {scrollIntoView() { actionsVisible = true; }, click() { events.push('retweet'); }};
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
    innerText: articleQuote ? `${quoteLabel ? 'Quote\n' : ''}@alice\nAn article to quote` : embeddedOriginal ? `${quoteLabel ? 'Quote\n' : ''}@alice\nA post to quote` : 'Quote',
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

test('Quote menu on a long post is brought into view before selecting it', async () => {
  const {events} = makeQuotePage({longPost: true});
  const result = await openQuoteComposerOnPage('https://x.com/alice/status/123');
  assert.equal(result.ok, true);
  assert.deepEqual(events, ['retweet', 'quote']);
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

test('a linkless X article quote is publishable before the Quote label appears', async () => {
  const {events} = makeQuotePage({embeddedOriginal: false, articleQuote: true, quoteLabel: false});
  await openQuoteComposerOnPage('https://x.com/alice/status/123');
  const inspected = inspectQuoteComposerOnPage('https://x.com/alice/status/123', 'The full article text is not displayed in the card', 'alice');
  assert.equal(inspected.ready, true);
  const result = await publishQuotePostOnPage('https://x.com/alice/status/123', '有观点的引用评价', 'The full article text is not displayed in the card', 'alice');
  assert.deepEqual(result, {ok: true, mode: 'quote'});
  assert.equal(events.includes('publish'), true);
});

test('postQuoteOnTab recovers when choosing Quote navigates away and destroys the injected page context', async () => {
  const calls = [];
  const targetUrl = 'https://x.com/alice/status/123';
  globalThis.chrome = {
    storage:{session:{set:async()=>{},remove:async()=>{}}},
    windows: {
      create: async options => { calls.push('window:' + options.url); return {id: 9, tabs:[{id: 88}]}; },
      remove: async id => { calls.push('close:' + id); }
    },
    tabs: {
      update: async (id, update) => {assert.equal(id, 88); calls.push('navigate:' + update.url);},
      get: async () => ({status: 'complete', url: 'https://x.com/compose/post'})
    },
    scripting: {
      executeScript: async ({target, func}) => {
        assert.equal(target.tabId, 88, 'quote actions must use the temporary popup tab');
        calls.push(func.name);
        if (func === openQuoteComposerOnPage) throw new Error('Execution context was destroyed by X route change');
        if (func.name === 'inspectQuoteComposerOnPage') return [{result: {ok: true, ready: true, originalUrl: targetUrl}}];
        if (func === publishQuotePostOnPage) return [{result: {ok: true, mode: 'quote'}}];
        return [];
      }
    }
  };
  const waits = [];
  const result = await postQuoteOnTab(1, {url: targetUrl}, '引用评价文本', publishQuotePostOnPage, async ms => {waits.push(ms);});
  assert.deepEqual(result, {ok: true, mode: 'quote'});
  assert.ok(waits.some(ms => ms >= 5500 && ms < 7500), 'wait for X React hydration before choosing Quote');
  assert.deepEqual(calls, [
    'window:' + targetUrl,
    'navigate:' + targetUrl,
    'setQuoteFrameFallbackOnPage',
    'openQuoteComposerOnPage',
    'inspectQuoteComposerOnPage',
    'publishQuotePostOnPage',
    'setQuoteFrameFallbackOnPage',
    'close:9'
  ]);
});

test('postQuoteOnTab closes its popup after a failed publish without touching the caller tab', async () => {
  const calls = [];
  const url = 'https://x.com/alice/status/123';
  globalThis.chrome = {
    storage:{session:{set:async()=>{},remove:async()=>{}}},
    windows: {
      create: async () => ({id: 9, tabs:[{id: 88}]}),
      remove: async id => {calls.push('close:' + id);}
    },
    tabs: {update: async id => {assert.equal(id, 88);}, get: async () => ({status:'complete', url})},
    scripting: {executeScript: async ({target, func}) => {
      assert.equal(target.tabId, 88);
      if (func === openQuoteComposerOnPage) return [{result:{ok:true, stage:'quote_selected'}}];
      if (func.name === 'inspectQuoteComposerOnPage') return [{result:{ok:true, ready:true, originalUrl:url}}];
      if (func === publishQuotePostOnPage) return [{result:{ok:false, reason:'X 拒绝发布'}}];
      if (func.name === 'dismissQuoteComposerOnPage') {calls.push('dismiss'); return [{result:{ok:true, closed:true}}];}
      return [];
    }}
  };
  const result = await postQuoteOnTab(1, {url}, '引用评价文本', publishQuotePostOnPage, async () => {});
  assert.deepEqual(result, {ok:false, reason:'X 拒绝发布'});
  assert.deepEqual(calls, ['dismiss', 'close:9']);
});

test('postQuoteOnTab retries a blank X quote shell once and closes both popups', async () => {
  const url = 'https://x.com/alice/status/123';
  const created = [], closed = [];
  const now = Date.now;
  let clock = 100000;
  Date.now = () => clock;
  globalThis.chrome = {
    storage:{session:{set:async()=>{},remove:async()=>{}}},
    windows: {
      create: async () => {const id = created.length + 1; created.push(id); return {id, tabs:[{id:80 + id}]};},
      remove: async id => {closed.push(id);}
    },
    tabs: {update: async () => {}, get: async () => ({status:'complete', url})},
    scripting: {executeScript: async ({target, func}) => {
      if (func === openQuoteComposerOnPage) return [{result:{ok:true, stage:'quote_selected'}}];
      if (func.name === 'inspectQuoteComposerOnPage') return [{result:target.tabId === 81
        ? {ok:true, ready:false, reason:'等待 X 的引用帖编辑框及原帖卡片'}
        : {ok:true, ready:true, originalUrl:url}}];
      if (func === publishQuotePostOnPage) return [{result:{ok:true, mode:'quote'}}];
      return [{result:{ok:true, closed:true}}];
    }}
  };
  try {
    const result = await postQuoteOnTab(1, {url}, '引用评价文本', publishQuotePostOnPage, async ms => {clock += ms;});
    assert.deepEqual(result, {ok:true, mode:'quote'});
    assert.deepEqual(created, [1, 2]);
    assert.deepEqual(closed, [1, 2]);
  } finally {
    Date.now = now;
  }
});

test('appendFollowBackSuffix appends "有关必回" with appropriate punctuation', () => {
  assert.equal(appendFollowBackSuffix('这是一个好观点'), '这是一个好观点。有关必回');
  assert.equal(appendFollowBackSuffix('这是一个好观点。'), '这是一个好观点。有关必回');
  assert.equal(appendFollowBackSuffix('难道不是这样吗？'), '难道不是这样吗？有关必回');
  assert.equal(appendFollowBackSuffix('太棒了！'), '太棒了！有关必回');
});

test('appendFollowBackSuffix avoids duplicate suffix if already present', () => {
  assert.equal(appendFollowBackSuffix('真知灼见。有关必回'), '真知灼见。有关必回');
  assert.equal(appendFollowBackSuffix('欢迎交流，关注必回！'), '欢迎交流，关注必回！');
  assert.equal(appendFollowBackSuffix('互关必回的朋友看这里'), '互关必回的朋友看这里');
  assert.equal(appendFollowBackSuffix(''), '');
});

test('appendFollowBackSuffix trims base to keep result within X character weight limit', () => {
  const longText = '这是超长内容'.repeat(50);
  const result = appendFollowBackSuffix(longText);
  assert.ok(result.endsWith('有关必回'));
  assert.ok(tweetWeight(result) <= 280);
});

test('readGrokPageAnswer reliably detects completion when prompt has nested elements/tags and response has Regenerate/Copy action buttons', () => {
  const previous = {document:globalThis.document, location:globalThis.location};
  const nonce = '任务编号mvf1hkgql8vp';
  // Nested prompt structure: div containing hashtag link and text node
  const promptContainer = {
    children: [{textContent:'#蓝V', children:[]}],
    textContent: `#蓝V #真诚互动 #交朋友 62 33 1,525 ${nonce}`,
    compareDocumentPosition: () => 4
  };
  const copyMessage = {getAttribute: name => name === 'aria-label' ? 'Copy message' : '', innerText:''};
  const regenerateBtn = {getAttribute: name => name === 'aria-label' ? 'Regenerate' : '', innerText:''};
  const body = {innerText:`${nonce}\n${START}一边嫌弃粉丝列表里的死数字，一边置顶公开征集蓝V留脚印，真心成了另一种可被审核的流量入口。${END}\n【评价语言:zh】`};

  globalThis.location = {hostname:'x.com'};
  globalThis.document = {
    body,
    getElementById: () => ({}),
    querySelector: () => body,
    querySelectorAll(selector) {
      if (selector === 'button') return [copyMessage, regenerateBtn];
      if (selector === '*') return [promptContainer];
      return [];
    }
  };

  try {
    const res = readGrokPageAnswer(nonce);
    assert.equal(res.done, true);
    assert.match(res.text, /一边嫌弃粉丝列表里的死数字/);
    assert.equal(extractGrokComment(res.text), '一边嫌弃粉丝列表里的死数字，一边置顶公开征集蓝V留脚印，真心成了另一种可被审核的流量入口。');
  } finally {
    globalThis.document = previous.document;
    globalThis.location = previous.location;
  }
});


test('Grok preparation error retains popup with idle lease and records the actual cause', async () => {
 const {openMinimized} = await import('../grok-comment.js');
 const previous = {chrome:globalThis.chrome,document:globalThis.document};
 const data={};let removed=0;
 delete globalThis.document;
 globalThis.chrome={
  storage:{local:{get:async()=>({}),set:async value=>Object.assign(data,value)},session:{
   get:async key=>key?{[key]:data[key]}:{...data},set:async value=>Object.assign(data,value),remove:async key=>delete data[key]}},
  windows:{getAll:async()=>[],create:async()=>({id:501,type:'popup',tabs:[{id:502,url:'https://x.com/i/grok'}]}),remove:async()=>{removed++;}},
  tabs:{get:async()=>{throw Error('No frame with id 0 in tab 502');}},
  scripting:{executeScript:async()=>[]}
 };
 try {
  await assert.rejects(openMinimized('https://x.com/i/grok'),/No frame with id 0/);
  assert.equal(removed,0);
  assert.equal(data.xfGrokWindowPreparationError.windowId,501);
  assert.match(data.xfGrokWindowPreparationError.reason,/No frame with id 0/);
  assert.equal(data['xfTemporaryWindow:501'].busyUntil,0);
  assert.ok(data['xfTemporaryWindow:501'].expiresAt>Date.now());
 } finally {globalThis.chrome=previous.chrome;if(previous.document===undefined)delete globalThis.document;else globalThis.document=previous.document;}
});

function xTurnFixture({splitNonce=false, echoNonce=false, stop='hidden', actions=true, nonce='任务编号turn123'}={}) {
 const old={document:globalThis.document,getComputedStyle:globalThis.getComputedStyle};
 const action={getAttribute:name=>name==='aria-label'?'Copy':null};
 const stopButton={disabled:stop==='disabled',hidden:false,parentElement:null,
  getAttribute:name=>name==='aria-label'?'Stop':null,getClientRects:()=>stop==='hidden'?[]:[{}]};
 const answer=`${START}已生成并完成的真实评价正文${END}\n【评价语言:zh】${echoNonce?'\n'+nonce:''}`;
 const message={querySelectorAll:selector=>selector==='.grok-trace-soft-enter'?[{textContent:answer}]:actions?[action]:[]};
 const turn={getAttribute:()=> 'turn-123',querySelector:()=>message,
  querySelectorAll:selector=>selector==='button, [role="button"]'?actions?[action]:[]:[{textContent:splitNonce?nonce.replace('turn','tu\nrn'):nonce}]};
 globalThis.document={querySelectorAll:selector=>selector==='[data-turn-id]'?[turn]:[stopButton]};
 globalThis.getComputedStyle=()=>({display:'block',visibility:'visible'});
 return {answer,read:()=>readGrokPageAnswer(nonce),restore:()=>{
  globalThis.document=old.document;if(old.getComputedStyle===undefined)delete globalThis.getComputedStyle;else globalThis.getComputedStyle=old.getComputedStyle;
 }};
}

test('X turn reader reads only assistant body when the task nonce is split or echoed after the answer',()=>{
 const f=xTurnFixture({splitNonce:true,echoNonce:true});
 try {const result=f.read();assert.equal(result.done,true);assert.equal(result.source,'x-turn');assert.equal(result.text,f.answer);
  assert.equal(extractGrokComment(result.text),'已生成并完成的真实评价正文');assert.equal(result.visibleStopCount,0);
 } finally {f.restore();}
});

test('hidden or disabled Stop cannot keep a completed X answer generating forever',()=>{
 for(const stop of ['hidden','disabled']){const f=xTurnFixture({stop});try{assert.equal(f.read().done,true);assert.equal(f.read().stillGenerating,false);}finally{f.restore();}}
});

test('visible Stop blocks X completion while a fully delimited answer does not require actions',()=>{
 let f=xTurnFixture({stop:'visible'});try{assert.equal(f.read().done,false);assert.equal(f.read().stage,'generating');}finally{f.restore();}
 f=xTurnFixture({actions:false});try{assert.equal(f.read().done,true);assert.equal(f.read().stage,'complete');}finally{f.restore();}
});

test('X transcript refuses another turn when the requested nonce is absent',()=>{
 const old=globalThis.document;
 globalThis.document={querySelectorAll:()=>[{querySelectorAll:()=>[{textContent:'任务编号other'}]}]};
 try{assert.deepEqual(readGrokPageAnswer('任务编号missing'),{text:'',done:false,stage:'nonce_missing',source:'x-turn'});}finally{globalThis.document=old;}
});

test('X polling completes a stable answer without recommendations or toolbar actions',async()=>{
 const {createGrokAnswerGate}=await import('../grok-comment.js');const gate=createGrokAnswerGate(6,5);
 const state={text:`${START}没有推荐问题也能正确读取完整回答${END}`,done:false,stillGenerating:false,contentSignature:'same-dom'};
 for(let i=0;i<4;i++)assert.equal(gate(state,extractGrokComment(state.text)),'');
 assert.equal(gate(state,extractGrokComment(state.text)),'stable-content');
});

test('X stable-content polling resets on DOM updates and never completes an active stream or malformed quote',async()=>{
 const {createGrokAnswerGate}=await import('../grok-comment.js');const gate=createGrokAnswerGate(6,5);
 const state={text:`${START}仍然需要等待的完整评价正文${END}`,done:false,stillGenerating:false,contentSignature:'a'};
 const reply=extractGrokComment(state.text);
 for(let i=0;i<4;i++)assert.equal(gate(state,reply),'');
 assert.equal(gate({...state,contentSignature:'b'},reply),'');
 for(let i=0;i<6;i++)assert.equal(gate({...state,stillGenerating:true},reply),'');
 for(let i=0;i<6;i++)assert.equal(gate(state,''),'');
 for(let i=0;i<4;i++)assert.equal(gate(state,reply),'');
 assert.equal(gate(state,reply),'stable-content');
});

test('correlated successful network EOF can finish despite a stale Stop, while network silence cannot',async()=>{
 const {createGrokAnswerGate}=await import('../grok-comment.js');
 let gate=createGrokAnswerGate();const state={text:'完整回答正文',done:false,stillGenerating:true,network:{status:'streaming',quietForMs:60000}};
 for(let i=0;i<10;i++)assert.equal(gate(state,state.text),'');
 gate=createGrokAnswerGate();
 for(let i=0;i<3;i++)assert.equal(gate({...state,network:{status:'complete'}},state.text),'');
 assert.equal(gate({...state,network:{status:'complete'}},state.text),'network-eof');
 gate=createGrokAnswerGate();
 for(let i=0;i<8;i++)assert.equal(gate({...state,network:{status:'error'}},state.text),'');
});

test('X uses the correlated WebSocket response.done as its completion method',async()=>{
 const {createGrokAnswerGate}=await import('../grok-comment.js');const gate=createGrokAnswerGate();
 const state={text:'完整回答正文',done:false,stillGenerating:true,network:{status:'complete',transport:'websocket'}};
 for(let i=0;i<3;i++)assert.equal(gate(state,state.text),'');
 assert.equal(gate(state,state.text),'network-response.done');
});

test('valid quote end marker completes without recommendations or action buttons',async()=>{
 const {createGrokAnswerGate}=await import('../grok-comment.js');const gate=createGrokAnswerGate(2,3);
 const state={text:`${START}明确的结束标记足以确认这段完整评价已经生成完毕${END}`,done:false,stillGenerating:false};
 const answer=extractGrokComment(state.text);
 assert.equal(gate(state,answer),'');
 assert.equal(gate(state,answer),'end-marker');
});
