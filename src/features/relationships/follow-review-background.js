import {disabledFanRemoval} from './fan-removal-rules.js';
import {reviewIntervalMs} from './review-pacing.js';
import {hasFanReviewEvidence,needsFanEnrichment,evidenceReviewState,fanCollectedWithoutEvidence,EMPTY_FAN_REASON,normalizeFanVerdict} from './fan-review-flow.js';
import {fanDirectoryRow} from './fan-directory.js';
import {createStorageWriteQueue} from '../../platform/storage-write-queue.js';
import {
  createFanReviewBatch, createFanGrant, defaultReviewSettings, readReviewSettings,
  saveReviewSettings, hasAuthorizedFanGrant, readRemovalTombstones,
  findRemovalTombstone, runTaggingBatch, fanAiReviewItem, taggingInputFits, detectLocalHardRule, recordRemovalTombstone
} from './follow-review-engine.js';

export const FAN_INITIAL_REVIEW_PREFIX = 'followQueueFanInitialReview:';
export const FOLLOW_REVIEW_COMMANDS = Object.freeze([
  'followQueueReviewSettings', 'followQueueSaveReviewSettings',
  'followQueueFanReviewStart', 'followQueueFanReviewStatus',
  'followQueueFanReviewStop', 'followQueueFanReviewResume'
]);
const canonical = value => String(value || '').trim().replace(/^@+/, '').toLowerCase();
const stableId = value => typeof value === 'string' && /^\d+$/.test(value) ? value : '';
const targetId = value => stableId(value?.targetUserId) || stableId(value?.id) || stableId(value?.rest_id) || stableId(value?.restId);
const clone = value => structuredClone(value);
const reviewVersion = review => Number(review?.decisionVersion) || 0;
const fanSource = item => item?.module === 'fans' || item?.sources?.some(source => source.module === 'fans');
const now = () => Date.now();
const initialCheckpointWrites = new WeakMap();
function initialWriteQueue(storage) {
  if (!initialCheckpointWrites.has(storage)) initialCheckpointWrites.set(storage,createStorageWriteQueue());
  return initialCheckpointWrites.get(storage);
}

export function fanInitialReviewKey(accountId) {
  if (!accountId) throw Error('缺少审核归属账号');
  return FAN_INITIAL_REVIEW_PREFIX + accountId;
}

