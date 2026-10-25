import {readXGrokUsageCooldown} from '../grok/grok-usage-limit.js';

export const COMMENT_ALARM = 'x-independent-comments';

// No follow scheduler, follow API, follow retry counters or run budget in this worker.
// Intent and result use evaluations; resolveJob is deliberately never given a state.
export function createCommentWorker({store, storage, readBinding, execute,
  isBusy = () => false, now = Date.now, timeoutMs = 180000} = {}) {
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
      const cooldown = await readXGrokUsageCooldown(storage, now());
      if (cooldown) return {quotaExhausted:true,retryAt:cooldown.retryAt};
      const job = jobs.find(row => !isBusy(row) && row.evaluations?.some(ev =>
        ev.automaticComment && ev.status === 'pending' && !(ev.retryAt > now())));
      if (!job) return {idle:true};
      const ev = job.evaluations.find(ev => ev.automaticComment && ev.status === 'pending' && !(ev.retryAt > now()));
      const claimed = await save(accountId, job, {...ev,status:'processing'});
      if (!claimed.ok) return {skipped:true};
      const controller = new AbortController();
      let timer;
      try {
        const timeout = new Promise((_,reject) => {timer = setTimeout(() => {
          controller.abort(); reject(new Error('评论任务超时，关注结果不受影响'));
        }, timeoutMs);});
        const result = await Promise.race([execute(binding,{jobId:job.id,taskId:ev.taskId,
          signal:controller.signal}), timeout]);
        if (result?.quotaExhausted) {
          await save(accountId, job, {...ev,status:'pending',retryAt:result.retryAt || now()+900000,
            reason:result.reason || 'Grok 额度耗尽，评论稍后重试'});
        } else if (!result?.ok && !result?.evaluation) {
          await save(accountId, job, {...ev,status:'failed',reason:result?.error || '评论失败'});
        }
        return result;
      } catch (error) {
        const latest = (await store.listByState({accountId,state:'followed'})).find(row=>row.id === job.id);
        const current = latest?.evaluations?.find(item=>item.taskId === ev.taskId);
        if (current && !['posted','published'].includes(current.status)) {
          await save(accountId, job, {...current,
            status:current.status === 'publishing' ? 'uncertain' : 'failed',reason:error.message});
        }
        return {ok:false,error:error.message};
      } finally { clearTimeout(timer); }
    } finally { running = false; }
  }
  return {run};
}
