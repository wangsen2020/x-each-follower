(() => {
  if (window.__xefCommentButtonObserver) return;
  window.__xefCommentButtonObserver = true;
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-5.2A7.5 7.5 0 1 1 20 11.5Z"/><path d="M12 7v7m-3-3 3 3 3-3"/></svg>';

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
      button.disabled = true;
      button.dataset.state = 'loading';
      toast(`已排队读取 @${post.authorHandle} 帖子的评论用户…`);
      try {
        chrome.runtime.sendMessage({cmd:'trackTweetReplies', ...post}, response => {
          if (chrome.runtime.lastError || !response?.ok) {
            const message = response?.error || chrome.runtime.lastError?.message || '无法启动评论读取';
            toast(message, true);
            button.disabled = false;
            delete button.dataset.state;
            return;
          }
          toast('评论用户已加入后台读取队列；结果会保存到 XFollower 评论追踪。');
          setTimeout(() => {
            button.disabled = false;
            delete button.dataset.state;
          }, 2500);
        });
      } catch (error) {
        toast(String(error?.message || error), true);
        button.disabled = false;
        delete button.dataset.state;
      }
    });
    actions.append(button);
  }

  function scan(root = document) {
    if (root instanceof Element && root.matches('[data-testid="tweet"]')) addButton(root);
    root.querySelectorAll?.('[data-testid="tweet"]').forEach(addButton);
  }

  const start = () => {
    scan();
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) scan(node);
    });
    observer.observe(document.body, {childList:true, subtree:true});
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
  else start();
})();
