import test from 'node:test';
import assert from 'node:assert/strict';

import vm from 'node:vm';
import { readTemporaryWindowOwnerOnPage } from '../temporary-windows.js';
import {
  createDefaultSessionState,
  extractCanonicalGrokUrl,
  computeEmailHash,
  inspectGrokComAccountIdentityOnPage,
  findVisibleGrokComInputOnPage,
  inspectGrokComPageBeforeSubmitOnPage,
  snapshotGrokComRecommendationsOnPage,
  confirmGrokComPromptAcceptedOnPage,
  readGrokComTurnAnswerOnPage,
  deleteGrokComCurrentConversationOnPage,
  verifyGrokComDeletionProofOnPage,
  confirmGrokComDeletionOnPage,
  probeGrokComPageOnPage,
  getGrokSessionState,
  saveGrokSessionState,
  resetGrokSessionState,
  rotateGrokConversation,
  ensureGrokPersistentWindow,
  recoverGrokSessionOnStartup,
  executeGrokComTask,
  handleGrokSessionAction,
  probeGrokSessionAvailability,
  confirmGrokWindowOwnership,
  DEFAULT_GROK_SESSION_LIMIT
} from '../grok-session-manager.js';
import { createBackgroundGrokWindow } from '../grok-comment.js';

test('createDefaultSessionState sets expected initial state and bounds', () => {
  const state = createDefaultSessionState();
  assert.equal(state.acceptedCount, 0);
  assert.equal(state.limit, 50);
  assert.equal(state.state, 'absent');
  assert.equal(state.createdByExtension, false);
  assert.equal(state.conversationId, null);
  assert.equal(state.generation, 1);
  assert.equal(state.ownerKey, null);
});

test('extractCanonicalGrokUrl extracts conversationId and removes rid query parameters', () => {
  const result = extractCanonicalGrokUrl('https://grok.com/c/94cc8afa-4583-479e-a979-b568d127adfd?rid=some-response-uuid');
  assert.ok(result);
  assert.equal(result.conversationId, '94cc8afa-4583-479e-a979-b568d127adfd');
  assert.equal(result.canonicalUrl, 'https://grok.com/c/94cc8afa-4583-479e-a979-b568d127adfd');
  assert.equal(result.pathname, '/c/94cc8afa-4583-479e-a979-b568d127adfd');

  assert.equal(extractCanonicalGrokUrl('https://x.com/home'), null);
  assert.equal(extractCanonicalGrokUrl('https://grok.com/'), null);
  assert.equal(extractCanonicalGrokUrl(null), null);
});

test('computeEmailHash produces deterministic hash without revealing raw email', () => {
  const hash1 = computeEmailHash('TestUser@Example.COM');
  const hash2 = computeEmailHash('testuser@example.com ');
  assert.ok(hash1.startsWith('ghash_'));
  assert.equal(hash1, hash2);
  assert.equal(hash1.includes('testuser'), false);
  assert.equal(computeEmailHash(''), null);
});

test('inspectGrokComAccountIdentityOnPage reads email from menu, computes hash and safely closes menu', async () => {
  const prevLoc = globalThis.location;
  const prevDoc = globalThis.document;
  try {
    globalThis.location = { hostname: 'grok.com', pathname: '/' };
    let menuOpened = false;
    let menuClosed = false;

    const accountBtn = {
      getAttribute: key => key === 'aria-label' ? 'Account menu, Watson Taylor' : null,
      click: () => { menuOpened = true; },
      dispatchEvent: evt => { if (evt?.key === 'Escape') menuClosed = true; }
    };
    const menuEl = {
      innerText: 'watson.taylor@example.com\n设置\n帮助\n退出登陆'
    };

    globalThis.document = {
      querySelector: sel => {
        if (sel.includes('Account menu')) return accountBtn;
        if (sel.includes('[role="menu"]')) return menuOpened ? menuEl : null;
        return null;
      },
      body: { click: () => { menuClosed = true; } }
    };

    const res = await inspectGrokComAccountIdentityOnPage();
    assert.equal(res.ok, true);
    assert.ok(res.ownerKey.startsWith('ghash_'));
    assert.equal(res.ownerKey.includes('watson'), false);
    assert.equal(res.accountLabel, 'Account menu, Watson Taylor');
    assert.equal(menuOpened, true);
    assert.equal(menuClosed, true);

    menuOpened = false;
    menuClosed = false;
    let shown = false;
    globalThis.document = {
      querySelector: sel => {
        if (sel.includes('Account menu')) return accountBtn;
        if (sel.includes('[role="menu"]')) return shown ? { innerText: 'not-an-email\n设置\n帮助\n退出登陆' } : null;
        return null;
      },
      body: { click: () => { menuClosed = true; } }
    };
    accountBtn.click = () => { menuOpened = true; setTimeout(() => { shown = true; }, 60); };
    globalThis.document = {
      querySelector: sel => {
        if (sel.includes('Account menu')) return accountBtn;
        if (sel.includes('[role="menu"]')) return shown ? { innerText: 'later.user@example.com\n设置\n帮助\n退出登陆' } : null;
        return null;
      },
      body: { click: () => { menuClosed = true; } }
    };
    const delayed = await inspectGrokComAccountIdentityOnPage();
    assert.equal(delayed.ok, true);
    assert.ok(delayed.ownerKey.startsWith('ghash_'));
    assert.equal(delayed.ownerKey.includes('later.user'), false);

    globalThis.document = {
      querySelector: sel => {
        if (sel.includes('Account menu')) return accountBtn;
        if (sel.includes('[role="menu"]')) return { innerText: 'Watson Taylor\n设置\n帮助\n退出登陆' };
        return null;
      },
      body: { click: () => {} }
    };
    const noEmail = await inspectGrokComAccountIdentityOnPage();
    assert.equal(noEmail.ok, false);
  } finally {
    globalThis.location = prevLoc;
    globalThis.document = prevDoc;
  }
});

test('findVisibleGrokComInputOnPage prefers visible editable and skips hidden textarea', () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  try {
    const hiddenTextarea = {
      tagName: 'TEXTAREA',
      offsetParent: null,
      getBoundingClientRect: () => ({ width: 0, height: 0 })
    };
    const visibleEditable = {
      tagName: 'DIV',
      className: 'tiptap ProseMirror',
      offsetParent: {},
      getClientRects: () => [{ width: 500, height: 40 }],
      getBoundingClientRect: () => ({ width: 500, height: 40 })
    };

    globalThis.window = {
      getComputedStyle: el => el === hiddenTextarea ? { display: 'none', visibility: 'hidden' } : { display: 'block', visibility: 'visible' }
    };
    globalThis.document = {
      querySelector: sel => {
        if (sel.includes('tiptap')) return visibleEditable;
        return null;
      },
      querySelectorAll: () => [hiddenTextarea, visibleEditable]
    };

    const found = findVisibleGrokComInputOnPage();
    assert.equal(found, visibleEditable);
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});

