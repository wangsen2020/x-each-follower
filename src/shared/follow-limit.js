export const ACCOUNT_FOLLOW_LIMIT_MESSAGE = 'X 拒绝继续关注（错误 161）。可能涉及每日额度、关注速度、关注比例或账号限制；请在 X 核实。';

const FOLLOW_LIMIT_PHRASE = /You are unable to follow more people at this time\./i;
const FOLLOW_LIMIT_WITH_LINK = /You are unable to follow more people at this time\.(?:\s*Learn more\s*<a\b[^>]*>here<\/a>\.)?/i;

export function isAccountFollowLimit(response) {
  return response?.followLimit === true || response?.json?.errors?.some(error => Number(error?.code) === 161) === true ||
    FOLLOW_LIMIT_PHRASE.test(String(response?.error || response?.reason || ''));
}

export function displayFollowLimitError(value) {
  const message = String(value || '');
  return FOLLOW_LIMIT_PHRASE.test(message) ? message.replace(FOLLOW_LIMIT_WITH_LINK, ACCOUNT_FOLLOW_LIMIT_MESSAGE) : message;
}
