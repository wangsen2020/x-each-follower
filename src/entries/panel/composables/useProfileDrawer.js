import { ref, computed } from 'vue';
import { evaluateMutualProfile, repairMojibake } from '../../../features/relationships/scoring.js';

/**
 * Checks whether an account has a verified badge (Blue V).
 * @param {Object} user 
 * @param {Object|null} cached 
 * @returns {boolean}
 */
export function isUserVerified(user, cached = null) {
  if (!user && !cached) return false;
  return Boolean(
    user?.is_blue_verified ||
    cached?.is_blue_verified ||
    user?.isBlueVerified ||
    cached?.isBlueVerified ||
    user?.verified ||
    cached?.verified ||
    /蓝V|Blue\s*Verified/i.test(`${user?.name || ''} ${cached?.name || ''} ${user?.bio || ''}`)
  );
}

/**
 * Composable for managing user profile drawer state and actions.
 */
export function useProfileDrawer() {
  const isOpen = ref(false);
  const user = ref(null);
  const loading = ref(false);
  const mode = ref('profile'); // 'profile' | 'commentPosts'
  const copyStatus = ref('idle'); // 'idle' | 'copied' | 'failed'
  let refreshHandler = null;

  function setRefreshHandler(fn) {
    refreshHandler = fn;
  }

  function open(userData, drawerMode = 'profile') {
    user.value = userData ? { ...userData } : null;
    mode.value = drawerMode;
    copyStatus.value = 'idle';
    isOpen.value = true;
  }

  function close() {
    isOpen.value = false;
  }

  function updateUser(newData) {
    if (user.value && newData) {
      user.value = { ...user.value, ...newData };
    }
  }

  const name = computed(() => {
    if (!user.value) return '';
    return repairMojibake(user.value.name) || `@${user.value.handle || ''}`;
  });

  const handle = computed(() => {
    return user.value?.handle || '';
  });

  const avatarUrl = computed(() => {
    return user.value?.avatarUrl || '';
  });

  const avatarInitial = computed(() => {
    const raw = repairMojibake(user.value?.name) || user.value?.handle || '?';
    return String(raw).slice(0, 1).toUpperCase();
  });

  const verified = computed(() => {
    return isUserVerified(user.value);
  });

  const bio = computed(() => {
    return repairMojibake(user.value?.bio) || '暂无简介';
  });

  const evalResult = computed(() => {
    if (!user.value) {
      return {
        tag: '无',
        recommendLabel: '待评估',
        recommendReason: '未获取资料',
        isNotRecommended: false,
        multiTags: { tags: [] }
      };
    }
    return evaluateMutualProfile(user.value);
  });

  const tagSourceSuffix = computed(() => {
    const s = evalResult.value.intentSource;
    if (s === 'posts') return '（帖子命中）';
    if (s === 'grok') return '（Grok）';
    return '';
  });

  const multiTags = computed(() => {
    return (evalResult.value.multiTags?.tags || []).filter(t => t.id !== 'identity:blue_v');
  });

  const mutualReasonLines = computed(() => {
    const ev = evalResult.value;
    const lines = [ev.recommendReason || ''];
    if (ev.postKeywordHits?.length) {
      lines.push(`首页前 ${ev.postCount} 条帖子关键词命中：${ev.postKeywordHits.join('、')}`);
    }
    if (ev.bioKeywordHits?.length) {
      lines.push(`简介/名称关键词命中：${ev.bioKeywordHits.join('、')}`);
    }
    if (!ev.keywordHits?.length) {
      lines.push(ev.postCount > 0 ? `已检查简介与前 ${ev.postCount} 条帖子：未命中互粉关键词` : '尚未读取首页帖子，点击“采集资料”可扫描前 5-10 条帖子关键词');
    }
    if (typeof user.value?.grokMutualIntent === 'boolean') {
      lines.push(`Grok 互粉倾向：${user.value.grokMutualIntent ? '有互粉倾向' : '无互粉倾向'}${user.value.grokReason ? `（${user.value.grokReason}）` : ''}`);
    }
    return lines.filter(Boolean);
  });

  const risk = computed(() => {
    return user.value?.risk || evalResult.value.risk || { level: 'safe', hits: [] };
  });

  const recentPosts = computed(() => {
    if (mode.value === 'commentPosts') {
      return user.value?.recentPosts || user.value?.posts || [];
    }
    return user.value?.posts || [];
  });

  const recentPostsTitle = computed(() => {
    if (mode.value === 'commentPosts') {
      return `近期帖子历史（${recentPosts.value.length}/100）`;
    }
    return '最近帖子（用于互粉关键词匹配）';
  });

  const grokComment = computed(() => {
    return user.value?.grokComment || '';
  });

  const grokCommentPost = computed(() => {
    return user.value?.grokCommentPost || '';
  });

  const grokCommentPostUrl = computed(() => {
    return user.value?.grokCommentPostUrl || '';
  });

  async function copyGrokComment() {
    if (!grokComment.value) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(grokComment.value);
        copyStatus.value = 'copied';
        setTimeout(() => {
          if (copyStatus.value === 'copied') copyStatus.value = 'idle';
        }, 1800);
      }
    } catch {
      copyStatus.value = 'failed';
      setTimeout(() => {
        if (copyStatus.value === 'failed') copyStatus.value = 'idle';
      }, 1800);
    }
  }

  function openOnX() {
    const h = handle.value;
    if (!h) return;
    const url = `https://x.com/${h}`;
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      chrome.tabs.create({ url, active: true });
    } else if (typeof window !== 'undefined') {
      window.open(url, '_blank');
    }
  }

  async function triggerRefresh() {
    if (loading.value || !user.value) return;
    if (refreshHandler) {
      loading.value = true;
      try {
        await refreshHandler(user.value, mode.value);
      } finally {
        loading.value = false;
      }
    }
  }

  return {
    isOpen,
    user,
    loading,
    mode,
    copyStatus,
    name,
    handle,
    avatarUrl,
    avatarInitial,
    verified,
    bio,
    evalResult,
    tagSourceSuffix,
    multiTags,
    mutualReasonLines,
    risk,
    recentPosts,
    recentPostsTitle,
    grokComment,
    grokCommentPost,
    grokCommentPostUrl,
    open,
    close,
    updateUser,
    copyGrokComment,
    openOnX,
    triggerRefresh,
    setRefreshHandler
  };
}

export const profileDrawerController = useProfileDrawer();