test('inspectGrokComPageBeforeSubmitOnPage protects user drafts and checks conversation matching', () => {
  const prevLoc = globalThis.location;
  const prevDoc = globalThis.document;
  try {
    globalThis.location = { hostname: 'grok.com', pathname: '/c/conv-123', href: 'https://grok.com/c/conv-123' };

    const draftInput = {
      tagName: 'DIV',
      offsetParent: {},
      innerText: '用户正在手写的草稿内容'
    };
    globalThis.document = {
      querySelector: sel => sel.includes('contenteditable') ? draftInput : null,
      querySelectorAll: () => [draftInput]
    };

    const draftRes = inspectGrokComPageBeforeSubmitOnPage('任务编号abc', 'conv-123');
    assert.equal(draftRes.ok, false);
    assert.equal(draftRes.userDraftDetected, true);
    assert.match(draftRes.reason, /用户草稿/);

    const cleanInput = {
      tagName: 'DIV',
      offsetParent: {},
      innerText: ''
    };
    globalThis.document = {
      querySelector: sel => sel.includes('contenteditable') ? cleanInput : null,
      querySelectorAll: () => [cleanInput]
    };

    const switchedRes = inspectGrokComPageBeforeSubmitOnPage('任务编号abc', 'conv-OTHER');
    assert.equal(switchedRes.ok, false);
    assert.equal(switchedRes.switchedConversation, true);
    assert.match(switchedRes.reason, /暂停自动提交/);

    const normalRes = inspectGrokComPageBeforeSubmitOnPage('任务编号abc', 'conv-123');
    assert.equal(normalRes.ok, true);
    assert.equal(normalRes.currentConvId, 'conv-123');

    globalThis.location = { hostname: 'grok.com', pathname: '/', href: 'https://grok.com/' };
    const homepageRes = inspectGrokComPageBeforeSubmitOnPage('任务编号abc', 'conv-123');
    assert.equal(homepageRes.ok, false);
    assert.equal(homepageRes.switchedConversation, true);

    globalThis.location = { hostname: 'grok.com', pathname: '/c/conv-123', href: 'https://grok.com/c/conv-123' };
    const unexpectedRes = inspectGrokComPageBeforeSubmitOnPage('任务编号abc', null);
    assert.equal(unexpectedRes.ok, false);
    assert.equal(unexpectedRes.switchedConversation, true);
  } finally {
    globalThis.location = prevLoc;
    globalThis.document = prevDoc;
  }
});

test('confirmGrokComPromptAcceptedOnPage requires exact user-message outside composer AND /c/UUID', () => {
  const prevLoc = globalThis.location;
  const prevDoc = globalThis.document;
  try {
    const nonce = '任务编号StrictConfirm';

    // 1. Missing user bubble: input cleared alone must NOT accept
    globalThis.location = { hostname: 'grok.com', pathname: '/c/conv-abc', href: 'https://grok.com/c/conv-abc' };
    const composer = {
      tagName: 'DIV',
      contains: () => false
    };
    globalThis.document = {
      querySelectorAll: sel => {
        if (sel.includes('composer') || sel.includes('contenteditable')) return [composer];
        if (sel.includes('user-message')) return [];
        return [];
      }
    };
    const missingRes = confirmGrokComPromptAcceptedOnPage(nonce);
    assert.equal(missingRes.accepted, false);
    assert.equal(missingRes.hasUserBubbleOutsideComposer, false);

    // 2. Nonce bubble inside composer: must NOT accept
    const bubbleInsideComposer = {
      textContent: `Prompt with ${nonce}`,
      getAttribute: () => 'user-message'
    };
    const activeComposer = {
      tagName: 'DIV',
      contains: el => el === bubbleInsideComposer
    };
    globalThis.document = {
      querySelectorAll: sel => {
        if (sel.includes('composer') || sel.includes('contenteditable')) return [activeComposer];
        if (sel.includes('user-message')) return [bubbleInsideComposer];
        return [];
      }
    };
    const insideRes = confirmGrokComPromptAcceptedOnPage(nonce);
    assert.equal(insideRes.accepted, false);
    assert.equal(insideRes.hasUserBubbleOutsideComposer, false);

    // 3. User bubble outside composer BUT URL is still homepage (not /c/UUID): must NOT accept
    globalThis.location = { hostname: 'grok.com', pathname: '/', href: 'https://grok.com/' };
    const validBubble = {
      textContent: `Prompt with ${nonce}`,
      getAttribute: () => 'user-message'
    };
    globalThis.document = {
      querySelectorAll: sel => {
        if (sel.includes('composer') || sel.includes('contenteditable')) return [composer];
        if (sel.includes('user-message')) return [validBubble];
        return [];
      }
    };
    const noUrlRes = confirmGrokComPromptAcceptedOnPage(nonce);
    assert.equal(noUrlRes.accepted, false);
    assert.equal(noUrlRes.hasUserBubbleOutsideComposer, true);
    assert.equal(noUrlRes.conversationId, null);

    // 4. Valid user bubble outside composer AND /c/UUID in URL: accepted!
    globalThis.location = { hostname: 'grok.com', pathname: '/c/valid-uuid-123', href: 'https://grok.com/c/valid-uuid-123' };
    const validRes = confirmGrokComPromptAcceptedOnPage(nonce);
    assert.equal(validRes.accepted, true);
    assert.equal(validRes.hasUserBubbleOutsideComposer, true);
    assert.equal(validRes.conversationId, 'valid-uuid-123');
  } finally {
    globalThis.location = prevLoc;
    globalThis.document = prevDoc;
  }
});

