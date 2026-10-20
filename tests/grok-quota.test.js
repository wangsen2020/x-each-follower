import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectGrokComUsageOnPage,
  inspectGrokBotsOnPage,
  switchToGrokBotOnPage,
  readGrokComTurnAnswerOnPage,
  createDefaultSessionState,
  executeGrokComTask
} from '../grok-session-manager.js';
import { detectGrokVerificationOnPage } from '../grok-verification.js';

test('inspectGrokComUsageOnPage parses SuperGrok and Grok Bot limits and triggers <= 2% circuit breaker', async () => {
  const prevDoc = globalThis.document;
  const prevLoc = globalThis.location;

  try {
    globalThis.location = { hostname: 'grok.com', href: 'https://grok.com/' };

    // Simulate settings dialog DOM
    const accountBtn = {
      tagName: 'BUTTON',
      getAttribute: attr => attr === 'aria-label' ? 'Account menu, Watson Taylor' : null,
      click: () => {}
    };

    const settingsMenuItem = {
      tagName: 'DIV',
      innerText: '设置',
      click: () => {}
    };

    const usageTab = {
      tagName: 'BUTTON',
      innerText: '使用量',
      click: () => {}
    };

    const closeBtn = {
      tagName: 'BUTTON',
      getAttribute: attr => attr === 'aria-label' ? '关闭' : null,
      click: () => {}
    };

    const superGrokCard = {
      querySelector: sel => {
        if (sel.includes('number-flow-react')) {
          return { getAttribute: attr => attr === 'aria-label' ? '99%' : null };
        }
        return null;
      },
      innerText: '每周 SuperGrok 限额\n99% 已使用\n重置 2026年10月20日 14:09'
    };

    const grokBotCard = {
      querySelector: sel => {
        if (sel.includes('number-flow-react')) {
          return { getAttribute: attr => attr === 'aria-label' ? '0%' : null };
        }
        if (sel.includes('progressbar')) {
          return { getAttribute: attr => attr === 'aria-valuenow' ? '0' : null };
        }
        return null;
      },
      innerText: '每周 Grok Bot 限制\n0% 已使用\n重置 2026年10月25日 17:09'
    };

    const h3Super = {
      innerText: '每周 SuperGrok 限额',
      closest: () => superGrokCard,
      parentElement: superGrokCard
    };

    const h3Bot = {
      innerText: '每周 Grok Bot 限制',
      closest: () => grokBotCard,
      parentElement: grokBotCard
    };

    const dialog = {
      querySelectorAll: sel => {
        if (sel.includes('button') || sel.includes('tab')) return [usageTab];
        if (sel.includes('h3')) return [h3Super, h3Bot];
        return [];
      },
      querySelector: sel => {
        if (sel.includes('关闭') || sel.includes('Close')) return closeBtn;
        return null;
      },
      dispatchEvent: () => {}
    };

    globalThis.document = {
      querySelector: sel => {
        if (sel.includes('Account menu')) return accountBtn;
        if (sel.includes('dialog')) return dialog;
        return null;
      },
      querySelectorAll: sel => {
        if (sel.includes('menuitem') || sel.includes('menu')) return [settingsMenuItem];
        return [];
      }
    };

    const result = await inspectGrokComUsageOnPage();
    assert.equal(result.ok, true);
    assert.equal(result.superGrok.usedPercent, 99);
    assert.equal(result.superGrok.remainingPercent, 1);
    assert.equal(result.superGrok.isExhausted, true); // 1% <= 2% => exhausted!
    assert.equal(result.superGrok.resetAt, '2026年10月20日 14:09');

    assert.equal(result.grokBot.usedPercent, 0);
    assert.equal(result.grokBot.remainingPercent, 100);
    assert.equal(result.grokBot.isAvailable, true); // 100% > 5% => available!
    assert.equal(result.grokBot.resetAt, '2026年10月25日 17:09');
  } finally {
    globalThis.document = prevDoc;
    globalThis.location = prevLoc;
  }
});

test('inspectGrokBotsOnPage extracts bots from localStorage directory and sidebar', () => {
  const prevDoc = globalThis.document;
  const prevStorage = globalThis.localStorage;

  try {
    const mockDirectory = JSON.stringify([
      { agentId: '98b6fbba-c668-4f4f-b6ae-c883fb001850', name: '幕僚长', description: '专为深度分析打造' }
    ]);
    globalThis.localStorage = {
      getItem: key => key === 'grok-bot-mention-directory' ? mockDirectory : null
    };

    globalThis.document = {
      querySelectorAll: () => []
    };

    const res = inspectGrokBotsOnPage();
    assert.equal(res.ok, true);
    assert.equal(res.bots.length, 1);
    assert.equal(res.bots[0].name, '幕僚长');
    assert.equal(res.bots[0].agentId, '98b6fbba-c668-4f4f-b6ae-c883fb001850');
  } finally {
    globalThis.document = prevDoc;
    globalThis.localStorage = prevStorage;
  }
});

