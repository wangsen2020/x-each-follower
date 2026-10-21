import {appendQuoteTags} from './quote-tags.js';
import {appendFollowBackSuffix} from './grok-comment.js';

// Manual publication uses the same account-scoped tag settings as the queue.
export async function preparePanelQuoteText(text, language, followBackEnabled, api = chrome) {
  const {followQueueBinding: binding} = await api.storage.local.get('followQueueBinding');
  if (binding?.activated) {
    const result = await api.runtime.sendMessage({cmd:'followQueueSettings', accountId:binding.accountId});
    if (!result?.ok || !result.settings) throw new Error(result?.error || '无法读取引用标签设置，请重试');
    return appendQuoteTags(text, result.settings, language);
  }
  return followBackEnabled ? appendFollowBackSuffix(text, undefined, language) : text;
}