test('completion requirement: copy/regenerate alone false, old recommendations false, current new recommendations true only with stable nonempty reply', () => {
  const prevDoc = globalThis.document;
  try {
    const nonce = '任务编号RecTest';

    const userMsg = {
      getAttribute: key => key === 'data-testid' ? 'user-message' : null,
      textContent: `Prompt ${nonce}`,
      nextElementSibling: null
    };

    const asstMarkdown = {
      innerText: '【引用评价开始】本轮独立评价正文【引用评价结束】'
    };

    // 1. Copy and Regenerate alone without recommendations: MUST be false
    const copyBtn = {
      getAttribute: key => key === 'aria-label' ? 'Copy to clipboard' : (key === 'title' ? 'Copy' : null),
      innerText: 'Copy',
      querySelector: () => null,
      closest: () => null
    };
    const regenerateBtn = {
      getAttribute: key => key === 'aria-label' ? 'Regenerate response' : null,
      innerText: 'Regenerate',
      querySelector: () => null,
      closest: () => null
    };

    const asstMsgWithControlsOnly = {
      getAttribute: key => key === 'data-testid' ? 'assistant-message' : null,
      querySelector: sel => sel === '.response-content-markdown' ? asstMarkdown : null,
      querySelectorAll: sel => sel.includes('button') ? [copyBtn, regenerateBtn] : [],
      nextElementSibling: null
    };
    userMsg.nextElementSibling = asstMsgWithControlsOnly;

    globalThis.document = {
      querySelectorAll: sel => {
        if (sel.includes('user-message') || sel.includes('assistant-message')) {
          return [userMsg, asstMsgWithControlsOnly];
        }
        if (sel.includes('button')) {
          return [copyBtn, regenerateBtn];
        }
        return [];
      }
    };

    const controlsOnlyRes = readGrokComTurnAnswerOnPage(nonce, []);
    assert.equal(controlsOnlyRes.userMessageFound, true);
    assert.equal(controlsOnlyRes.done, false);
    assert.equal(controlsOnlyRes.hasNewRecommendations, false);

    // 2. Old recommendations: same stamped node in the current turn group, even with an arrow. MUST be false
    const oldRecBtn = {
      getAttribute: key => key === 'data-slot' ? 'xds-button' : (key === 'data-xf-snap' ? 'old-1' : null),
      innerText: '旧推荐问题：什么是多模态？',
      querySelector: sel => {
        if (sel.includes('overflow-x-clip')) return {};
        if (sel.includes('M15 10l5 5-5 5M4 4v7a4 4 0 0 0 4 4h12')) return {};
        return null;
      },
      closest: () => null
    };
    const oldGroup = {
      className: 'flex w-full flex-col gap-1 pt-1',
      getAttribute: () => null,
      querySelector: () => null,
      querySelectorAll: sel => sel.includes('button') ? [oldRecBtn] : []
    };
    const asstMsgWithOldRec = {
      getAttribute: key => key === 'data-testid' ? 'assistant-message' : null,
      querySelector: sel => sel === '.response-content-markdown' ? asstMarkdown : null,
      querySelectorAll: () => [],
      nextElementSibling: oldGroup
    };
    const oldParent = { children: [userMsg, asstMsgWithOldRec, oldGroup] };
    asstMsgWithOldRec.parentElement = oldParent;
    userMsg.nextElementSibling = asstMsgWithOldRec;

    globalThis.document = {
      querySelectorAll: sel => {
        if (sel.includes('user-message') || sel.includes('assistant-message')) return [userMsg, asstMsgWithOldRec];
        if (sel.includes('button')) return [copyBtn, oldRecBtn];
        return [];
      }
    };

    const oldRecRes = readGrokComTurnAnswerOnPage(nonce, [{ nodeId: 'old-1', text: '旧推荐问题：什么是多模态？' }]);
    assert.equal(oldRecRes.done, false);
    assert.equal(oldRecRes.hasNewRecommendations, false);

    const bareXds = {
      getAttribute: key => key === 'data-slot' ? 'xds-button' : null,
      innerText: '仅有按钮槽位',
      querySelector: () => null,
      closest: () => null
    };
    const bareGroup = {
      className: 'flex w-full flex-col gap-1 pt-1',
      getAttribute: () => null,
      querySelector: () => null,
      querySelectorAll: sel => sel.includes('button') ? [bareXds] : []
    };
    const asstBare = {
      getAttribute: key => key === 'data-testid' ? 'assistant-message' : null,
      querySelector: sel => sel === '.response-content-markdown' ? asstMarkdown : null,
      querySelectorAll: () => [],
      parentElement: null
    };
    asstBare.parentElement = { children: [userMsg, asstBare, bareGroup] };
    globalThis.document = {
      querySelectorAll: sel => sel.includes('user-message') || sel.includes('assistant-message') ? [userMsg, asstBare] : []
    };
    const bareRes = readGrokComTurnAnswerOnPage(nonce, []);
    assert.equal(bareRes.hasNewRecommendations, false);

    // 3. Current turn with Variant 1 new recommendation (xds-button, min-w-0 span, arrow icon): MUST be true
    const newRecBtnV1 = {
      getAttribute: key => key === 'data-slot' ? 'xds-button' : null,
      innerText: '新推荐问题：如何展开实测？',
      querySelector: sel => {
        if (sel.includes('overflow-x-clip')) return {};
        if (sel.includes('M15 10l5 5-5 5M4 4v7a4 4 0 0 0 4 4h12')) return {};
        return null;
      },
      closest: () => null
    };
    const groupV1 = {
      className: 'flex w-full flex-col gap-1 pt-1',
      getAttribute: () => null,
      querySelector: () => null,
      querySelectorAll: sel => sel.includes('button') ? [newRecBtnV1] : []
    };
    const asstMsgWithNewRecV1 = {
      getAttribute: key => key === 'data-testid' ? 'assistant-message' : null,
      querySelector: sel => sel === '.response-content-markdown' ? asstMarkdown : null,
      querySelectorAll: () => [],
      nextElementSibling: groupV1
    };
    asstMsgWithNewRecV1.parentElement = { children: [userMsg, asstMsgWithNewRecV1, groupV1] };
    userMsg.nextElementSibling = asstMsgWithNewRecV1;

    globalThis.document = {
      querySelectorAll: sel => {
        if (sel.includes('user-message') || sel.includes('assistant-message')) {
          return [userMsg, asstMsgWithNewRecV1];
        }
        if (sel.includes('button')) {
          return [copyBtn, newRecBtnV1];
        }
        return [];
      }
    };

    const newRecResV1 = readGrokComTurnAnswerOnPage(nonce, [{ nodeId: 'old-1', text: '旧推荐问题：什么是多模态？' }]);
    assert.equal(newRecResV1.done, true);
    assert.equal(newRecResV1.hasNewRecommendations, true);
    assert.match(newRecResV1.text, /本轮独立评价正文/);

    const repeatedBtn = {
      getAttribute: key => key === 'data-slot' ? 'xds-button' : null,
      innerText: '旧推荐问题：什么是多模态？',
      querySelector: sel => sel.includes('M15 10l5 5-5 5M4 4v7a4 4 0 0 0 4 4h12') ? {} : null,
      closest: () => null
    };
    const repeatedGroup = {
      className: 'flex w-full flex-col gap-1 pt-1',
      getAttribute: () => null,
      querySelector: () => null,
      querySelectorAll: sel => sel.includes('button') ? [repeatedBtn] : []
    };
    const asstRepeated = {
      getAttribute: key => key === 'data-testid' ? 'assistant-message' : null,
      querySelector: sel => sel === '.response-content-markdown' ? asstMarkdown : null,
      querySelectorAll: () => [],
      parentElement: null
    };
    asstRepeated.parentElement = { children: [userMsg, asstRepeated, repeatedGroup] };
    globalThis.document = {
      querySelectorAll: sel => sel.includes('user-message') || sel.includes('assistant-message') ? [userMsg, asstRepeated] : []
    };
    const repeatedRes = readGrokComTurnAnswerOnPage(nonce, [{ nodeId: 'prev-turn', text: '旧推荐问题：什么是多模态？' }]);
    assert.equal(repeatedRes.done, true);
    assert.equal(repeatedRes.hasNewRecommendations, true);

    // 4. Current turn with Variant 2 recommendation (button[data-slot=button] with arrow-down-right and textual span)
    const newRecBtnV2 = {
      getAttribute: key => key === 'data-slot' ? 'button' : null,
      innerText: 'Explain in one sentence for a developer',
      querySelector: sel => {
        if (sel.includes('arrow-down-right')) return {};
        if (sel.includes('text-box:trim-both')) return {};
        return null;
      },
      closest: () => null
    };
    const groupV2 = {
      className: 'flex w-full flex-col gap-1 pt-1',
      getAttribute: () => null,
      querySelector: () => null,
      querySelectorAll: sel => sel.includes('button') ? [newRecBtnV2] : []
    };
    const asstMsgWithNewRecV2 = {
      getAttribute: key => key === 'data-testid' ? 'assistant-message' : null,
      querySelector: sel => sel === '.response-content-markdown' ? asstMarkdown : null,
      querySelectorAll: () => [],
      nextElementSibling: groupV2
    };
    asstMsgWithNewRecV2.parentElement = { children: [userMsg, asstMsgWithNewRecV2, groupV2] };
    userMsg.nextElementSibling = asstMsgWithNewRecV2;

    globalThis.document = {
      querySelectorAll: sel => {
        if (sel.includes('user-message') || sel.includes('assistant-message')) {
          return [userMsg, asstMsgWithNewRecV2];
        }
        if (sel.includes('button')) {
          return [copyBtn, newRecBtnV2];
        }
        return [];
      }
    };

    const newRecResV2 = readGrokComTurnAnswerOnPage(nonce, []);
    assert.equal(newRecResV2.done, true);
    assert.equal(newRecResV2.hasNewRecommendations, true);

    // 5. Active Stop Generating button suppresses completion even if recommendations exist
    const stopBtn = {
      getAttribute: key => key === 'aria-label' ? 'Stop generating' : null,
      innerText: 'Stop generating'
    };
    globalThis.document = {
      querySelectorAll: sel => {
        if (sel.includes('user-message') || sel.includes('assistant-message')) {
          return [userMsg, asstMsgWithNewRecV2];
        }
        if (sel.includes('button')) {
          return [stopBtn, copyBtn, newRecBtnV2];
        }
        return [];
      }
    };

    const generatingRes = readGrokComTurnAnswerOnPage(nonce, []);
    assert.equal(generatingRes.done, false);

    const stopResponse = {
      getAttribute: key => key === 'aria-label' ? 'Stop response' : null,
      innerText: '停止响应'
    };
    globalThis.document = {
      querySelectorAll: sel => {
        if (sel.includes('user-message') || sel.includes('assistant-message')) return [userMsg, asstMsgWithNewRecV2];
        if (sel.includes('button')) return [stopResponse, newRecBtnV2];
        return [];
      }
    };
    assert.equal(readGrokComTurnAnswerOnPage(nonce, []).done, false);

    // 6. Empty markdown body suppresses completion even if recommendations exist
    const emptyMarkdownEl = { innerText: '   ' };
    const asstMsgEmptyMd = {
      getAttribute: key => key === 'data-testid' ? 'assistant-message' : null,
      querySelector: sel => sel === '.response-content-markdown' ? emptyMarkdownEl : null,
      querySelectorAll: () => [],
      nextElementSibling: groupV2
    };
    asstMsgEmptyMd.parentElement = { children: [userMsg, asstMsgEmptyMd, groupV2] };
    userMsg.nextElementSibling = asstMsgEmptyMd;

    globalThis.document = {
      querySelectorAll: sel => {
        if (sel.includes('user-message') || sel.includes('assistant-message')) {
          return [userMsg, asstMsgEmptyMd];
        }
        if (sel.includes('button')) {
          return [newRecBtnV2];
        }
        return [];
      }
    };

    const emptyMdRes = readGrokComTurnAnswerOnPage(nonce, []);
    assert.equal(emptyMdRes.done, false);
    assert.equal(emptyMdRes.emptyMarkdown, true);

    groupV2.getAttribute = key => key === 'data-opacity' ? '0' : null;
    asstMsgWithNewRecV2.parentElement = { children: [userMsg, asstMsgWithNewRecV2, groupV2] };
    globalThis.document = {
      querySelectorAll: sel => sel.includes('user-message') || sel.includes('assistant-message') ? [userMsg, asstMsgWithNewRecV2] : []
    };
    assert.equal(readGrokComTurnAnswerOnPage(nonce, []).done, false);
  } finally {
    globalThis.document = prevDoc;
  }
});

