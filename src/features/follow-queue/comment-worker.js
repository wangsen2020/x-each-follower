import {readXGrokUsageCooldown} from '../grok/grok-usage-limit.js';
import {readGrokProvider} from '../grok/grok-provider.js';

export const COMMENT_ALARM = 'x-independent-comments';
export const COMMENT_TASK_TIMEOUT_MS = 360000;

// No follow scheduler, follow API, follow retry counters or run budget in this worker.
// Intent and result use evaluations; resolveJob is deliberately never given a state.
export function createCommentWorker({store, storage, readBinding, execute, random, onSkip = async()=>{},
  isBusy = () => false, botAvailable=async()=>{try{return ['grok-bot','grok-local'].includes(await readGrokProvider(storage));}catch{return false;}}, now = Date.now, timeoutMs = COMMENT_TASK_TIMEOUT_MS} = {}) {
  let running = false;
  const save = (accountId, job, evaluation) => store.resolveJob({accountId,
    id:job.id, evaluations:[evaluation]});
  async function run() {
    if (running) return {busy:true};
    running = true;
    try {
      const binding = await readBinding();
      if (!binding?.activated) return {inactive:true};
      const accountId = binding.accountId;
      const settings = await store.getSettings(accountId);
      if (!settings.grokEnabled) return {disabled:true};
      const jobs = await store.listByState({accountId, state:'followed'});
      // Service-worker interruption may have happened after an external publish.
      // Never blindly resubmit an interrupted task; manual retry verifies first.
      for (const job of jobs) for (const ev of job.evaluations || []) {
        if (!isBusy(job) && ev.automaticComment && ['processing','publishing'].includes(ev.status)) {
          await save(accountId, job, {...ev,status:'uncertain',reason:'评论执行被中断，请核实后重试'});
        }
      }
      if (settings.quoteParticipationRate === 0) return {paused:true,reason:'创作概率为 0%，自动生成已暂停'};
      const ready = ev => {
        if(!ev.automaticComment || ev.recoveryDraftOnly || ev.retryAt > now())return false;
        if(ev.status==='pending')return true;
        const publicationEvidence=ev.publishedAttemptedAt || ev.publishedPostId || ev.publishedPostUrl || ev.articleDraftUrl
          || (Array.isArray(ev.attempts) && ev.attempts.some(a=>/publish|发布/i.test(String(a?.stage || ''))));
        return ev.status==='uncertain' && ev.reasonCode==='bot_pending' && Boolean(ev.relayJobId) && !ev.text && !publicationEvidence;
      };
      // A waiting Bot task must not occupy the head forever. Persist the turn
      // on each evaluation so fairness survives a service-worker restart.
      const lastTurn = ({job, ev}) => {
        return [ev.commentAttemptedAt, ev.generationAttemptedAt, job.createdAt]
          .find(value=>Number.isFinite(value) && value>0) || 0;
      };
      const candidates = jobs.filter(row => !isBusy(row)).flatMap(job =>
        (job.evaluations || []).filter(ready).map(ev => ({job, ev})));
      candidates.sort((a,b)=>lastTurn(a)-lastTurn(b));
      if (!candidates.length) return {idle:true};
      const {job, ev} = candidates[0];
      // Existing drafts are paid-for work; legacy pending tasks are sampled once.
      if (!ev.text) {
        const sampled = await store.ensureQuoteDecision({accountId,id:job.id,rate:settings.quoteParticipationRate ?? 60,random});
        if (!sampled.ok) return {skipped:true};
        ev.quoteDecision = sampled.decision;
        if (!sampled.decision.selected) {
          const form=({reply:'评论',quote:'引用评价',article:'文章',original:'旧版新帖'}[ev.publicationMode]||'引用评价');
          await save(accountId,job,{...ev,status:'skipped',reasonCode:'probability_skip',grokCalls:0,
            reason:`未抽中${form}（概率 ${sampled.decision.rate}%），未调用 Grok`});
          await onSkip({accountId,jobId:job.id,handle:job.handle,reasonCode:'probability_skip',grokCalls:0,
            reason:`未抽中${form}（概率 ${sampled.decision.rate}%），未调用 Grok`});
          return {ok:true,skipped:true,reasonCode:'probability_skip'};
        }
        if (ev.generationAttemptedAt && ev.reasonCode !== 'quota_not_sent' && !ev.relayJobId) {
          await save(accountId,job,{...ev,status:'uncertain',reason:'上次 Grok 请求结果待核实，未重复调用'});
          return {ok:true,uncertain:true};
        }
      }
      const cooldown = await readXGrokUsageCooldown(storage, now());
      if (cooldown && !ev.relayJobId && !await botAvailable()) return {quotaExhausted:true,retryAt:cooldown.retryAt};
      const claimed = await save(accountId, job, {...ev,status:'processing',commentAttemptedAt:now()});
      if (!claimed.ok) return {skipped:true};
      const controller = new AbortController();
      let timer;
      try {
        const timeout = new Promise((_,reject) => {timer = setTimeout(() => {
          controller.abort(); reject(new Error('评论任务超时，关注结果不受影响'));
        }, timeoutMs);});
        const result = await Promise.race([execute(binding,{jobId:job.id,taskId:ev.taskId,
          signal:controller.signal,automatic:true}), timeout]);
        if (result?.quotaExhausted) {
          const retained = result.evaluation || ev;
          await save(accountId, job, {...retained,status:retained.status === 'uncertain' ? 'uncertain' : 'pending',retryAt:result.retryAt || now()+900000,
            reason:retained.reason || result.reason || 'Grok 额度耗尽，评论稍后重试'});
        } else if (!result?.ok && !result?.evaluation) {
          await save(accountId, job, {...ev,status:'failed',reason:result?.error || '评论失败'});
        }
        return result;
      } catch (error) {
        const latest = (await store.listByState({accountId,state:'followed'})).find(row=>row.id === job.id);
        const current = latest?.evaluations?.find(item=>item.taskId === ev.taskId);
        if (current && !['posted','published'].includes(current.status)) {
          await save(accountId, job, {...current,
            status:current.status === 'publishing' || (!current.text && current.relayJobId && current.reasonCode==='bot_pending') ? 'uncertain' : current.text ? 'draft' : 'failed',reason:error.message});
        }
        return {ok:false,error:error.message};
      } finally { clearTimeout(timer); }
    } finally { running = false; }
  }
  return {run};
}