test('switchToGrokBotOnPage clicks bot link or detects already active bot session', async () => {
  const prevDoc = globalThis.document;

  try {
    let clicked = false;
    const botLink = {
      tagName: 'A',
      innerText: '幕僚长',
      closest: () => botLink,
      getAttribute: () => null,
      classList: { contains: () => false },
      click: () => { clicked = true; }
    };

    globalThis.document = {
      querySelector: sel => {
        if (sel.includes('placeholder') || sel.includes('contenteditable') || sel.includes('textarea')) {
          return {
            tagName: 'TEXTAREA',
            getAttribute: attr => (attr === 'placeholder' ? (clicked ? '消息 幕僚长' : '输入消息...') : null)
          };
        }
        return null;
      },
      querySelectorAll: () => [botLink]
    };

    const res = await switchToGrokBotOnPage('幕僚长');
    assert.equal(res.ok, true);
    assert.equal(res.botName, '幕僚长');
    assert.equal(clicked, true);
  } finally {
    globalThis.document = prevDoc;
  }
});

test('detectGrokVerificationOnPage suppresses CF false alarms when Turnstile token is present', () => {
  const prevDoc = globalThis.document;
  const prevLoc = globalThis.location;

  try {
    globalThis.location = { hostname: 'grok.com', href: 'https://grok.com/' };

    // Turnstile iframe present, but token already solved (>20 chars) and composer is ready
    const frame = {
      tag: 'iframe',
      src: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/v0/api.js',
      getAttribute: () => 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/v0/api.js',
      getBoundingClientRect: () => ({ width: 300, height: 65 })
    };

    const tokenInput = {
      value: '0.AbcDef1234567890XyZ_TurnstileTokenValidLongerThan20Chars',
      getAttribute: attr => attr === 'value' ? '0.AbcDef1234567890XyZ_TurnstileTokenValidLongerThan20Chars' : null
    };

    const composer = {
      tagName: 'TEXTAREA',
      getBoundingClientRect: () => ({ width: 400, height: 100 })
    };

    globalThis.document = {
      title: 'Grok',
      body: { innerText: 'Welcome to Grok' },
      querySelectorAll: sel => {
        if (sel.includes('iframe')) return [frame];
        if (sel.includes('cf-turnstile-response')) return [tokenInput];
        if (sel.includes('textarea')) return [composer];
        return [];
      },
      querySelector: sel => {
        if (sel.includes('textarea')) return composer;
        if (sel.includes('cf-turnstile-response')) return tokenInput;
        return null;
      }
    };

    const res = detectGrokVerificationOnPage();
    assert.equal(res, null, 'Solved Turnstile challenge must not trigger blocking alert');
  } finally {
    globalThis.document = prevDoc;
    globalThis.location = prevLoc;
  }
});

test('switchToGrokBotOnPage returns failure when bot entry not found or transition times out', async () => {
  const prevDoc = globalThis.document;
  try {
    // 1. Bot entry not found in DOM
    globalThis.document = {
      querySelector: () => null,
      querySelectorAll: () => []
    };
    const notFound = await switchToGrokBotOnPage('不存在的Bot');
    assert.equal(notFound.ok, false);
    assert.match(notFound.reason, /未在页面中找到 Grok Bot/);

    // 2. Clickable link found, but page fails to transition to bot session within timeout
    // Even if a normal composer exists, it must FAIL and not falsely report success
    let linkClicked = false;
    const botLink = {
      tagName: 'BUTTON',
      innerText: '幕僚长',
      closest: () => botLink,
      getAttribute: () => null,
      classList: { contains: () => false },
      click: () => { linkClicked = true; }
    };
    const normalComposer = {
      tagName: 'TEXTAREA',
      getAttribute: attr => attr === 'placeholder' ? '向 Grok 发送消息...' : null // Regular Chinese Grok placeholder, not Bot!
    };

    globalThis.document = {
      querySelector: sel => {
        if (sel.includes('placeholder') || sel.includes('contenteditable') || sel.includes('textarea')) {
          return normalComposer;
        }
        return null;
      },
      querySelectorAll: () => [botLink]
    };

    const timeoutRes = await switchToGrokBotOnPage('幕僚长');
    assert.equal(linkClicked, true);
    assert.equal(timeoutRes.ok, false);
    assert.match(timeoutRes.reason, /超时或未能确认目标会话就绪/);
  } finally {
    globalThis.document = prevDoc;
  }
});