test('deleteGrokComCurrentConversationOnPage requires exact ID, opens 更多 and clicks exact 删除聊天', () => {
  const prevLoc = globalThis.location;
  const prevDoc = globalThis.document;
  try {
    globalThis.location = { pathname: '/c/test-chat-uuid', href: 'https://grok.com/c/test-chat-uuid' };

    let menuOpened = false;
    let deleteClicked = false;
    let confirmClicked = false;

    const moreBtn = {
      getAttribute: key => key === 'aria-label' ? '更多' : null,
      click: () => { menuOpened = true; }
    };
    const deleteMenuItem = {
      innerText: '删除聊天',
      click: () => { deleteClicked = true; }
    };
    const dialogConfirmBtn = {
      innerText: '删除',
      disabled: false,
      click: () => { confirmClicked = true; }
    };
    const dialog = {
      querySelectorAll: sel => sel.includes('button') ? [dialogConfirmBtn] : []
    };

    globalThis.document = {
      querySelector: sel => {
        if (sel.includes('role="dialog"')) return deleteClicked ? dialog : null;
        return null;
      },
      querySelectorAll: sel => {
        if (sel.includes('button') && !sel.includes('menu') && !sel.includes('dialog')) {
          return [moreBtn];
        }
        if (sel.includes('menuitem') || sel.includes('role="menu"')) {
          return menuOpened ? [deleteMenuItem] : [];
        }
        return [];
      }
    };

    const res = deleteGrokComCurrentConversationOnPage('test-chat-uuid');
    assert.equal(res.ok, true);
    assert.equal(menuOpened, true);
    assert.equal(deleteClicked, true);
    assert.equal(confirmClicked, true);

    // Mismatched ID must refuse
    const refuseRes = deleteGrokComCurrentConversationOnPage('wrong-uuid');
    assert.equal(refuseRes.ok, false);
    assert.match(refuseRes.reason, /不符/);
  } finally {
    globalThis.location = prevLoc;
    globalThis.document = prevDoc;
  }
});

test('verifyGrokComDeletionProofOnPage checks homepage URL, sidebar link absence and deletion toast', () => {
  const prevLoc = globalThis.location;
  const prevDoc = globalThis.document;
  try {
    const oldId = 'old-deleted-uuid';

    // 1. Still on old URL: proof fails
    globalThis.location = { pathname: `/c/${oldId}`, href: `https://grok.com/c/${oldId}` };
    globalThis.document = {
      querySelector: () => null,
      querySelectorAll: () => []
    };
    const failUrl = verifyGrokComDeletionProofOnPage(oldId);
    assert.equal(failUrl.verified, false);
    assert.equal(failUrl.proofs.urlOk, false);

    // 2. On homepage BUT old sidebar link still in DOM: proof fails
    globalThis.location = { pathname: '/', href: 'https://grok.com/' };
    globalThis.document = {
      querySelector: sel => sel.includes(oldId) ? { href: `/c/${oldId}` } : null,
      querySelectorAll: () => [{ innerText: '已删除聊天' }]
    };
    const failSidebar = verifyGrokComDeletionProofOnPage(oldId);
    assert.equal(failSidebar.verified, false);
    assert.equal(failSidebar.proofs.sidebarLinkAbsent, false);

    // 3. Homepage, sidebar link absent, toast verified: proof succeeds
    globalThis.document = {
      querySelector: () => null,
      querySelectorAll: sel => sel.includes('status') || sel.includes('toast') ? [{ innerText: '已删除会话，可撤销' }] : []
    };
    const successProof = verifyGrokComDeletionProofOnPage(oldId);
    assert.equal(successProof.verified, true);
    assert.equal(successProof.proofs.urlOk, true);
    assert.equal(successProof.proofs.sidebarLinkAbsent, true);
    assert.equal(successProof.proofs.hasToast, true);
  } finally {
    globalThis.location = prevLoc;
    globalThis.document = prevDoc;
  }
});

test('rotateGrokConversation blocks without resetting counter if delete or proof fails', async () => {
  const storageData = {};
  const mockStorage = {
    get: async () => ({ grokPersistentSession: storageData.grokPersistentSession }),
    set: async d => Object.assign(storageData, d)
  };

  const state = createDefaultSessionState({
    conversationId: 'conv-failing-delete',
    conversationUrl: 'https://grok.com/c/conv-failing-delete',
    createdByExtension: true,
    acceptedCount: 50,
    windowId: 1,
    tabId: 10,
    ownershipToken: 'tok-rotate',
    ownerKey: 'ghash_owner'
  });
  storageData.grokPersistentSession = state;

  const prior = globalThis.chrome;

  // Case 1: Trigger delete fails
  globalThis.chrome = {
    storage: {
      local: mockStorage,
      session: {
        get: async key => ({ [key]: { windowId: 1, tabId: 10, ownershipToken: 'tok-rotate' } }),
        set: async () => {}
      }
    },
    windows: { get: async () => ({ id: 1, type: 'popup', tabs: [{ id: 10, url: 'https://grok.com/c/conv-failing-delete' }] }) },
    tabs: { get: async () => ({ id: 10, status: 'complete' }), update: async () => {} },
    scripting: {
      executeScript: async ({ func }) => {
        if (func === readTemporaryWindowOwnerOnPage) return [{ result: 'xfollower-owned:tok-rotate' }];
        if (func === inspectGrokComAccountIdentityOnPage) return [{ result: { ok: true, ownerKey: 'ghash_owner', accountLabel: 'Account' } }];
        if (func === deleteGrokComCurrentConversationOnPage) {
          return [{ result: { ok: false, reason: '未找到会话头部“更多”选项菜单按钮' } }];
        }
        return [];
      }
    }
  };

  try {
    await assert.rejects(
      rotateGrokConversation(state, 10, async () => {}),
      /触发会话删除失败|更多/
    );
    // acceptedCount MUST NOT be reset!
    assert.equal(state.acceptedCount, 50);
    assert.equal(state.conversationId, 'conv-failing-delete');
    assert.equal(state.state, 'rotation_pending');
    assert.equal(state.rotation.phase, 'failed');

    // Case 2: Delete triggered but proof verification fails
    globalThis.chrome.scripting.executeScript = async ({ func }) => {
      if (func === readTemporaryWindowOwnerOnPage) return [{ result: 'xfollower-owned:tok-rotate' }];
      if (func === inspectGrokComAccountIdentityOnPage) return [{ result: { ok: true, ownerKey: 'ghash_owner', accountLabel: 'Account' } }];
      if (func === deleteGrokComCurrentConversationOnPage) {
        return [{ result: { ok: true, action: 'delete_triggered' } }];
      }
      if (func === verifyGrokComDeletionProofOnPage) {
        return [{ result: { verified: false, proofs: { urlOk: false } } }];
      }
      return [];
    };

    await assert.rejects(
      rotateGrokConversation(state, 10, async () => {}),
      /凭证核验未通过/
    );
    assert.equal(state.acceptedCount, 50);
    assert.equal(state.conversationId, 'conv-failing-delete');
    assert.equal(state.state, 'rotation_pending');
  } finally {
    globalThis.chrome = prior;
  }
});

