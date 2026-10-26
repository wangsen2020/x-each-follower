// Resolve the live account for each operation; persisted queue bindings can be stale.
export function createKnowledgeOwner({resolve, timeoutMs = 30000}) {
  async function current() {
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(resolve),
        new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('账号核验超时，请确认 X 已登录后重试')), timeoutMs);})
      ]);
      if (!result?.ok || !/^\d+$/.test(String(result.accountId || ''))) {
        throw new Error(result?.error || '无法确认当前 X 账号，请登录 X 后重试');
      }
      return String(result.accountId);
    } finally { clearTimeout(timer); }
  }
  return {
    current,
    async assert(expected) {
      const actual = await current();
      if (!expected || actual !== String(expected)) throw new Error('X 账号已变化，请刷新知识库后重试，当前操作未写入');
      return actual;
    }
  };
}
