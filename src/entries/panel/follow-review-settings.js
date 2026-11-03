import {normalizeFanRemovalRules} from '../../features/relationships/fan-removal-rules.js';
import {normalizeFanAutomation,validateFanAutomation,mergeFanAutomation} from '../../features/relationships/fan-automation-settings.js';
import {reviewIntervalRange, validReviewInterval} from '../../features/relationships/review-pacing.js';
import {getLocalAiService, isLocalAiProvider} from '../../features/grok/grok-local.js';
import {grokBotRelay} from '../../features/grok/grok-bot-relay.js';
import {awaitSettingsResponse} from './settings-response.js';
export {awaitSettingsResponse} from './settings-response.js';

export const FOLLOW_REVIEW_SETTINGS_EVENT = 'xfollower:follow-review-settings';
export const FOLLOW_REVIEW_SETTINGS_UPDATED_EVENT = 'xfollower:follow-review-settings-updated';
export const FOLLOW_REVIEW_ROLES = Object.freeze(['fanTagging', 'queueTagging', 'commentEngine']);
export const FOLLOW_REVIEW_ENGINE_OPTIONS = Object.freeze([
  {value:'grok-local', label:'Grok Bot'},
  {value:'codex', label:'Codex'},
  {value:'antigravity', label:'Antigravity'},
  {value:'grok', label:'X Grok'},
  {value:'grok-bot', label:'云端事件'}
]);
export const FOLLOW_REVIEW_TIPS = Object.freeze({
  initialReviewEnabled:'默认关闭。开启后，有画像简介即可批量 AI 初审；已有的关联帖子和粉丝数据一并参考，没有补充数据也照常审核。缺少简介及有效帖子时进入待核实，由自动核实补充资料。通过加入待回关和关注队列，不通过移除关注者，资料不足进入待核实。关闭时直接放行入队。是否继续队列筛选由“跳过粉丝”控制。',
  followBackSkipRules:'开启后，粉丝渠道已通过前置审核或已放行的账号跳过重复过滤与 AI 审核，先关注，再进入评价流程；是否仍为粉丝不影响已授权的关注。仍确认目标账号、关注是否已执行及最新审核凭据。其他渠道照常筛选。'
});

const providers = new Set(FOLLOW_REVIEW_ENGINE_OPTIONS.map(item => item.value));
const roleLabels = {fanTagging:'粉丝初审', queueTagging:'队列打标', commentEngine:'评论引擎'};
const bounded = (value, fallback, min, max) => value === '' || value == null || !Number.isFinite(Number(value))
  ? fallback : Math.min(max, Math.max(min, Math.round(Number(value))));

export function normalizeFollowReviewSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const result = {
    initialReviewEnabled:source.initialReviewEnabled === true,
    automation:normalizeFanAutomation(source.automation),
    removalRules:normalizeFanRemovalRules(source.removalRules),
    followBackSkipRules:source.followBackSkipRules === true,
    ratioLimit:bounded(source.ratioLimit, 10, 1, 1000)
  };
  for (const role of FOLLOW_REVIEW_ROLES) {
    const value = source[role] && typeof source[role] === 'object' ? source[role] : {};
    result[role] = {
      provider:providers.has(value.provider) ? value.provider : '',
      botId:typeof value.botId === 'string' ? value.botId.trim() : '',
      prompt:typeof value.prompt === 'string' ? value.prompt : ''
    };
    if (role !== 'commentEngine') Object.assign(result[role], {
      batchSize:bounded(value.batchSize, 10, 1, 50),
      ...(role==='fanTagging'?reviewIntervalRange(value):{intervalSeconds:bounded(value.intervalSeconds,3,0,300)})
    });
  }
  return result;
}

export function followReviewSettingsPatch(input, scope) {
  const value = normalizeFollowReviewSettings(input);
  if (scope === 'fans') return {initialReviewEnabled:value.initialReviewEnabled, automation:value.automation, removalRules:value.removalRules, fanTagging:value.fanTagging};
  if (scope === 'queue') return {followBackSkipRules:value.followBackSkipRules, ratioLimit:value.ratioLimit,
    queueTagging:value.queueTagging, commentEngine:value.commentEngine};
  throw new Error('无效的审核设置入口');
}