test('readGrokComTurnAnswerOnPage distinguishes Chinese ordinary Grok from Bot chat and detects inline quota cards', () => {
  const prevDoc = globalThis.document;
  const prevLoc = globalThis.location;

  try {
    globalThis.location = { hostname: 'grok.com', pathname: '/c/test-session-uuid' };

    const userMessage = {
      getAttribute: attr => attr === 'data-testid' ? 'user-message' : null,
      textContent: '用户提问 nonce_12345'
    };

    const mdContent = {
      className: 'response-content-markdown',
      innerText: '这是 Grok 正在生成的回答正文...'
    };

    const assistantMessage = {
      getAttribute: attr => attr === 'data-testid' ? 'assistant-message' : null,
      querySelector: sel => sel.includes('response-content-markdown') ? mdContent : null,
      querySelectorAll: () => [],
      parentElement: { children: [userMessage] }
    };

    // 1. Chinese normal Grok session without follow-up questions
    // In Chinese interface, placeholder is "向 Grok 发送消息"
    const normalComposer = {
      getAttribute: attr => attr === 'placeholder' ? '向 Grok 发送消息...' : null
    };

    globalThis.document = {
      querySelector: sel => {
        if (sel.includes('placeholder')) return normalComposer;
        return null;
      },
      querySelectorAll: sel => {
        if (sel.includes('user-message')) return [userMessage, assistantMessage];
        if (sel.includes('button')) return [];
        return [];
      }
    };

    const normalRes = readGrokComTurnAnswerOnPage('nonce_12345', []);
    // Must NOT be marked done prematurely in normal Grok because recommendations are not yet present!
    assert.equal(normalRes.done, false, 'Chinese ordinary Grok without recommendations must NOT be marked done');

    // 2. Explicit Bot channel: completion does not wait for follow-up questions
    const botRes = readGrokComTurnAnswerOnPage('nonce_12345', [], { isBotChannel: true });
    assert.equal(botRes.done, true, 'Bot channel with non-empty text and no stop buttons is done');

    // 3. Inline Quota Updated Card with Retry button:
    const retryBtn = {
      innerText: '重试',
      getAttribute: () => null
    };
    const quotaCardAssistant = {
      getAttribute: attr => attr === 'data-testid' ? 'assistant-message' : null,
      innerText: '您的使用上限已更新。您现在可以继续了。',
      querySelector: () => null,
      querySelectorAll: sel => sel.includes('button') ? [retryBtn] : []
    };

    globalThis.document = {
      querySelector: () => null,
      querySelectorAll: sel => {
        if (sel.includes('user-message')) return [userMessage, quotaCardAssistant];
        return [];
      }
    };

    const quotaUpdatedRes = readGrokComTurnAnswerOnPage('nonce_12345', []);
    assert.equal(quotaUpdatedRes.done, false);
    assert.equal(quotaUpdatedRes.quotaPrompt?.type, 'quota_updated_retry_available');
    assert.equal(quotaUpdatedRes.quotaPrompt?.canRetry, true);

    // 4. Inline Quota Exhausted Card without Retry button:
    const quotaExhaustedAssistant = {
      getAttribute: attr => attr === 'data-testid' ? 'assistant-message' : null,
      innerText: '已达到使用上限。请稍后再试。',
      querySelector: () => null,
      querySelectorAll: () => []
    };

    globalThis.document = {
      querySelector: () => null,
      querySelectorAll: sel => {
        if (sel.includes('user-message')) return [userMessage, quotaExhaustedAssistant];
        return [];
      }
    };

    const quotaExhaustedRes = readGrokComTurnAnswerOnPage('nonce_12345', []);
    assert.equal(quotaExhaustedRes.done, false);
    assert.equal(quotaExhaustedRes.quotaPrompt?.type, 'quota_exhausted');
    assert.equal(quotaExhaustedRes.failed, true);
  } finally {
    globalThis.document = prevDoc;
    globalThis.location = prevLoc;
  }
});

test('detectGrokVerificationOnPage does not let stale turnstile token bypass active challenge UI', () => {
  const prevDoc = globalThis.document;
  const prevLoc = globalThis.location;

  try {
    globalThis.location = { hostname: 'grok.com', href: 'https://grok.com/' };

    // Visible challenge iframe
    const challengeFrame = {
      tag: 'iframe',
      src: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/v0/api.js',
      getAttribute: () => 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/v0/api.js',
      getBoundingClientRect: () => ({ width: 300, height: 65 })
    };

    // Stale token in DOM from previous turn
    const tokenInput = {
      value: '0.AbcDef1234567890XyZ_TurnstileTokenValidLongerThan20Chars',
      getAttribute: attr => attr === 'value' ? '0.AbcDef1234567890XyZ_TurnstileTokenValidLongerThan20Chars' : null
    };

    // But page body and active challenge UI are currently displayed!
    const challengeStage = {
      id: 'challenge-stage',
      getBoundingClientRect: () => ({ width: 300, height: 200 })
    };

    globalThis.document = {
      title: 'Just a moment...',
      body: { innerText: 'Cloudflare security verification. Verify you are human.' },
      querySelectorAll: sel => {
        if (sel.includes('iframe')) return [challengeFrame];
        if (sel.includes('cf-turnstile-response')) return [tokenInput];
        if (sel.includes('challenge-stage')) return [challengeStage];
        return [];
      },
      querySelector: sel => {
        if (sel.includes('cf-turnstile-response')) return tokenInput;
        return null;
      }
    };

    const res = detectGrokVerificationOnPage();
    assert.notEqual(res, null, 'Active challenge UI with stale token must NOT be suppressed');
    assert.equal(res.provider, 'cloudflare');
    assert.ok(res.signals.includes('cf-challenge-iframe'));
  } finally {
    globalThis.document = prevDoc;
    globalThis.location = prevLoc;
  }
});