test('uncertain prompt acceptance blocks subsequent calls and persists across restart', async () => {
  const storageData = {};
  const mockStorage = {
    get: async () => ({ grokPersistentSession: storageData.grokPersistentSession }),
    set: async d => Object.assign(storageData, d)
  };

  const state = createDefaultSessionState({
    windowId: 2,
    tabId: 20,
    acceptedCount: 5,
    conversationId: 'chat-abc',
    conversationUrl: 'https://grok.com/c/chat-abc',
    createdByExtension: true,
    ownershipToken: 'tok-u'
  });
  storageData.grokPersistentSession = state;

  const prior = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      local: mockStorage,
      session: { get: async key => ({ [key]: { windowId: 2, tabId: 20, ownershipToken: 'tok-u' } }), set: async () => {} }
    },
    windows: { get: async () => ({ id: 2, type: 'popup', tabs: [{ id: 20, url: 'https://grok.com/c/chat-abc' }] }) },
    tabs: { get: async () => ({ id: 20, status: 'complete', url: 'https://grok.com/c/chat-abc' }) },
    scripting: {
      executeScript: async ({ func }) => {
        if (func === readTemporaryWindowOwnerOnPage) return [{ result: 'xfollower-owned:tok-u' }];
        if (func === inspectGrokComAccountIdentityOnPage) return [{ result: { ok: true, ownerKey: 'ghash_u', accountLabel: 'Account' } }];
        if (func === inspectGrokComPageBeforeSubmitOnPage) return [{ result: { ok: true } }];
        if (func === snapshotGrokComRecommendationsOnPage) return [{ result: [] }];
        if (func.toString().includes('user_draft_detected')) return [{ result: { ok: true } }];
        if (func === confirmGrokComPromptAcceptedOnPage) {
          // Fail acceptance confirmation
          return [{ result: { accepted: false, reason: '未找到包含当前凭证的独立用户消息气泡' } }];
        }
        return [];
      }
    }
  };

  try {
    // 1. Submit prompt that cannot be confirmed: must enter uncertain state
    const res1 = await executeGrokComTask({
      prompt: 'Uncertain task',
      nonce: 'nonce-uncertain',
      sleep: async () => {}
    });

    assert.equal(res1.ok, false);
    assert.equal(res1.uncertain, true);
    const uncertainState = await getGrokSessionState();
    assert.equal(uncertainState.state, 'uncertain');
    assert.equal(uncertainState.activeRequest?.stage, 'uncertain');
    // acceptedCount must NOT be incremented on unconfirmed prompt
    assert.equal(uncertainState.acceptedCount, 5);

    // 2. Fencing: New task while uncertain must be blocked
    const res2 = await executeGrokComTask({
      prompt: 'Second task while uncertain',
      nonce: 'nonce-blocked',
      sleep: async () => {}
    });
    assert.equal(res2.ok, false);
    assert.match(res2.reason, /未决状态/);

    // 3. Restart recovery: Unconfirmed activeRequest remains uncertain across startup
    const recovered = await recoverGrokSessionOnStartup();
    assert.equal(recovered.state, 'uncertain');
    assert.equal(recovered.activeRequest?.stage, 'uncertain');
    assert.equal(recovered.acceptedCount, 5);

    // 4. Now simulate page having the user bubble on startup: reconciles count and recovers
    globalThis.chrome.scripting.executeScript = async ({ func }) => {
      if (func === readTemporaryWindowOwnerOnPage) return [{ result: 'xfollower-owned:tok-u' }];
      if (func === confirmGrokComPromptAcceptedOnPage) {
        return [{ result: { accepted: true, conversationId: 'chat-abc', conversationUrl: 'https://grok.com/c/chat-abc' } }];
      }
      if (func === readGrokComTurnAnswerOnPage) {
        return [{ result: { text: 'Done answer', done: true } }];
      }
      return [];
    };

    const reconciled = await recoverGrokSessionOnStartup();
    assert.equal(reconciled.acceptedCount, 6);
    assert.equal(reconciled.state, 'ready');
    assert.equal(reconciled.activeRequest, null);
  } finally {
    globalThis.chrome = prior;
  }
});

test('serialized control actions: pause during generation survives final save, reset_rotation requires actual deletion', async () => {
  const storageData = {};
  const mockStorage = {
    get: async () => ({ grokPersistentSession: storageData.grokPersistentSession }),
    set: async d => Object.assign(storageData, d)
  };

  const state = createDefaultSessionState({
    windowId: 3,
    tabId: 30,
    acceptedCount: 10,
    conversationId: 'chat-xyz',
    conversationUrl: 'https://grok.com/c/chat-xyz',
    createdByExtension: true,
    state: 'generating',
    activeRequest: {
      requestId: 'active-req',
      nonce: 'nonce-gen',
      acceptedCounted: true,
      stage: 'generating'
    },
    ownershipToken: 'tok-r',
    ownerKey: 'ghash_r'
  });
  storageData.grokPersistentSession = state;

  const prior = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      local: mockStorage,
      session: { get: async key => ({ [key]: { windowId: 3, tabId: 30, ownershipToken: 'tok-r' } }), set: async () => {} }
    },
    windows: { get: async () => ({ id: 3, type: 'popup', tabs: [{ id: 30, url: 'https://grok.com/c/chat-xyz' }] }) }
  };

  try {
    // 1. Pause while generating: pausedReuse set, state stays generating until completion
    const pauseRes = await handleGrokSessionAction('pause');
    assert.equal(pauseRes.ok, true);
    assert.equal(pauseRes.state.pausedReuse, true);
    assert.equal(pauseRes.state.state, 'generating');

    // 2. reset_rotation when conversation exists and is not extension-created must be rejected
    storageData.grokPersistentSession.createdByExtension = false;
    const rejectReset = await handleGrokSessionAction('reset_rotation');
    assert.equal(rejectReset.ok, false);
    assert.match(rejectReset.error, /非扩展创建/);

    // 3. reset_rotation when extension-created must execute rotation with actual deletion
    storageData.grokPersistentSession.createdByExtension = true;
    storageData.grokPersistentSession.tabId = null;
    const missingTab = await handleGrokSessionAction('reset_rotation');
    assert.equal(missingTab.ok, false);
    assert.equal(storageData.grokPersistentSession.acceptedCount, 10);
    assert.equal(storageData.grokPersistentSession.conversationId, 'chat-xyz');
    storageData.grokPersistentSession.tabId = 30;

    let deleteTriggered = false;
    globalThis.chrome.scripting = {
      executeScript: async ({ func }) => {
        if (func === readTemporaryWindowOwnerOnPage) return [{ result: 'xfollower-owned:tok-r' }];
        if (func === inspectGrokComAccountIdentityOnPage) return [{ result: { ok: true, ownerKey: 'ghash_r', accountLabel: 'Account' } }];
        if (func === deleteGrokComCurrentConversationOnPage) {
          deleteTriggered = true;
          return [{ result: { ok: true } }];
        }
        if (func === verifyGrokComDeletionProofOnPage) {
          return [{ result: { verified: true } }];
        }
        return [];
      }
    };
    globalThis.chrome.tabs = {
      get: async () => ({ id: 30, status: 'complete' }),
      update: async () => {}
    };

    const validReset = await handleGrokSessionAction('reset_rotation');
    assert.equal(validReset.ok, true);
    assert.equal(deleteTriggered, true);
    assert.equal(validReset.state.acceptedCount, 0);
    assert.equal(validReset.state.generation, 2);
    assert.equal(validReset.state.conversationId, null);
  } finally {
    globalThis.chrome = prior;
  }
});

