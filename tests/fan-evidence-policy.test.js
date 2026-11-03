import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeFanVerdict,fanConfirmedEmpty,fanCollectedWithoutEvidence} from '../src/features/relationships/fan-review-flow.js';
import {detectLocalHardRule,buildTaggingPrompt} from '../src/features/relationships/follow-review-engine.js';
const verdict={valid:true,decision:'uncertain',tags:[],evidence:[],reason:'证据不足'};
test('suggestive removal is opt-in for keywords and AI, without bypassing other rejection categories',()=>{
 const item={bio:'付费裸聊服务欢迎联系'};
 assert.equal(detectLocalHardRule(item,[],{fanContent:true}).blocked,false);
 const result={...verdict,decision:'remove',tags:['色情低俗'],evidence:['bio: '+item.bio]};
 assert.equal(normalizeFanVerdict(result,item).decision,'pass');
 assert.equal(normalizeFanVerdict(result,item,{blockSuggestive:true}).decision,'remove');
 assert.equal(normalizeFanVerdict({...result,tags:['色情低俗','军事宣传']},item).decision,'remove');
 assert.match(buildTaggingPrompt({role:'fanReview',items:[item]}),/已关闭擦边拦截/);
});
test('only absence of both biography and posts can retain insufficient evidence',()=>{
 for(const item of [{bio:'ordinary life'},{bio:'',posts:[{text:'one short post',textComplete:false}]}]){
  const result=normalizeFanVerdict(verdict,item);assert.equal(result.decision,'pass');assert.equal(result.originalAiVerdict,verdict);
 }
 assert.equal(normalizeFanVerdict(verdict,{bio:' ',posts:[]}),verdict);
 assert.equal(normalizeFanVerdict({...verdict,valid:false},{bio:'normal'}).valid,false);
});
test('sexual content verdict with actual source evidence cannot become insufficient evidence',()=>{
 const item={bio:'',posts:[{text:'付费裸聊服务欢迎联系'}]};
 const result=normalizeFanVerdict({...verdict,tags:['低俗擦边'],evidence:['post: 付费裸聊服务欢迎联系']},item,{blockSuggestive:true});
 assert.equal(result.decision,'remove');assert.equal(result.originalAiVerdict.decision,'uncertain');
 const fabricated=normalizeFanVerdict({...verdict,tags:['色情低俗'],evidence:['fabricated evidence']},item,{blockSuggestive:true});
 assert.equal(fabricated.valid,false);assert.notEqual(fabricated.decision,'pass');
});
test('empty evidence requires a confirmed empty biography and successfully empty timeline',()=>{
 const item={bio:'',posts:[],information:{posts:'empty',postsObservedAt:100,fieldObservedAt:{bio:100}}};
 assert.equal(fanConfirmedEmpty(item),true);
 for(const posts of ['failed','pending','stale','unavailable','rate-limited','partial'])assert.equal(fanConfirmedEmpty({...item,information:{...item.information,posts}}),false);
 assert.equal(fanConfirmedEmpty({...item,information:{...item.information,fieldObservedAt:{}}}),false);
 assert.equal(fanConfirmedEmpty({...item,bio:'description'}),false);
 assert.equal(fanConfirmedEmpty({...item,information:{...item.information,observedPostCount:1}}),false,'an image-only post is not an empty account');
 assert.equal(fanCollectedWithoutEvidence({...item,posts:[{postId:'123',text:''}]}),false);
});
test('content-only keyword filtering leaves sexual orientation, medical discussion and counter-speech alone',()=>{
 for(const bio of ['男同 普通生活','女同 gay lesbian LGBT','医学科普 生殖器健康','插入代码的教程','拒绝成人视频'])assert.equal(detectLocalHardRule({bio},[],{fanContent:true,removalRules:{blockSuggestive:true}}).blocked,false);
 for(const bio of ['付费裸聊服务','福利视频 成人视频','同城约炮'])assert.equal(detectLocalHardRule({bio},[],{fanContent:true,removalRules:{blockSuggestive:true}}).blocked,true);
 assert.equal(detectLocalHardRule({bio:'付费裸聊服务'},[]).blocked,false);
 const prompt=buildTaggingPrompt({role:'fanReview',items:[],removalRules:{blockSuggestive:true}});assert.match(prompt,/唯一的资料不足条件/);assert.match(prompt,/性取向/);
});

test('finished successful zero-post collection is unusable even when pagination is partial',()=>{
 const item={bio:'',posts:[],information:{posts:'partial',postsObservedAt:100,fieldObservedAt:{bio:100}}};
 assert.equal(fanCollectedWithoutEvidence(item),true);
 for(const posts of ['pending','failed','rate-limited','stale','unavailable','not-collected'])assert.equal(fanCollectedWithoutEvidence({...item,information:{...item.information,posts}}),false);
 assert.equal(fanCollectedWithoutEvidence({...item,posts:[{text:'One useful post'}]}),false);
 assert.equal(fanCollectedWithoutEvidence({...item,bio:'A public biography'}),false);
 assert.equal(fanCollectedWithoutEvidence({...item,information:{...item.information,fieldObservedAt:{}}}),false);
});
