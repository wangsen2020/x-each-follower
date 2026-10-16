(() => {
  if (window.__xefCommentButtonObserver) return;
  window.__xefCommentButtonObserver = true;
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-5.2A7.5 7.5 0 1 1 20 11.5Z"/><path d="M12 7v7m-3-3 3 3 3-3"/></svg>';
  const PENDING_STORAGE_KEY = '__xef_pending_comment_track_post';
  const RETRY_STORAGE_KEY = '__xef_comment_track_context_retry';

  function isContextInvalidated(error) {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id || typeof chrome.runtime?.sendMessage !== 'function') return true;
    const msg = String(error?.message || error || '');
    return /extension context invalidated|message port closed|receiving end does not exist|cannot read properties of undefined\s*\(reading ['"]sendMessage['"]\)/i.test(msg);
  }

  function handleAutoReloadOnInvalidContext(post) {
    let retryCount = 0;
    try {
      retryCount = Number(sessionStorage.getItem(RETRY_STORAGE_KEY)) || 0;
      if (retryCount >= 1) {
        sessionStorage.removeItem(PENDING_STORAGE_KEY);
        sessionStorage.removeItem(RETRY_STORAGE_KEY);
        toast('扩展上下文刷新后仍未恢复，请稍后手动刷新页面。', true);
        return;
      }
      if (post && post.tweetId) {
        sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(post));
      }
      sessionStorage.setItem(RETRY_STORAGE_KEY, String(retryCount + 1));
    } catch {}
    toast('扩展已更新，正在自动刷新页面并提取评论用户…');
    setTimeout(() => {
      location.reload();
    }, 600);
  }

  function postDetails(tweet) {
    const anchors = [...tweet.querySelectorAll('a[href*="/status/"]')]
      .filter(anchor => anchor.closest('[data-testid="tweet"]') === tweet);
    for (const anchor of anchors) {
      try {
        const url = new URL(anchor.href, location.origin);
        const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/i);
        if (match) return {authorHandle:match[1], tweetId:match[2], url:`https://x.com/${match[1]}/status/${match[2]}`};
      } catch {}
    }
    return null;
  }

  function toast(message, failed = false) {
    let node = document.querySelector('[data-xef-comment-toast]');
    if (!node) {
      node = document.createElement('div');
      node.dataset.xefCommentToast = 'true';
      node.setAttribute('role', 'status');
      document.body.append(node);
    }
    node.textContent = message;
    node.dataset.state = failed ? 'error' : 'info';
    clearTimeout(node.__xefTimer);
    node.__xefTimer = setTimeout(() => node.remove(), 4200);
  }

  function checkPendingTrack() {
    try {
      const pendingRaw = sessionStorage.getItem(PENDING_STORAGE_KEY);
      if (!pendingRaw) return;
      sessionStorage.removeItem(PENDING_STORAGE_KEY);
      const post = JSON.parse(pendingRaw);
      if (!post || !post.tweetId) return;

      toast(`已自动刷新，正在提取 @${post.authorHandle || ''} 帖子的评论用户…`);
      sendTrackMessage(post);
    } catch (e) {
      try { sessionStorage.removeItem(PENDING_STORAGE_KEY); } catch {}
    }
  }

  function sendTrackMessage(post, button = null) {
    const resetButton = () => {
      if (!button) return;
      button.disabled = false;
      delete button.dataset.state;
    };
    if (isContextInvalidated()) {
      handleAutoReloadOnInvalidContext(post);
      return;
    }

    try {
      const runtime = chrome.runtime;
      runtime.sendMessage({cmd:'trackTweetReplies', ...post}).then(response => {
        if (!response?.ok) {
          try { sessionStorage.removeItem(RETRY_STORAGE_KEY); } catch {}
          toast(response?.error || '无法启动评论读取', true);
          resetButton();
          return;
        }
        try { sessionStorage.removeItem(RETRY_STORAGE_KEY); } catch {}
        toast('评论用户已加入后台读取队列；结果会保存到 XFollower 评论追踪。');
        if (button) setTimeout(resetButton, 2500);
      }).catch(error => {
        if (isContextInvalidated(error)) {
          handleAutoReloadOnInvalidContext(post);
          return;
        }
        try { sessionStorage.removeItem(RETRY_STORAGE_KEY); } catch {}
        toast(String(error?.message || error || '无法启动评论读取'), true);
        resetButton();
      });
    } catch (error) {
      if (isContextInvalidated(error)) {
        handleAutoReloadOnInvalidContext(post);
        return;
      }
      try { sessionStorage.removeItem(RETRY_STORAGE_KEY); } catch {}
      toast(String(error?.message || error || '无法启动评论读取'), true);
      resetButton();
    }
  }

  function addButton(tweet) {
    if (tweet.querySelector('[data-xef-comment-tracker]')) return;
    const post = postDetails(tweet);
    const actions = [...tweet.querySelectorAll('[role="group"]')]
      .find(group => group.querySelector('[data-testid="reply"], [data-testid="like"]'));
    if (!post || !actions) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.xefCommentTracker = 'true';
    button.setAttribute('aria-label', '提取这条帖子的评论用户');
    button.title = '提取评论用户';
    button.innerHTML = ICON;
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;

      if (isContextInvalidated()) {
        handleAutoReloadOnInvalidContext(post);
        return;
      }

      button.disabled = true;
      button.dataset.state = 'loading';
      toast(`已排队读取 @${post.authorHandle} 帖子的评论用户…`);
      sendTrackMessage(post, button);
    });
    actions.append(button);
  }


  function scan(root = document) {
    if (root instanceof Element && root.matches('[data-testid="tweet"]')) addButton(root);
    root.querySelectorAll?.('[data-testid="tweet"]').forEach(addButton);
  }

  const start = () => {
    checkPendingTrack();
    scan();
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) scan(node);
    });
    observer.observe(document.body, {childList:true, subtree:true});
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
  else start();
})();