test('identity failure and foreign window do not send, delete, or open a second window', async () => {
  const storageData = {};
  const mockStorage = {
    get: async () => ({ grokPersistentSession: storageData.grokPersistentSession }),
    set: async data => Object.assign(storageData, data)
  };
  storageData.grokPersistentSession = createDefaultSessionState({
    windowId: 8,
    tabId: 80,
    ownershipToken: 'tok-foreign',
    conversationId: 'chat-foreign',
    conversationUrl: 'https://grok.com/c/chat-foreign',
    createdByExtension: true,
    acceptedCount: 4
  });
  const prior = globalThis.chrome;
  let created = 0;
  let drove = 0;
  globalThis.chrome = {
    storage: { local: mockStorage, session: { get: async () => ({}), set: async () => {} } },
    windows: {
      get: async () => ({ id: 8, type: 'normal', tabs: [{ id: 81, url: 'https://example.com/' }] }),
      create: async () => { created += 1; return { id: 99, tabs: [{ id: 1 }] }; }
    },
    tabs: { get: async () => ({ status: 'complete' }) },
    scripting: { executeScript: async () => [{ result: null }] }
  };
  try {
    const blocked = await executeGrokComTask({ prompt: 'no', nonce: 'n-foreign', sleep: async () => {} });
    assert.equal(blocked.ok, false);
    assert.equal(created, 0);
    assert.equal((await getGrokSessionState()).pausedReuse, true);
    assert.equal((await getGrokSessionState()).acceptedCount, 4);

    storageData.grokPersistentSession = createDefaultSessionState({
      windowId: 8,
      tabId: 80,
      ownershipToken: 'tok-owned',
      conversationId: null,
      conversationUrl: 'https://grok.com/',
      createdByExtension: true,
      acceptedCount: 1,
      pausedReuse: false,
      state: 'ready'
    });
    globalThis.chrome.windows.get = async () => ({ id: 8, type: 'popup', tabs: [{ id: 80, url: 'https://grok.com/' }] });
    globalThis.chrome.storage.session.get = async key => ({ [key]: { windowId: 8, tabId: 80, ownershipToken: 'tok-owned' } });
    globalThis.chrome.scripting.executeScript = async ({ func }) => {
      if (func === readTemporaryWindowOwnerOnPage) return [{ result: 'xfollower-owned:tok-owned' }];
      if (func === inspectGrokComAccountIdentityOnPage) return [{ result: { ok: false, reason: '未能从账号菜单中识别登录邮箱' } }];
      if (String(func).includes('user_draft_detected')) { drove += 1; return [{ result: { ok: true } }]; }
      return [{ result: null }];
    };
    const noIdentity = await executeGrokComTask({ prompt: 'no', nonce: 'n-id', sleep: async () => {} });
    assert.equal(noIdentity.ok, false);
    assert.match(noIdentity.reason, /邮箱|身份/);
    assert.equal(drove, 0);
    assert.equal((await getGrokSessionState()).acceptedCount, 1);
  } finally {
    globalThis.chrome = prior;
  }
});

test('timeout keeps the in-flight request quarantined', async () => {
  const storageData = {};
  const mockStorage = {
    get: async () => ({ grokPersistentSession: storageData.grokPersistentSession }),
    set: async data => Object.assign(storageData, data)
  };
  storageData.grokPersistentSession = createDefaultSessionState({
    windowId: 4,
    tabId: 40,
    ownershipToken: 'tok-time',
    conversationId: 'chat-time',
    conversationUrl: 'https://grok.com/c/chat-time',
    createdByExtension: true,
    acceptedCount: 2,
    ownerKey: 'ghash_time'
  });
  const prior = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      local: mockStorage,
      session: { get: async key => ({ [key]: { windowId: 4, tabId: 40, ownershipToken: 'tok-time' } }), set: async () => {} }
    },
    windows: { get: async () => ({ id: 4, type: 'popup', tabs: [{ id: 40, url: 'https://grok.com/c/chat-time' }] }) },
    tabs: { get: async () => ({ id: 40, status: 'complete', url: 'https://grok.com/c/chat-time' }) },
    scripting: {
      executeScript: async ({ func }) => {
        if (func === readTemporaryWindowOwnerOnPage) return [{ result: 'xfollower-owned:tok-time' }];
        if (func === inspectGrokComAccountIdentityOnPage) return [{ result: { ok: true, ownerKey: 'ghash_time', accountLabel: 'Account' } }];
        if (func === inspectGrokComPageBeforeSubmitOnPage) return [{ result: { ok: true, currentConvId: 'chat-time' } }];
        if (func === snapshotGrokComRecommendationsOnPage) return [{ result: [] }];
        if (func === confirmGrokComPromptAcceptedOnPage) return [{ result: { accepted: true, conversationId: 'chat-time', conversationUrl: 'https://grok.com/c/chat-time' } }];
        if (String(func).includes('user_draft_detected')) return [{ result: { ok: true } }];
        if (func === readGrokComTurnAnswerOnPage) throw new Error('注入读取失败');
        return [{ result: null }];
      }
    }
  };
  try {
    const timed = await executeGrokComTask({ prompt: 'wait', nonce: 'n-time', timeoutMs: 0, sleep: async () => {} });
    assert.equal(timed.ok, false);
    assert.equal(timed.uncertain, true);
    const saved = await getGrokSessionState();
    assert.equal(saved.state, 'uncertain');
    assert.ok(saved.activeRequest);
    assert.equal(saved.activeRequest.stage, 'uncertain');
    const again = await executeGrokComTask({ prompt: 'next', nonce: 'n-next', sleep: async () => {} });
    assert.equal(again.ok, false);
    assert.match(again.reason, /未决/);
  } finally {
    globalThis.chrome = prior;
  }
});

test('serialized in-page functions run in a fresh realm', async () => {
  const pageFns = [
    inspectGrokComAccountIdentityOnPage,
    findVisibleGrokComInputOnPage,
    inspectGrokComPageBeforeSubmitOnPage,
    snapshotGrokComRecommendationsOnPage,
    confirmGrokComPromptAcceptedOnPage,
    readGrokComTurnAnswerOnPage,
    deleteGrokComCurrentConversationOnPage,
    verifyGrokComDeletionProofOnPage,
    confirmGrokComDeletionOnPage,
    probeGrokComPageOnPage
  ];
  for (const fn of pageFns) {
    const sandbox = {
      location: { hostname: 'grok.com', pathname: '/', href: 'https://grok.com/', origin: 'https://grok.com' },
      document: {
        querySelector: () => null,
        querySelectorAll: () => [],
        body: { innerText: '', click() {} }
      },
      window: {},
      KeyboardEvent: class KeyboardEvent {},
      setTimeout,
      clearTimeout,
      Promise,
      Math,
      Date
    };
    sandbox.window.location = sandbox.location;
    sandbox.window.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
    const context = vm.createContext(sandbox);
    const compiled = vm.runInContext(`(${fn.toString()})`, context);
    const result = await compiled('nonce-vm', null);
    assert.notEqual(result, undefined);
    assert.equal(sandbox.findVisibleGrokComInputOnPage, undefined);
  }
});