// Admission is separate from relationship observation. In particular, this
// adapter never navigates profiles or invents following/followedBy facts.
export function createFollowReviewBackground({storage, records, store, readBinding, readAccount,
  removeFollower, enqueueRemoval, onChanged, getService, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  migrate, verifyRelationship, automationManaged=false, automationStatus=async()=>({}), allowUnassigned = () => false} = {}) {
  if (!storage?.get || !storage?.set || !records || typeof readBinding !== 'function') throw Error('缺少粉丝审核后台依赖');
  const ready = new Map(), queues = new Map();
  const reviewBatch = createFanReviewBatch({storage, records, store, readBinding, readAccount, removeFollower, enqueueRemoval, onChanged, verifyRelationship, ...(getService ? {getService} : {}), wait});

  async function assertOwner(binding) {
    const current = await readBinding();
    if (!binding?.activated || !binding.accountId || !current?.activated || current.accountId !== binding.accountId) {
      throw Error('队列绑定账号已变化，审核已停止');
    }
    return current;
  }

  async function ensureReady(binding) {
    await assertOwner(binding);
    if (!ready.has(binding.accountId)) {
      const promise = (async () => {
        await records.ready?.();
        await assertOwner(binding);
        await migrate?.(binding);
        await assertOwner(binding);
      })();
      ready.set(binding.accountId, promise);
      promise.catch(() => {if (ready.get(binding.accountId) === promise) ready.delete(binding.accountId);});
    }
    await ready.get(binding.accountId);
    await assertOwner(binding);
  }

  async function rowsFor(binding, handle) {
    const groups = await Promise.all(['users', 'queue', 'followingUsers'].map(bucket => records.lookupAll({sourceKey:'monitor',bucket,handle})));
    const permitLegacy = await allowUnassigned(binding);
    return groups.flat().filter(row => {
      const payload = row.payload || {};
      const declared = [payload.accountId, payload.ownerAccountId, payload.fanReview?.ownerAccountId, payload.fanGrant?.ownerAccountId].filter(Boolean);
      if (declared.some(owner => owner !== binding.accountId && owner !== 'unassigned')) return false;
      return row.accountId === binding.accountId || row.accountId === 'unassigned' && (permitLegacy || declared.includes(binding.accountId));
    });
  }

  function newestReview(rows) {
    return rows.map(row => row.payload?.fanReview).filter(Boolean)
      .sort((a,b) => reviewVersion(b)-reviewVersion(a) || Number(b.updatedAt || 0)-Number(a.updatedAt || 0))[0] || {};
  }

  function unknownAction(job, rows) {
    const receipts = [job?.followResult, ...rows.map(row => row.payload)];
    return receipts.some(receipt => {
      if (!receipt) return false;
      const removal = receipt.followerRemoval || receipt.fanReview?.removalReceipt;
      return Boolean(receipt.attemptedAt && receipt.succeeded !== true && !receipt.confirmedAt
        || removal?.attemptedAt && removal.removed !== true && removal.attempted !== false);
    });
  }

  function recoverableQueueHold(job) {
    const result=job?.followResult || {};
    // Only machine screening holds may be superseded by a fresh fan review.
    // Explicit exclusions, removals and uncertain writes keep their own guard.
    return job?.state==='skipped' && !result.exclusion && !result.followerRemoval
      && (result.relationshipDecision?.screening==='blocked' && result.relationshipDecision.screeningReason
        && result.reason===result.relationshipDecision.screeningReason || /^关注\/粉丝比例低于 \d+%$/.test(result.reason || ''))
      || job?.state==='excluded' && result.relationshipDecision?.code==='not-a-follower'
        && /^对方(?:当前|已)未关注你，退出粉丝回关队列$/.test(result.reason || '');
  }

  async function snapshot(binding, candidate) {
    const handle = canonical(candidate.handle);
    const rows = await rowsFor(binding, handle);
    const ids = new Set(rows.map(row => targetId(row.payload)).filter(Boolean));
    const requestedId = targetId(candidate);
    const id = requestedId || (ids.size === 1 ? [...ids][0] : '');
    if (ids.size > 1 || requestedId && ids.size && !ids.has(requestedId)) return {handle,blocked:true,rows};
    const matching = rows.filter(row => targetId(row.payload) === id);
    const review = newestReview(matching);
    const job = await store?.lookup?.({accountId:binding.accountId,handle,targetUserId:id});
    const sameJob = !job?.targetUserId || job.targetUserId === id ? job : null;
    const tombstones = await readRemovalTombstones(storage, binding.accountId);
    const recoverableHold=recoverableQueueHold(sameJob);
    const executionBlocked=['excluded','skipped'].includes(sameJob?.state)||['excluded','skipped'].includes(candidate.state);
    const blocked = Boolean(findRemovalTombstone(tombstones,{handle,targetUserId:id})
      || unknownAction(sameJob,matching) || sameJob?.followResult?.succeeded===true || ['uncertain','followed','running'].includes(sameJob?.state)
      || sameJob?.state==='excluded'&&!recoverableHold
      || sameJob?.deleted || candidate.deleted
      || ['uncertain','followed'].includes(candidate.state) || candidate.state==='excluded'&&!recoverableHold);
    return {handle,targetUserId:id,rows:matching,relationship:fanDirectoryRow(matching)?.payload?.relationship||{},review,job:sameJob,blocked,executionBlocked,recoverableHold};
  }

  async function patchReview(binding, item, review, grant = null, expectedVersion = item.decisionVersion, extra = {}) {
    await assertOwner(binding);
    const current = await snapshot(binding,{handle:item.handle,targetUserId:item.targetUserId});
    if (current.blocked || current.targetUserId !== item.targetUserId || !current.rows.length
      || reviewVersion(current.review) !== expectedVersion) return false;
    const changes = current.rows.map(row => ({accountId:row.accountId,userKey:row.userKey,handle:item.handle,expectedOwnerAccountId:binding.accountId,
      sourceBucket:row.bucket || row.sourcePath?.[1],expectedTargetUserId:item.targetUserId,
      expectedFanReviewVersion:reviewVersion(row.payload?.fanReview),patch:{...extra,fanReview:clone(review),fanGrant:grant ? clone(grant) : null}}));
    await assertOwner(binding);
    let result;
    try { result = await records.batch({sourceKey:'monitor',changes}); }
    catch (error) {if (['RecordIdentityConflictError','RecordReviewConflictError'].includes(error?.name)) return false;throw error;}
    if (result?.updated === 0) return false;
    await onChanged?.({accountId:binding.accountId,handle:item.handle,stage:'fan-initial-review'});
    return true;
  }

  function approvedCandidate(candidate, review, grant) {
    const {fanGrant:_untrustedGrant,fanReview:_untrustedReview,...rest} = candidate;
    return {...rest,handle:canonical(candidate.handle),targetUserId:grant.targetUserId,followBackCandidate:true,fanReview:clone(review),fanGrant:clone(grant)};
  }

  async function readInitial(accountId) {
    const key = fanInitialReviewKey(accountId);
    const value = (await storage.get([key]))?.[key];
    return value?.version === 1 && value.batches ? clone(value) : {version:1,batches:{}};
  }
  async function saveInitial(accountId, batch) {
    const checkpoint=clone(batch);
    return initialWriteQueue(storage).enqueue(async()=>{
      const current=await readInitial(accountId);
      // Completed content already lives in source records/the AI job repository.
      // Keep only bounded receipt pointers here; unresolved work retains its
      // complete frozen input, connection and response for safe recovery.
      const receipt=value=>({id:String(value.id||''),accountId:String(value.accountId||accountId),phase:'completed',
        relayJobId:String(value.relayJobId||value.receipt?.id||''),completedAt:Number(value.completedAt||value.updatedAt||value.createdAt)||now(),
        total:Number(value.total??value.items?.length)||0,provider:String(value.provider||value.roleSnapshot?.provider||''),
        botId:String(value.botId||value.roleSnapshot?.botId||'')});
      const completed=new Map((Array.isArray(current.completedReceipts)?current.completedReceipts:[])
        .filter(value=>value?.id).map(value=>[value.id,receipt(value)]));
      for(const [id,value]of Object.entries(current.batches))if(value?.phase==='completed'){
        completed.set(id,receipt(value));delete current.batches[id];
      }
      if(checkpoint.phase==='completed'){
        completed.set(checkpoint.id,receipt(checkpoint));delete current.batches[checkpoint.id];
      }else if(!completed.has(checkpoint.id))current.batches[checkpoint.id]=checkpoint;
      current.completedReceipts=[...completed.values()].sort((a,b)=>b.completedAt-a.completedAt
        || (checkpoint.phase==='completed' ? a.id===checkpoint.id ? -1 : b.id===checkpoint.id ? 1 : 0 : 0)).slice(0,20);
      await storage.set({[fanInitialReviewKey(accountId)]:current});
    });
  }

  async function applyInitialResult(binding, batch, result) {
    const index = new Map((result.results || []).map(value => [canonical(value.handle),value]));
    let applied=true;
    for (const item of batch.items) {
      await assertOwner(binding);
      const current = await snapshot(binding,item);
      if (!current.rows?.length || !current.review?.state) {applied=false;continue;}
      // A newer persistent human decision already settled this item. An
      // unchanged initial record blocked by an unknown action still needs the
      // frozen response, so its batch must not be compacted yet.
      if (current.review.batchId !== batch.id || reviewVersion(current.review) !== item.decisionVersion || current.review.state !== 'initial') continue;
      if (current.blocked) {applied=false;continue;}
      const verdict = batch.fanDecisionPolicy===3?normalizeFanVerdict(index.get(item.handle),item,(await readReviewSettings(storage,binding.accountId)).removalRules):index.get(item.handle);
      const valid = result.ok === true && verdict?.valid === true && verdict.targetUserId === item.targetUserId
        && (batch.fanDecisionPolicy!==3 || ['pass','remove','uncertain'].includes(verdict.decision));
      if(valid&&verdict.decision==='remove'&&batch.fanDecisionPolicy===3&&current.relationship?.following===false&&current.relationship?.followedBy===true){
        await rejectKeywords(binding,item,current.review,verdict,'ai');continue;
      }
      const relationship=current.relationship;
      const pass = valid && verdict.decision === 'pass' && relationship?.following===false && relationship?.followedBy===true
        && (!current.executionBlocked || current.recoverableHold);
      const review = {...current.review,state:pass ? 'approved' : valid ? evidenceReviewState(current.review,verdict.decision) : 'failed',
        decision:valid ? verdict.decision === 'pass' ? 'pass' : verdict.decision === 'uncertain' ? 'uncertain' : 'review' : 'uncertain',
        ...(verdict?.originalAiVerdict?{originalAiVerdict:verdict.originalAiVerdict}:{}),tags:valid && Array.isArray(verdict.tags) ? verdict.tags : [],evidence:valid && Array.isArray(verdict.evidence) ? verdict.evidence : [],
        reason:verdict?.reason || result.error || '初审未返回有效结果',reasonCode:'',updatedAt:now(),source:pass ? 'initial-ai-pass' : 'initial-ai-review',
        retryAt:valid?0:now()+5*60*1000,
        decisionVersion:item.decisionVersion+1,ownerAccountId:binding.accountId,targetUserId:item.targetUserId,
        ...(batch.relayJobId ? {relayJobId:batch.relayJobId} : {})};
      const grant = pass ? createFanGrant({accountId:binding.accountId,targetUserId:item.targetUserId,handle:item.handle,source:'initial-ai-pass',decisionVersion:review.decisionVersion}) : null;
      if (grant) review.grant = grant;
      else review.grant = null;
      if (!await patchReview(binding,item,review,grant,item.decisionVersion)) applied=false;
    }
    return applied;
  }

  async function runInitial(binding, batch, {resume = false} = {}) {
    await assertOwner(binding);
    if (batch.phase === 'applying' && batch.result) {
      const applied=await applyInitialResult(binding,batch,batch.result);
      batch.phase = batch.result.ok ? applied ? 'completed' : 'applying' : 'failed';
      await saveInitial(binding.accountId,batch);
      return;
    }
    // A reserved/prepared batch has not crossed the submit boundary. After that
    // boundary an absent receipt is ambiguous and must never be regenerated.
    if (resume && !batch.relayJobId && !['reserved','prepared'].includes(batch.phase)) return;
    if (resume && ['reserved','prepared'].includes(batch.phase)) {
      const retained=[];
      for (const item of batch.items) {
        const current=await snapshot(binding,item);
        if (!current.blocked && current.review.batchId===batch.id && current.review.state==='initial'
          && reviewVersion(current.review)===item.decisionVersion) retained.push(item);
      }
      batch.items=retained;
      if (!retained.length) {batch.phase='completed';await saveInitial(binding.accountId,batch);return;}
    }
    batch.phase = 'submitting';
    await saveInitial(binding.accountId,batch);
    const result = await runTaggingBatch({role:'fanTagging',roleConfig:clone(batch.roleSnapshot),items:clone(batch.items),
      relayJobId:batch.relayJobId || '',connection:batch.connection,requestContext:{accountId:binding.accountId,batchId:batch.id},
      ...(getService ? {getService} : {}),beforeSubmit:()=>assertOwner(binding),onRelayJobCreated:async receipt => {
        batch.relayJobId = receipt?.id || receipt?.jobId || '';
        batch.receipt = clone(receipt || {});
        if (receipt?.connection) batch.connection = clone(receipt.connection);
        batch.phase = 'pending';
        await saveInitial(binding.accountId,batch);
      }});
    batch.relayJobId = result.relayJobId || batch.relayJobId || '';
    batch.phase = result.pending ? 'pending' : 'applying';
    if (!result.pending) batch.result = clone(result);
    batch.error = result.error || '';
    batch.updatedAt = now();
    await saveInitial(binding.accountId,batch);
    await assertOwner(binding);
    if (!result.pending) {
      const applied=await applyInitialResult(binding,batch,result);
      batch.phase=result.ok ? applied ? 'completed' : 'applying' : 'failed';
      await saveInitial(binding.accountId,batch);
    }
  }

  async function rejectKeywords(binding,item,review,rule,kind='keyword') {
    if(review.retryAt>now())return;
    const current=await snapshot(binding,item);
    const actionHeld=current.executionBlocked&&!current.recoverableHold;
    const pending={...review,state:'review',decision:'remove',source:kind==='ai'?'ai-rejection':'keyword-rejection',reasonCode:actionHeld?'execution_hold':kind==='ai'?'ai_rejected':'keyword_rejected',
      reason:rule.reason,tags:rule.tags,evidence:rule.evidence,...(rule.originalAiVerdict?{originalAiVerdict:rule.originalAiVerdict}:{}),decisionVersion:item.decisionVersion+1,
      ownerAccountId:binding.accountId,targetUserId:item.targetUserId,updatedAt:now(),grant:null};
    if(!await patchReview(binding,item,pending))return;
    if(enqueueRemoval){await enqueueRemoval({accountId:binding.accountId,handle:item.handle,targetUserId:item.targetUserId,reason:rule.reason});return;}
    if(actionHeld||typeof removeFollower!=='function')return;
    // The existing remover persists its intent before X writes and never resends unknown outcomes.
    const receipt=await removeFollower({accountId:binding.accountId,handle:item.handle,targetUserId:item.targetUserId,reason:rule.reason});
    await assertOwner(binding);
    const verifiedAt=typeof receipt?.verifiedAt==='number'?receipt.verifiedAt:Date.parse(receipt?.verifiedAt||'');
    const removed=receipt?.removed===true&&receipt.accountId===binding.accountId&&receipt.targetUserId===item.targetUserId&&verifiedAt>0;
    const next={...pending,state:removed?'removed':'review',decision:'remove',
      retryAt:removed?0:Math.max(receipt?.retryAt||0,now()+60000),reason:receipt?.reason||rule.reason,removalReceipt:{...receipt,removed},decisionVersion:pending.decisionVersion+1,updatedAt:now()};
    const extra={followerRemoval:next.removalReceipt,...(removed?{relationship:{following:false,followedBy:false},relationshipKnown:true,
      followingObservedAt:verifiedAt,followedByObservedAt:verifiedAt,status:'removed',state:'removed_follower'}:{})};
    if(await patchReview(binding,item,next,null,pending.decisionVersion,extra)&&removed)
      await recordRemovalTombstone(storage,binding.accountId,{...item,state:'removed',reason:rule.reason,tags:rule.tags,source:pending.source});
  }

  async function prepareEnrichment(binding,item,review,payload) {
    if(review.enrichmentCompletedAt)return {item,review,payload};
    if(review.retryAt>now())return null;
    if(!review.enrichmentStartedAt){
      const next={...review,state:'verify',decision:'uncertain',reasonCode:'insufficient_evidence',
        ownerAccountId:binding.accountId,targetUserId:item.targetUserId,decisionVersion:item.decisionVersion+1,updatedAt:now(),grant:null};
      if(!await patchReview(binding,item,next))return null;
      item={...item,decisionVersion:next.decisionVersion};review=next;
      try{
        if(!verifyRelationship)throw Error('资料核实执行器不可用');
        await verifyRelationship({accountId:binding.accountId,handle:item.handle,targetUserId:item.targetUserId});
        const current=await snapshot(binding,item);
        if(current.blocked||reviewVersion(current.review)!==item.decisionVersion)return null;
        payload=current.rows[0]?.payload||{};
        if(current.relationship?.following!==false||current.relationship?.followedBy!==true)return null;
        const started={...review,enrichmentStartedAt:now(),retryAt:0,decisionVersion:item.decisionVersion+1};
        if(!await patchReview(binding,item,started))return null;
        review=started;item={...item,decisionVersion:started.decisionVersion};
      }catch(error){
        await patchReview(binding,item,{...review,reason:`资料核实未完成：${error.message}`,retryAt:Math.max(now()+60000,Number(error.retryAt)||now()+5*60*1000),decisionVersion:item.decisionVersion+1});return null;
      }
    }
    const prepared=await fanAiReviewItem({records,storage,accountId:binding.accountId,item,payload});
    if(prepared.information?.collectionExhausted&&!hasFanReviewEvidence(prepared)){
      await patchReview(binding,item,{...review,state:'review',source:'enrichment-failed',reasonCode:'collection_failed',
        enrichmentCompletedAt:now(),reason:'资料补采重试未完成，请人工重试',decisionVersion:item.decisionVersion+1,updatedAt:now()});return null;
    }
    if(fanCollectedWithoutEvidence(prepared)&&(await readReviewSettings(storage,binding.accountId)).removalRules.blockEmpty){await rejectKeywords(binding,item,review,{reason:EMPTY_FAN_REASON,tags:[],evidence:[]},'ai');return null;}
    if(!hasFanReviewEvidence(prepared)&&!fanCollectedWithoutEvidence(prepared))return null;
    const next={...review,state:'review',reasonCode:'',enrichmentCompletedAt:now(),source:'enrichment-ready',decisionVersion:item.decisionVersion+1,updatedAt:now()};
    if(!await patchReview(binding,item,next))return null;
    return {item:{...item,decisionVersion:next.decisionVersion},review:next,payload};
  }

  async function gate(binding, candidates) {
    await ensureReady(binding);
    const settings = await readReviewSettings(storage,binding.accountId);
    const unique = new Map();
    for (const candidate of candidates || []) if (candidate?.handle) {
      const handle = canonical(candidate.handle), prior = unique.get(handle);
      if (prior && targetId(prior) && targetId(candidate) && targetId(prior) !== targetId(candidate)) unique.set(handle,{...candidate,identityConflict:true});
      else if (!prior?.identityConflict) unique.set(handle,candidate);
    }
    const savedInitial=await readInitial(binding.accountId);
    const fresh = [],resumeIds = new Set(Object.values(savedInitial.batches).filter(batch=>['reserved','prepared'].includes(batch.phase)).map(batch=>batch.id));
    for (const candidate of unique.values()) {
      await assertOwner(binding);
      if (candidate.identityConflict) continue;
      const current = await snapshot(binding,candidate);
      if (current.blocked) continue;
      let {review}=current;
      const {rows,targetUserId:id,handle} = current;
      if(review.state==='verify'&&review.enrichmentCompletedAt)continue;
      const enrichment=needsFanEnrichment(review)&&!review.enrichmentCompletedAt;
      const recoveredPass=review.state==='review'&&review.decision==='pass'&&review.source==='manual-ai-analyze';
      const retryFailure=review.state==='failed'&&review.source==='initial-ai-review'&&review.retryAt<=now();
      if (['review','removed','failed'].includes(review.state)&&!enrichment&&!recoveredPass&&!retryFailure&&review.source!=='enrichment-ready'&&!['keyword_rejected','ai_rejected'].includes(review.reasonCode)) continue;
      if (review.state === 'initial') {
        if (review.batchId) resumeIds.add(review.batchId);
        continue;
      }
      // Ordinary sources cannot manufacture a fan grant. A real source row may
      // carry one after the same stable identity was explicitly released.
      const grant = review.grant || rows.find(row => row.payload?.fanGrant)?.payload.fanGrant;
      if (review.state === 'approved' && hasAuthorizedFanGrant(grant,binding.accountId,id,handle,{requireTargetUserId:true})) {
        continue;
      }
      if (!fanSource(candidate)) {
        const {fanGrant:_grant,fanReview:_review,...plain} = candidate;
        continue;
      }
      if (!id || !rows.length) continue;
      let payload = rows[0].payload || {};
      if(current.relationship?.following===true||current.relationship?.followedBy===false)continue;
      let item = {handle,targetUserId:id,ownerAccountId:binding.accountId,accountId:binding.accountId,
        name:String(payload.name || candidate.profile?.name || handle),bio:String(payload.bio || payload.description || ''),decisionVersion:reviewVersion(review)};
      if(automationManaged&&(settings.initialReviewEnabled||review.reasonCode==='ai_rejected'))continue;
      if(review.reasonCode==='ai_rejected'&&!disabledFanRemoval(review,settings.removalRules)){await rejectKeywords(binding,item,review,review,'ai');continue;}
      if(!settings.initialReviewEnabled&&current.executionBlocked&&!current.recoverableHold)continue;
      if ((!settings.initialReviewEnabled||recoveredPass)&&(!current.executionBlocked||current.recoverableHold)) {
        const nextVersion = item.decisionVersion+1;
        const source=recoveredPass?'initial-ai-pass':'initial-review-disabled';
        const grant = createFanGrant({accountId:binding.accountId,targetUserId:id,handle,source,decisionVersion:nextVersion});
        const next = {...review,state:'approved',decision:'pass',source,ownerAccountId:binding.accountId,targetUserId:id,
          decisionVersion:nextVersion,updatedAt:now(),reason:recoveredPass?review.reason:'初审关闭，直接放行',grant};
        await patchReview(binding,item,next,grant);
      } else {
        if(automationManaged)continue;
        if(enrichment){const resumed=await prepareEnrichment(binding,item,review,payload);if(!resumed)continue;({item,review,payload}=resumed);}
        const prepared=await fanAiReviewItem({records,storage,accountId:binding.accountId,item,payload});
        const rule=detectLocalHardRule(prepared,prepared.posts,{fanContent:true,removalRules:settings.removalRules});
        if(rule.blocked){await rejectKeywords(binding,item,review,rule);continue;}
        if(fanCollectedWithoutEvidence(prepared)&&!settings.removalRules.blockEmpty){const grant=createFanGrant({accountId:binding.accountId,targetUserId:id,handle,source:'empty-profile-allowed',decisionVersion:item.decisionVersion+1});await patchReview(binding,item,{...review,state:'approved',decision:'pass',source:'empty-profile-allowed',reasonCode:'',reason:'空号拦截已关闭，核实无简介和帖子后放行',grant,decisionVersion:item.decisionVersion+1,updatedAt:now()},grant);continue;}
        if(!hasFanReviewEvidence(prepared)||!taggingInputFits('fanTagging',[prepared],settings.fanTagging.prompt)){
          const missing=!hasFanReviewEvidence(prepared);
          const next={...review,state:missing?evidenceReviewState(review,'uncertain'):'review',decision:'uncertain',source:'initial-ai-unavailable',ownerAccountId:binding.accountId,targetUserId:id,
            decisionVersion:item.decisionVersion+1,updatedAt:now(),reason:missing?'缺少画像简介，无法审核':'单个账号资料超过 AI 输入预算，原始资料已保留，请人工审核',
            reasonCode:missing?'missing_biography':'input_too_large',tags:[],evidence:[],grant:null};
          await patchReview(binding,item,next,null,item.decisionVersion);
        }else fresh.push({...prepared,enrichmentStartedAt:review.enrichmentStartedAt||0,enrichmentCompletedAt:review.enrichmentCompletedAt||0});
      }
    }
    const state = await readInitial(binding.accountId);
    for (const id of resumeIds) {
      if(automationManaged&&(!(await readReviewSettings(storage,binding.accountId)).automation.review.enabled||(await reviewBatch.status(binding.accountId))?.stage==='running'))break;
      const batch = state.batches[id];
      if (batch?.accountId === binding.accountId && ['reserved','prepared','pending','submitting','applying'].includes(batch.phase)) await runInitial(binding,batch,{resume:true});
    }
    const limit = settings.fanTagging.batchSize;
    for (let offset=0;offset<fresh.length;) {
      let size=1;
      while(size<Math.min(limit,fresh.length-offset)&&taggingInputFits('fanTagging',fresh.slice(offset,offset+size+1),settings.fanTagging.prompt))size++;
      await assertOwner(binding);
      const id = `fan-initial-${now()}-${Math.random().toString(36).slice(2,9)}`;
      const planned = fresh.slice(offset,offset+size).map(original => ({...original,decisionVersion:original.decisionVersion+1,batchId:id}));
      const batch = {id,accountId:binding.accountId,fanDecisionPolicy:3,phase:'reserved',roleSnapshot:clone({...settings.fanTagging,removalRules:settings.removalRules}),items:clone(planned),createdAt:now(),relayJobId:''};
      await saveInitial(binding.accountId,batch);
      batch.items=[];
      for (const item of planned) {
        const original = {...item,decisionVersion:item.decisionVersion-1};
        const review = {state:'initial',decision:'uncertain',enrichmentStartedAt:item.enrichmentStartedAt||0,enrichmentCompletedAt:item.enrichmentCompletedAt||0,ownerAccountId:binding.accountId,targetUserId:item.targetUserId,source:'initial-ai',
          decisionVersion:item.decisionVersion,batchId:id,updatedAt:now(),reason:'等待粉丝初审结果',tags:[],evidence:[],grant:null};
        if (await patchReview(binding,original,review,null,original.decisionVersion)) batch.items.push(item);
      }
      batch.phase='prepared';
      await saveInitial(binding.accountId,batch);
      if (batch.items.length) await runInitial(binding,batch);
      offset+=size;
      if (offset<fresh.length) {const delay=reviewIntervalMs(settings.fanTagging);if(delay)await wait(delay);}
    }
    // Read the source again after AI. Human decisions, account changes and
    // identity changes during the request take precedence over its response.
    const final=[];
    for (const candidate of unique.values()) {
      if (candidate.identityConflict) continue;
      const current = await snapshot(binding,candidate);
      if (current.blocked || ['review','verify','removed','failed','initial'].includes(current.review.state)) continue;
      if(current.relationship?.following===true||current.relationship?.followedBy===false)continue;
      const grant = current.review.grant || current.rows.find(row => row.payload?.fanGrant)?.payload.fanGrant;
      if(current.executionBlocked){
        if(!current.recoverableHold || current.review.state!=='approved' || !['initial-ai-pass','initial-review-disabled','manual-ai-analyze'].includes(current.review.source)
          || current.relationship?.following!==false || current.relationship?.followedBy!==true
          || !hasAuthorizedFanGrant(grant,binding.accountId,current.targetUserId,current.handle,{requireTargetUserId:true}))continue;
        // Compare the exact held job inside the store transaction: a manual change
        // while AI was running must never be overwritten by this recovery.
        const reopened=await store?.resolveJob?.({accountId:binding.accountId,id:current.job.id,state:'pending',stage:'queued',nextEligibleAt:now(),
          expectedState:current.job.state,expectedTargetUserId:current.targetUserId,expectedFollowResult:current.job.followResult||null,
          fanGrant:grant,followResult:{targetUserId:current.targetUserId,following:false,verifiedAt:now(),reason:'粉丝补采复审通过，恢复待回关',previousHold:current.job.followResult||null}});
        if(!reopened?.ok)continue;
      }
      if (!current.blocked && current.review.state === 'approved'
        && stableId(grant?.targetUserId)===current.targetUserId && current.targetUserId
        && hasAuthorizedFanGrant(grant,binding.accountId,current.targetUserId,current.handle,{requireTargetUserId:true})) final.push(approvedCandidate({...candidate,...(current.executionBlocked?{state:'pending'}:{})},current.review,grant));
      else if (!fanSource(candidate)) {
        const {fanGrant:_grant,fanReview:_review,...plain}=candidate;
        final.push(plain);
      }
    }
    await assertOwner(binding);
    return final;
  }

  async function gateCandidates(binding,candidates) {
    if (!queues.has(binding?.accountId)) queues.set(binding?.accountId,createStorageWriteQueue());
    return queues.get(binding?.accountId).enqueue(() => gate(binding,candidates));
  }

  // Finish a verification from existing evidence only. This path must never
  // open a profile, submit AI, or wait for the network retry cooldown.
  async function completeCachedVerification(accountId,candidate,{deferRemoval=false}={}) {
    const binding=await readBinding();await assertOwner({activated:true,accountId});
    const current=await snapshot(binding,candidate);
    if(current.blocked||!current.rows.length)return {state:'verify',reason:'审核记录已变化，待核对'};
    const {review,relationship}=current;
    if(relationship.following!==false||relationship.followedBy!==true)return {state:review.state||'',ready:false};
    if(review.state!=='verify')return {state:review.state||'',ready:review.state==='review'};
    const item={...candidate,handle:current.handle,targetUserId:current.targetUserId,decisionVersion:reviewVersion(review)};
    const prepared=await fanAiReviewItem({records,storage,accountId,item,payload:current.rows[0].payload});
    const collectedEmpty=fanCollectedWithoutEvidence(prepared);
    const empty=collectedEmpty&&(await readReviewSettings(storage,accountId)).removalRules.blockEmpty;
    if(empty&&deferRemoval)return {state:'verify',ready:false,removalPending:true};
    if(!collectedEmpty&&!hasFanReviewEvidence(prepared))return {state:'verify',ready:false,reason:prepared.information?.reason||'帖子待补采'};
    const next={...review,state:'review',decision:empty?'remove':'review',source:empty?'empty-profile-rejection':'enrichment-ready',reasonCode:empty?'ai_rejected':'',reason:empty?EMPTY_FAN_REASON:'资料已就绪，等待 AI 复审',retryAt:0,
      enrichmentStartedAt:review.enrichmentStartedAt||now(),enrichmentCompletedAt:now(),decisionVersion:item.decisionVersion+1,updatedAt:now()};
    if(!await patchReview(binding,item,next))return {state:'verify',ready:false,reason:'审核记录已更新，等待刷新'};
    return {state:'review',ready:true,...(empty?{removalPending:true}:{}),reason:empty?EMPTY_FAN_REASON:'资料已就绪'};
  }

  async function automaticCandidates(accountId,kind) {
    const binding=await readBinding();await assertOwner({activated:true,accountId});await ensureReady(binding);
    const owners=[accountId,...(await allowUnassigned(binding)?['unassigned']:[])],handles=new Set();
    for(const owner of owners)for(const handle of await records.fanInspectionTargets({accountId:owner,filter:{tab:kind==='review'?'fanReview':'fanUnknown'}}))handles.add(handle);
    const items=[];
    // An unresolved receipt owns its frozen identities, never the whole backlog.
    const pendingIds=new Set(kind==='review'?Object.values((await readInitial(accountId)).batches)
      .filter(batch=>['reserved','prepared','pending','submitting','applying'].includes(batch.phase))
      .flatMap(batch=>(batch.items||[]).map(item=>item.targetUserId)):[]);
    for(const handle of handles){const ctx=await snapshot(binding,{handle});
      // A rejected fan belongs to the serialized removal consumer, including
      // legacy unresolved removal receipts. An ambiguous follow still owns its target.
      const follow=ctx.job?.followResult;
      const pendingRemoval=kind==='review'&&ctx.review?.state!=='removed'&&(ctx.review?.decision==='remove'||['ai_rejected','keyword_rejected'].includes(ctx.review?.reasonCode));
      const unknownFollow=follow?.attemptedAt&&follow.succeeded!==true&&follow.attempted!==false;
      if(pendingRemoval&&!unknownFollow&&!['running','followed'].includes(ctx.job?.state)&&ctx.targetUserId&&ctx.rows.length){
        items.push({handle,targetUserId:ctx.targetUserId,removalPending:true,retryAt:ctx.review.retryAt||0,updatedAt:ctx.review.updatedAt||0});continue;
      }
      if(kind==='verify'&&!ctx.blocked&&!ctx.targetUserId&&ctx.rows.length){
        items.push({handle,targetUserId:'',needsIdentity:true,retryAt:ctx.review.retryAt||0,updatedAt:ctx.review.updatedAt||0});continue;
      }
      if(ctx.blocked||!ctx.targetUserId||!ctx.rows.length)continue;
      if(ctx.relationship.following===true||ctx.relationship.followedBy===false)continue;
      if(kind==='verify'&&ctx.review.state==='verify'){
        if((await completeCachedVerification(accountId,{handle,targetUserId:ctx.targetUserId},{deferRemoval:true})).ready)continue;
      }
      if(ctx.review.state==='initial'||pendingIds.has(ctx.targetUserId))continue; // Existing receipt recovery owns only this identity.
      if(kind==='review'&&ctx.review.source==='enrichment-failed')continue;
      items.push({handle,targetUserId:ctx.targetUserId,retryAt:ctx.review.retryAt||0,updatedAt:ctx.review.updatedAt||0});
    }
    return items.sort((a,b)=>a.updatedAt-b.updatedAt||a.handle.localeCompare(b.handle));
  }
  async function automaticVerify(accountId,candidate) {
    const binding=await readBinding();await assertOwner({activated:true,accountId});
    const current=await snapshot(binding,candidate);if(current.blocked||!current.rows.length)return {skipped:true};
    if(!current.targetUserId){
      if(!verifyRelationship)throw Error('资料核实执行器不可用');
      await verifyRelationship({accountId,handle:candidate.handle,targetUserId:''});
      const refreshed=await snapshot(binding,{handle:candidate.handle});
      if(!refreshed.rows.length)return {skipped:true,reason:'账号资料已清理'};
      return {ready:!!refreshed.targetUserId&&refreshed.review?.state==='review',waiting:true,
        reason:refreshed.targetUserId?'用户 ID 已补齐，继续审核资料':'资料暂未返回用户 ID，等待重试'};
    }
    let review=current.review,item={...candidate,accountId,ownerAccountId:accountId,decisionVersion:reviewVersion(review)};
    if(review.enrichmentCompletedAt){
      const next={...review,state:'verify',enrichmentStartedAt:0,enrichmentCompletedAt:0,decisionVersion:item.decisionVersion+1};
      if(!await patchReview(binding,item,next))return {skipped:true};review=next;item={...item,decisionVersion:next.decisionVersion};
    }
    const result=await prepareEnrichment(binding,item,review,current.rows[0].payload);
    if(result)return {ready:true};
    const latest=await snapshot(binding,candidate);
    if(latest.review.state==='removed')return {removed:true,reason:latest.review.reason||''};
    if(latest.review.state!=='verify')return {skipped:true,reason:latest.review.reason||''};
    return {reason:latest.review.reason||'',waiting:!!latest.review.enrichmentStartedAt&&!latest.review.enrichmentCompletedAt,retryAt:latest.review.retryAt||0};
  }
  async function handle(message = {}) {
    if (!FOLLOW_REVIEW_COMMANDS.includes(message.cmd)) throw Error('未知审核操作');
    const binding = await readBinding();
    if (!binding?.activated || !binding.accountId) {
      if (message.cmd === 'followQueueReviewSettings') return {ok:true,settings:defaultReviewSettings(),requiresActivation:true};
      if (message.cmd === 'followQueueFanReviewStatus') return {ok:true,batch:null,requiresActivation:true};
      throw Error('请先确认队列账号');
    }
    if (message.accountId && message.accountId !== binding.accountId) throw Error('审核归属账号不匹配');
    if (message.cmd === 'followQueueReviewSettings') return {ok:true,settings:await readReviewSettings(storage,binding.accountId),automationStatus:await automationStatus(binding.accountId)};
    if (message.cmd === 'followQueueSaveReviewSettings') {
      await assertOwner(binding);
      return {ok:true,settings:await saveReviewSettings(storage,binding.accountId,message.settings || {})};
    }
    await ensureReady(binding);
    const actions = {followQueueFanReviewStart:() => reviewBatch.start(binding.accountId,message),
      followQueueFanReviewStatus:() => reviewBatch.status(binding.accountId),followQueueFanReviewStop:() => reviewBatch.stop(binding.accountId),
      followQueueFanReviewResume:() => reviewBatch.resume(binding.accountId)};
    return {ok:true,batch:await actions[message.cmd]()};
  }
  return {handle,gateCandidates,ensureReady,reviewBatch,automaticCandidates,automaticVerify,completeCachedVerification};
}
