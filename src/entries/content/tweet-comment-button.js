(() => {
  if (window.__xefCommentButtonObserver) return;
  window.__xefCommentButtonObserver = true;
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-5.2A7.5 7.5 0 1 1 20 11.5Z"/><path d="M12 7v7m-3-3 3 3 3-3"/></svg>';
  const X_LEADERBOARD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
  const PENDING_STORAGE_KEY = '__xef_pending_comment_track_post';
  const RETRY_STORAGE_KEY = '__xef_comment_track_context_retry';

  const membershipCache = new Map();

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

  function addCommentButton(tweet, post, actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.xefCommentTracker = 'true';
    button.dataset.tweetId = post.tweetId;
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

  function queryLeaderboardMembership(post, button) {
    const handle = post.authorHandle;
    if (membershipCache.has(handle)) {
      const cached = membershipCache.get(handle);
      if (typeof cached === 'boolean') {
        applyLeaderboardButtonState(button, cached, handle);
        return;
      }
      if (cached && typeof cached.then === 'function') {
        cached.then(isMember => {
          if (button.isConnected !== false && typeof isMember === 'boolean') applyLeaderboardButtonState(button, isMember, handle);
          else if(button.isConnected !== false){button.disabled=true;button.dataset.state='unverified';button.title='榜单状态暂不可用，请稍后刷新页面';}
        }).catch(() => {});
        return;
      }
    }

    try {
      if (isContextInvalidated())throw new Error('扩展上下文已更新');
      const p = Promise.resolve().then(() => {
        if (isContextInvalidated())throw new Error('扩展上下文已更新');
        return chrome.runtime.sendMessage({
          cmd: 'xLeaderboard',
          action: 'membership',
          handle: post.authorHandle,
          tweetId: post.tweetId,
          url: post.url
        });
      }).then(res => {
        if(!res?.ok)throw new Error(res?.error || '榜单成员状态读取失败');
        const isMember = Boolean(res.member);
        membershipCache.set(handle, isMember);
        return isMember;
      }).catch(error => {
        membershipCache.delete(handle);
        button.dataset.state='unverified';
        button.disabled=true;
        button.title=`榜单状态暂不可用：${String(error?.message || error)}`;
        return null;
      });

      membershipCache.set(handle, p);
      p.then(isMember => {
        if (button.isConnected !== false && typeof isMember === 'boolean') applyLeaderboardButtonState(button, isMember, handle);
      }).catch(() => {});
    } catch {}
  }

  function applyLeaderboardButtonState(btn, isMember, handle) {
    btn.dataset.member = isMember ? 'true' : 'false';
    btn.setAttribute('aria-pressed', isMember ? 'true' : 'false');
    const label = isMember ? `移出 X 榜单 (@${handle})` : `加入 X 榜单 (@${handle})`;
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }

  function syncLeaderboardButtons(handle, isMember) {
    membershipCache.set(handle, isMember);
    document.querySelectorAll(`[data-xef-leaderboard-btn][data-author-handle="${handle}"]`).forEach(btn => {
      applyLeaderboardButtonState(btn, isMember, handle);
      btn.disabled = false;
      delete btn.dataset.state;
    });
  }

  function addLeaderboardButton(tweet, post, actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.xefLeaderboardBtn = 'true';
    button.dataset.tweetId = post.tweetId;
    button.dataset.authorHandle = post.authorHandle;
    button.dataset.member = 'false';
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', `加入 X 榜单 (@${post.authorHandle})`);
    button.title = `加入 X 榜单 (@${post.authorHandle})`;
    button.innerHTML = X_LEADERBOARD_ICON;

    queryLeaderboardMembership(post, button);

    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;

      if (isContextInvalidated()) {
        toast('扩展上下文已更新，请刷新页面后重试。', true);
        return;
      }

      const isMember = button.dataset.member === 'true';
      const nextAction = isMember ? 'remove' : 'add';
      button.disabled = true;
      button.dataset.state = 'loading';

      chrome.runtime.sendMessage({
        cmd: 'xLeaderboard',
        action: nextAction,
        handle: post.authorHandle,
        tweetId: post.tweetId,
        url: post.url
      }).then(response => {
        if (!response?.ok) {
          button.disabled = false;
          delete button.dataset.state;
          applyLeaderboardButtonState(button, isMember, post.authorHandle);
          toast(response?.error || `${nextAction === 'add' ? '加入' : '移出'} X 榜单失败`, true);
          return;
        }
        const newMemberState = !!response.member;
        syncLeaderboardButtons(post.authorHandle, newMemberState);
        toast(newMemberState ? `已将 @${post.authorHandle} 加入 X 榜单` : `已将 @${post.authorHandle} 移出 X 榜单`);
      }).catch(error => {
        button.disabled = false;
        delete button.dataset.state;
        applyLeaderboardButtonState(button, isMember, post.authorHandle);
        toast(String(error?.message || error || '操作异常'), true);
      });
    });

    actions.append(button);
  }

  function addButtons(tweet) {
    const post = postDetails(tweet);
    const actions = [...tweet.querySelectorAll('[role="group"]')]
      .find(group => group.querySelector('[data-testid="reply"], [data-testid="like"]'));
    if (!post || !actions) return;

    for(const existing of actions.querySelectorAll?.('[data-xef-leaderboard-btn], [data-xef-comment-tracker]')||[]){
      if(existing.dataset.tweetId!==post.tweetId)existing.remove();
    }

    if (!(actions.querySelectorAll ? actions.querySelector('[data-xef-leaderboard-btn]') : tweet.querySelector('[data-xef-leaderboard-btn]'))) {
      addLeaderboardButton(tweet, post, actions);
    }
    if (!(actions.querySelectorAll ? actions.querySelector('[data-xef-comment-tracker]') : tweet.querySelector('[data-xef-comment-tracker]'))) {
      addCommentButton(tweet, post, actions);
    }
  }

  function scan(root = document) {
    if (root instanceof Element && root.matches('[data-testid="tweet"]')) addButtons(root);
    root.querySelectorAll?.('[data-testid="tweet"]').forEach(addButtons);
  }

  const start = () => {
    checkPendingTrack();
    scan();
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) if (node instanceof Element){
        scan(node);
        const tweet=node.closest('[data-testid="tweet"]');
        if(tweet)addButtons(tweet);
      }
    });
    observer.observe(document.body, {childList:true, subtree:true});
    document.addEventListener?.('visibilitychange',()=>{
      if(document.hidden)return;
      membershipCache.clear();
      for(const button of document.querySelectorAll('[data-xef-leaderboard-btn]')){
        button.disabled=false;delete button.dataset.state;
        const tweet=button.closest('[data-testid="tweet"]'),post=tweet&&postDetails(tweet);
        if(post)queryLeaderboardMembership(post,button);
      }
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
  else start();
})();