test('startup recovery ignores a stale tab and does not count its active request', async () => {
  const storageData = {};
  const mockStorage = {
    get: async () => ({ grokPersistentSession: storageData.grokPersistentSession }),
    set: async data => Object.assign(storageData, data)
  };
  storageData.grokPersistentSession = createDefaultSessionState({
    windowId: 5,
    tabId: 50,
    ownershipToken: 'tok-stale',
    conversationId: 'chat-live',
    conversationUrl: 'https://grok.com/c/chat-live',
    createdByExtension: true,
    acceptedCount: 7,
    state: 'generating',
    activeRequest: {
      requestId: 'req-stale',
      nonce: 'nonce-stale',
      acceptedCounted: false,
      stage: 'generating',
      preSubmitSignatures: []
    }
  });
  const prior = globalThis.chrome;
  const scriptTargets = [];
  globalThis.chrome = {
    storage: {
      local: mockStorage,
      session: {
        get: async key => ({ [key]: { windowId: 5, tabId: 50, ownershipToken: 'tok-stale' } }),
        set: async () => {}
      }
    },
    windows: {
      get: async () => ({ id: 5, type: 'popup', tabs: [{ id: 59, url: 'https://grok.com/c/chat-other' }] })
    },
    scripting: {
      executeScript: async ({ target, func }) => {
        scriptTargets.push(target?.tabId);
        if (func === confirmGrokComPromptAcceptedOnPage) {
          return [{ result: { accepted: true, conversationId: 'chat-other', conversationUrl: 'https://grok.com/c/chat-other' } }];
        }
        if (func === readGrokComTurnAnswerOnPage) {
          return [{ result: { text: 'foreign', done: true } }];
        }
        return [{ result: null }];
      }
    }
  };
  try {
    const recovered = await recoverGrokSessionOnStartup();
    assert.equal(scriptTargets.includes(50), false);
    assert.equal(scriptTargets.some(id => id === 59 && recovered.acceptedCount !== 7), false);
    assert.equal(recovered.acceptedCount, 7);
    assert.equal(recovered.activeRequest?.requestId, 'req-stale');
    assert.equal(recovered.activeRequest?.stage, 'uncertain');
    assert.equal(recovered.activeRequest?.acceptedCounted, false);
    assert.equal(recovered.conversationId, 'chat-live');
  } finally {
    globalThis.chrome = prior;
  }
});

test('a submitting request restored across restart is not overwritten', async () => {
  const storageData = {};
  const mockStorage = {
    get: async () => ({ grokPersistentSession: storageData.grokPersistentSession }),
    set: async data => Object.assign(storageData, data)
  };
  storageData.grokPersistentSession = createDefaultSessionState({
    windowId: 6,
    tabId: 60,
    ownershipToken: 'tok-sub',
    conversationId: 'chat-sub',
    conversationUrl: 'https://grok.com/c/chat-sub',
    createdByExtension: true,
    acceptedCount: 3,
    state: 'submitting',
    ownerKey: 'ghash_sub',
    activeRequest: {
      requestId: 'req-sub',
      nonce: 'nonce-sub',
      acceptedCounted: false,
      stage: 'submitting',
      preSubmitSignatures: ['keep-me']
    }
  });
  const prior = globalThis.chrome;
  let confirmReads = 0;
  globalThis.chrome = {
    storage: {
      local: mockStorage,
      session: {
        get: async key => ({ [key]: { windowId: 6, tabId: 60, ownershipToken: 'tok-sub' } }),
        set: async () => {}
      }
    },
    windows: { get: async () => ({ id: 6, type: 'popup', tabs: [{ id: 60, url: 'https://grok.com/c/chat-sub' }] }) },
    tabs: { get: async () => ({ id: 60, status: 'complete', url: 'https://grok.com/c/chat-sub' }) },
    scripting: {
      executeScript: async ({ func }) => {
        if (func === readTemporaryWindowOwnerOnPage) return [{ result: 'xfollower-owned:tok-sub' }];
        if (func === confirmGrokComPromptAcceptedOnPage) {
          confirmReads += 1;
          return [{ result: { accepted: true, conversationId: 'chat-sub', conversationUrl: 'https://grok.com/c/chat-sub' } }];
        }
        if (func === inspectGrokComAccountIdentityOnPage) return [{ result: { ok: true, ownerKey: 'ghash_sub', accountLabel: 'Account' } }];
        if (String(func).includes('user_draft_detected')) return [{ result: { ok: true } }];
        return [{ result: null }];
      }
    }
  };
  try {
    const blocked = await executeGrokComTask({ prompt: 'again', nonce: 'nonce-new', sleep: async () => {} });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.busy, true);
    let saved = await getGrokSessionState();
    assert.equal(saved.activeRequest?.requestId, 'req-sub');
    assert.equal(saved.activeRequest?.stage, 'submitting');
    assert.equal(saved.activeRequest?.preSubmitSignatures?.[0], 'keep-me');
    assert.equal(saved.acceptedCount, 3);
    assert.equal(confirmReads, 0);

    const recovered = await recoverGrokSessionOnStartup();
    assert.equal(confirmReads, 1);
    assert.equal(recovered.acceptedCount, 4);
    assert.equal(recovered.activeRequest?.requestId, 'req-sub');
    assert.equal(recovered.activeRequest?.acceptedCounted, true);
    assert.equal(recovered.activeRequest?.stage, 'uncertain');

    const stillBlocked = await executeGrokComTask({ prompt: 'later', nonce: 'nonce-later', sleep: async () => {} });
    assert.equal(stillBlocked.ok, false);
    assert.equal(stillBlocked.uncertain, true);
    saved = await getGrokSessionState();
    assert.equal(saved.activeRequest?.requestId, 'req-sub');
    assert.equal(saved.acceptedCount, 4);
  } finally {
    globalThis.chrome = prior;
  }
});

test('startup recovery waits on the coordinator lock during a new submission', async () => {
  const storageData = {};
  const mockStorage = {
    get: async () => ({ grokPersistentSession: storageData.grokPersistentSession }),
    set: async data => Object.assign(storageData, data)
  };
  storageData.grokPersistentSession = createDefaultSessionState({
    windowId: 7,
    tabId: 70,
    ownershipToken: 'tok-race',
    conversationId: 'chat-race',
    conversationUrl: 'https://grok.com/c/chat-race',
    createdByExtension: true,
    acceptedCount: 1,
    state: 'ready',
    ownerKey: 'ghash_race'
  });
  const prior = globalThis.chrome;
  let releaseDrive;
  const driveGate = new Promise(resolve => { releaseDrive = resolve; });
  let confirmReads = 0;
  globalThis.chrome = {
    storage: {
      local: mockStorage,
      session: {
        get: async key => ({ [key]: { windowId: 7, tabId: 70, ownershipToken: 'tok-race' } }),
        set: async () => {}
      }
    },
    windows: { get: async () => ({ id: 7, type: 'popup', tabs: [{ id: 70, url: 'https://grok.com/c/chat-race' }] }) },
    tabs: { get: async () => ({ id: 70, status: 'complete', url: 'https://grok.com/c/chat-race' }) },
    scripting: {
      executeScript: async ({ func }) => {
        if (func === readTemporaryWindowOwnerOnPage) return [{ result: 'xfollower-owned:tok-race' }];
        if (func === inspectGrokComAccountIdentityOnPage) return [{ result: { ok: true, ownerKey: 'ghash_race', accountLabel: 'Account' } }];
        if (func === inspectGrokComPageBeforeSubmitOnPage) return [{ result: { ok: true, currentConvId: 'chat-race' } }];
        if (func === snapshotGrokComRecommendationsOnPage) return [{ result: ['existing-recommendation'] }];
        if (func === confirmGrokComPromptAcceptedOnPage) {
          confirmReads += 1;
          return [{ result: { accepted: true, conversationId: 'chat-race', conversationUrl: 'https://grok.com/c/chat-race' } }];
        }
        if (String(func).includes('user_draft_detected')) {
          await driveGate;
          return [{ result: { ok: false, err: '提交已取消' } }];
        }
        return [{ result: null }];
      }
    }
  };
  try {
    const task = executeGrokComTask({ prompt: 'race', nonce: 'nonce-race', sleep: async () => {} });
    let submitting = null;
    for (let i = 0; i < 50 && !submitting; i++) {
      const current = await getGrokSessionState();
      if (current.activeRequest?.stage === 'submitting') submitting = current;
      else await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(submitting?.activeRequest?.nonce, 'nonce-race');
    assert.deepEqual(submitting.activeRequest.preSubmitSignatures, ['existing-recommendation']);
    const recovery = recoverGrokSessionOnStartup();
    await new Promise(resolve => setTimeout(resolve, 30));
    const mid = await getGrokSessionState();
    assert.equal(mid.activeRequest?.stage, 'submitting');
    assert.equal(mid.activeRequest?.nonce, 'nonce-race');
    assert.equal(mid.acceptedCount, 1);
    assert.equal(confirmReads, 0);
    releaseDrive();
    const submitted = await task;
    assert.equal(submitted.ok, false);
    const recovered = await recovery;
    assert.equal(recovered.acceptedCount, 1);
    assert.equal(recovered.activeRequest, null);
    assert.equal(confirmReads, 0);
  } finally {
    globalThis.chrome = prior;
  }
});

test('createBackgroundGrokWindow forbids grok.com URLs to prevent secondary 8-min window pool', async () => {
  await assert.rejects(
    createBackgroundGrokWindow('https://grok.com/'),
    /统一由 Grok 会话协调器管理/
  );
});

test('probeGrokSessionAvailability uses persistent window coordinator', async () => {
  const storageData = {};
  const mockStorage = {
    get: async () => ({ grokPersistentSession: storageData.grokPersistentSession }),
    set: async d => Object.assign(storageData, d)
  };

  storageData.grokPersistentSession = createDefaultSessionState({
    windowId: 4,
    tabId: 40,
    ownershipToken: 'tok-probe'
  });

  const prior = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      local: mockStorage,
      session: { get: async key => ({ [key]: { windowId: 4, tabId: 40, ownershipToken: 'tok-probe' } }), set: async () => {} }
    },
    windows: {
      get: async () => ({ id: 4, type: 'popup', tabs: [{ id: 40, url: 'https://grok.com/' }] })
    },
    tabs: {
      get: async () => ({ id: 40, status: 'complete', url: 'https://grok.com/' })
    },
    scripting: {
      executeScript: async ({ func }) => {
        if (func === readTemporaryWindowOwnerOnPage) return [{ result: 'xfollower-owned:tok-probe' }];
        if (func === probeGrokComPageOnPage) {
          return [{ result: { ok: true, reason: 'grok.com 输入框就绪（可进行对话互动）' } }];
        }
        return [];
      }
    }
  };

  try {
    const probe = await probeGrokSessionAvailability();
    assert.equal(probe.ok, true);
    assert.match(probe.reason, /就绪/);
  } finally {
    globalThis.chrome = prior;
  }
});