// Missing roles may be saved for later configuration; configured roles must be isolated.
export function validateFollowReviewSettings(input) {
  validateFanAutomation(input.automation);
  const inRange = (value, min, max) => value !== '' && value != null && Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
  if (!inRange(input.ratioLimit, 1, 1000)) throw new Error('异常关注比例须为 1–1000 的整数');
  const result = normalizeFollowReviewSettings(input);
  const selected = new Map();
  for (const role of FOLLOW_REVIEW_ROLES) {
    const value = result[role];
    if (role !== 'commentEngine' && (!inRange(input[role]?.batchSize, 1, 50) || !(role==='fanTagging'?validReviewInterval(input[role]):inRange(input[role]?.intervalSeconds,0,300)))) throw new Error('每批人数须为 1–50，批次间隔须为 0–300 秒且最长不小于最短');
    if (value.prompt.length > 6000) throw new Error('审核或评论提示词不能超过 6000 个字符');
    if (!value.provider) continue;
    if (!isLocalAiProvider(value.provider)) throw new Error('所选引擎不支持独立会话，请选择 Grok Bot、Codex 或 Antigravity');
    if (!value.botId) throw new Error('请为所选 AI 引擎选择独立会话');
    const key = value.provider + '\n' + value.botId;
    if (selected.has(key)) throw new Error('粉丝初审、队列打标和评论引擎必须使用各自独立的会话');
    selected.set(key, roleLabels[role]);
  }
  return result;
}

export async function saveFollowReviewSettings(input, scope, request, {timeoutMs=8000}={}) {
  const settings = followReviewSettingsPatch(validateFollowReviewSettings(input), scope);
  const response = await awaitSettingsResponse(()=>request({cmd:'followQueueSaveReviewSettings', settings}),{timeoutMs,message:'保存响应超时，状态待确认。输入已保留，请重新读取设置后确认。'});
  if (!response?.ok) throw new Error(response?.error || '审核设置保存失败');
  return response;
}

export function followReviewBindingStatus(config={},state={},dirty=false) {
  if(dirty)return {state:'unsaved',label:'有未保存的修改'};
  if(!config.provider || !config.botId)return {state:'unconfigured',label:'尚未配置'};
  if(state.loading)return {state:'checking',label:'已保存 · 正在检测'};
  if(state.error || state.supported===false || state.connected===false)return {state:'error',label:'已保存 · 连接异常'};
  if(state.connected && state.sessions?.some(session=>session.id===config.botId))return {state:'ready',label:'已保存 · 连接正常'};
  if(state.connected)return {state:'error',label:'已保存 · 会话不可用'};
  return {state:'saved',label:'已保存 · 尚未检测'};
}

// Read-only inspection. Never selectBot, saveConfig or selectGrokProvider here.
export async function readFollowReviewSessions(provider, {getService = getLocalAiService, webhook = grokBotRelay} = {}) {
  if (!provider) return {connected:false, supported:true, sessions:[]};
  if (provider === 'grok') return {connected:false, supported:false, sessions:[],
    reason:'X Grok 网页通道不支持独立会话，不能用于专用初审、打标或评论引擎。'};
  if (provider === 'grok-bot') {
    const status = await webhook.status();
    return {connected:Boolean(status.enabled), supported:false, sessions:[],
      reason:'云端事件通道使用共享绑定，暂不支持为三个职责分别选择独立会话。'};
  }
  if (!isLocalAiProvider(provider)) throw new Error('请选择 AI 引擎');
  const service = getService(provider);
  const status = await service.status();
  if (!status.enabled) return {connected:false, supported:true, sessions:[], reason:'请先在系统设置连接并测试所选 AI 引擎'};
  if(status.state && !status.connected)return {connected:false,supported:true,sessions:[],loading:status.state==='checking',reason:status.reason||'统一连接检测进行中'};
  const rows = status.sessions || await service.list(await service.configuration());
  const sessions = rows.filter(row => row && typeof row.id === 'string' && row.id).map(row => {
    const clean = value => String(value || '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,' ').replace(/\s+/g,' ').trim();
    const title = clean(row.title || row.name) || '未命名会话';
    return {id:row.id, name:clean(row.name) || title, title};
  });
  return {connected:true, supported:true, sessions, reason:sessions.length ? '' : '当前引擎没有可用会话，请在系统设置创建或刷新会话'};
}

export function openFollowReviewSettings(scope, target = globalThis.document) {
  if (!['fans','queue'].includes(scope)) throw new Error('无效的审核设置入口');
  if (!target?.dispatchEvent) return false;
  return target.dispatchEvent(new CustomEvent(FOLLOW_REVIEW_SETTINGS_EVENT, {detail:{scope}}));
}