test('new submission reconciles a late completed request before fencing and never double counts', async () => {
  const prior = globalThis.chrome;
  const data = { grokPersistentSession: createDefaultSessionState({
    windowId: 7, tabId: 70, ownershipToken: 'late-token', conversationId: 'late-chat',
    acceptedCount: 3, state: 'uncertain', activeRequest: {
      requestId: 'late-request', nonce: 'old-nonce', stage: 'uncertain', acceptedCounted: true
    }
  }) };
  let driveCalls = 0;
  globalThis.chrome = {
    storage: {local: {get: async () => data, set: async value => Object.assign(data, structuredClone(value))},
      session: {get: async key => ({[key]: {windowId: 7, tabId: 70, ownershipToken: 'late-token'}})}},
    windows: {get: async () => ({id: 7, type: 'popup', tabs: [{id: 70, url: 'https://grok.com/c/late-chat'}]})},
    tabs: {get: async () => ({id: 70, status: 'complete', url: 'https://grok.com/c/late-chat'})},
    scripting: {executeScript: async ({func, args}) => {
      if (func === readTemporaryWindowOwnerOnPage) return [{result: 'xfollower-owned:late-token'}];
      if (func === confirmGrokComPromptAcceptedOnPage) { assert.equal(args[0], 'old-nonce'); return [{result: {accepted: true, conversationId: 'late-chat'}}]; }
      if (func === readGrokComTurnAnswerOnPage) return [{result: {text: 'Late complete answer', done: true}}];
      if (func === inspectGrokComAccountIdentityOnPage) return [{result: {ok: true, ownerKey: 'hash-late'}}];
      if (func === inspectGrokComPageBeforeSubmitOnPage) return [{result: {ok: true}}];
      if (func.toString().includes('user_draft_detected')) {driveCalls++; return [{result: {ok: false, err: 'test submission stopped'}}];}
      return [];
    }}
  };
  try {
    const result = await executeGrokComTask({prompt: 'New task', nonce: 'new-nonce', sleep: async () => {}});
    assert.equal(result.reason, 'test submission stopped');
    assert.equal(driveCalls, 1);
    assert.equal(data.grokPersistentSession.activeRequest, null);
    assert.equal(data.grokPersistentSession.acceptedCount, 3);
  } finally { globalThis.chrome = prior; }
});

test('first conversation recovers its canonical URL only with owned window and matching accepted nonce', async () => {
  const prior = globalThis.chrome;
  const data = {grokPersistentSession: createDefaultSessionState({
    windowId: 8, tabId: 80, ownershipToken: 'first-token', state: 'uncertain',
    activeRequest: {nonce: 'first-nonce', stage: 'uncertain', acceptedCounted: false}
  })};
  globalThis.chrome = {
    storage: {local: {get: async () => data, set: async value => Object.assign(data, structuredClone(value))},
      session: {get: async key => ({[key]: {windowId: 8, tabId: 80, ownershipToken: 'first-token'}})}},
    windows: {get: async () => ({id: 8, type: 'popup', tabs: [{id: 80, url: 'https://grok.com/c/first-chat'}]})},
    scripting: {executeScript: async ({func, args}) => {
      if (func === readTemporaryWindowOwnerOnPage) return [{result: 'xfollower-owned:first-token'}];
      if (func === confirmGrokComPromptAcceptedOnPage) {assert.equal(args[0], 'first-nonce'); return [{result: {accepted: true, conversationId: 'first-chat', conversationUrl: 'https://grok.com/c/first-chat'}}];}
      if (func === readGrokComTurnAnswerOnPage) return [{result: {text: 'complete', done: true}}];
      return [];
    }}
  };
  try {
    const recovered = await recoverGrokSessionOnStartup();
    assert.equal(recovered.state, 'ready');
    assert.equal(recovered.activeRequest, null);
    assert.equal(recovered.conversationId, 'first-chat');
    assert.equal(recovered.acceptedCount, 1);
    await recoverGrokSessionOnStartup();
    assert.equal(data.grokPersistentSession.acceptedCount, 1);
  } finally {globalThis.chrome = prior;}
});

test('delayed acceptance is polled without sending the prompt twice', async () => {
  const prior = globalThis.chrome;
  const data = {grokPersistentSession: createDefaultSessionState({windowId: 9, tabId: 90,
    ownershipToken: 'delay-token', conversationId: 'delay-chat', state: 'ready'})};
  let sends = 0, confirmations = 0;
  globalThis.chrome = {
    storage: {local: {get: async () => data, set: async value => Object.assign(data, structuredClone(value))},
      session: {get: async key => ({[key]: {windowId: 9, tabId: 90, ownershipToken: 'delay-token'}})}},
    windows: {get: async () => ({id: 9, type: 'popup', tabs: [{id: 90, url: 'https://grok.com/c/delay-chat'}]})},
    tabs: {get: async () => ({id: 90, status: 'complete', url: 'https://grok.com/c/delay-chat'})},
    scripting: {executeScript: async ({func}) => {
      if (func === readTemporaryWindowOwnerOnPage) return [{result: 'xfollower-owned:delay-token'}];
      if (func === inspectGrokComAccountIdentityOnPage) return [{result: {ok: true, ownerKey: 'hash-delay'}}];
      if (func === inspectGrokComPageBeforeSubmitOnPage) return [{result: {ok: true}}];
      if (func.toString().includes('user_draft_detected')) {sends++; return [{result: {ok: true}}];}
      if (func === confirmGrokComPromptAcceptedOnPage) return [{result: {accepted: ++confirmations >= 3, conversationId: 'delay-chat'}}];
      if (func === readGrokComTurnAnswerOnPage) return [{result: {text: 'Complete answer', done: true}}];
      return [];
    }}
  };
  try {
    const result = await executeGrokComTask({prompt: 'Delayed task', nonce: 'delay-nonce', sleep: async () => {}});
    assert.equal(result.ok, true);
    assert.equal(confirmations, 3);
    assert.equal(sends, 1);
    assert.equal(data.grokPersistentSession.acceptedCount, 1);
    assert.equal(data.grokPersistentSession.activeRequest, null);
  } finally {globalThis.chrome = prior;}
});
