import test from 'node:test';
import assert from 'node:assert/strict';
import {createArticlePublisher,validateArticleInput} from '../src/features/publishing/article-publisher.js';
import {articleComposerOnPage,readArticlePublicationOnPage} from '../src/features/publishing/article-page.js';

const SAMPLE_COVER={
  dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUAAAACCAYAAACQahZdAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  mimeType:'image/png',
  width:2500,
  height:1000
};

const SAMPLE_ARTICLE={
  title:'缓存尾延迟与冷启动边界实测分析',
  body:'第一段交代原帖比较的背景与问题。\n\n第二段拆解热命中与冷启动机制差异，给出适用边界。',
  description:'拆解缓存冷启动与热命中尾延迟分布的关键机制与适用条件。',
  cover:SAMPLE_COVER
};

function fixture({
  draftUrl='https://x.com/compose/articles/edit/draft_778899',
  draftId='draft_778899',
  createDraft={ok:true,attempted:false,scopeToken:'art-scope-1',draftId:'draft_778899',draftUrl:'https://x.com/compose/articles/edit/draft_778899',empty:true},
  uploadCover={ok:true,attempted:false,appliedCrop:true,cover:{complete:true,width:1200,height:480,ratio:2.5,isFiveByTwo:true},draftId:'draft_778899',draftUrl:'https://x.com/compose/articles/edit/draft_778899',scopeToken:'art-scope-1'},
  fill={ok:true,attempted:false,filled:true,saved:true,ready:true,draftId:'draft_778899',draftUrl:'https://x.com/compose/articles/edit/draft_778899',scopeToken:'art-scope-1'},
  verifySaved={ok:true,attempted:false,saved:true,ready:true,cover:{complete:true,width:1200,height:480,ratio:2.5,isFiveByTwo:true},draftId:'draft_778899',draftUrl:'https://x.com/compose/articles/edit/draft_778899',scopeToken:'art-scope-1'},
  submit={ok:true,attempted:true,draftId:'draft_778899',draftUrl:'https://x.com/compose/articles/edit/draft_778899'},
  submitError=false,
  proof={id:'8899001122',url:'https://x.com/owner/status/8899001122',coverVerified:true,titleVerified:true}
}={}) {
  const calls=[],removed=[];let nextTabId=100;
  const api={
    tabs:{
      create:async options=>{calls.push(['create',options]);return {id:++nextTabId};},
      get:async()=>({status:'complete'}),
      update:async(_id,options)=>{calls.push(['update',options]);},
      remove:async id=>removed.push(id)
    },
    scripting:{
      executeScript:async({func,args})=>{
        if(func.name==='setQuoteFrameFallbackOnPage')return [{result:undefined}];
        if(func.name==='readArticlePublicationOnPage'){
          calls.push(['proof',args[0],args[1]?.title]);
          return [{result:typeof proof==='function'?proof(calls):proof}];
        }
        const [owner,payload,action,token]=args;
        calls.push([action,owner,payload,token]);
        if(action==='submit'&&submitError)throw Error('lost scripting response during final publish');
        if(['upload_cover','fill','verify_saved','submit'].includes(action)){
          assert.equal(token,'art-scope-1','must pin to task-created draft scopeToken');
          assert.equal(payload.expectedDraftId,draftId,'must verify task-created draftId');
        }
        if(action==='create_draft')return [{result:createDraft}];
        if(action==='upload_cover')return [{result:uploadCover}];
        if(action==='fill')return [{result:fill}];
        if(action==='verify_saved')return [{result:verifySaved}];
        if(action==='submit')return [{result:submit}];
        return [{result:{ok:true,attempted:false}}];
      }
    }
  };
  return {
    calls,
    removed,
    draftUrl,
    publisher:createArticlePublisher({
      api,
      sleep:async()=>{},
      now:()=>50000,
      openComposer:async()=>{
        const tab=await api.tabs.create({url:'https://x.com/compose/articles',active:false});
        return {tabId:tab.id,close:()=>api.tabs.remove(tab.id)};
      }
    })
  };
}

test('validateArticleInput enforces nonempty title, body, short description, and exact 5:2 cover with bytes',()=>{
  assert.equal(validateArticleInput(SAMPLE_ARTICLE).ok,true);
  assert.equal(validateArticleInput({...SAMPLE_ARTICLE,description:'a'.repeat(256)}).ok,true);
  assert.match(validateArticleInput({...SAMPLE_ARTICLE,description:'a'.repeat(257)}).reason,/256/);
  assert.match(validateArticleInput({...SAMPLE_ARTICLE,title:''}).reason,/标题/);
  assert.match(validateArticleInput({...SAMPLE_ARTICLE,body:'  '}).reason,/正文/);
  assert.match(validateArticleInput({...SAMPLE_ARTICLE,description:''}).reason,/短说明/);
  assert.match(validateArticleInput({...SAMPLE_ARTICLE,cover:{...SAMPLE_COVER,width:1600,height:900}}).reason,/5:2/);
  assert.match(validateArticleInput({...SAMPLE_ARTICLE,cover:{...SAMPLE_COVER,dataUrl:'data:image/png;base64,'}}).reason,/5:2|字节/);
});

test('X Article publishing uses /compose/articles, uploads 5:2 cover, reloads task-owned draft to verify saved content, submits once with description, and verifies public URL + cover',async()=>{
  const f=fixture();
  const r=await f.publisher.publish({owner:'owner',article:SAMPLE_ARTICLE});
  assert.equal(r.ok,true);
  assert.equal(r.attempted,true);
  assert.equal(r.status,'posted');
  assert.equal(r.publishedPostId,'8899001122');
  assert.equal(r.publishedPostUrl,'https://x.com/owner/status/8899001122');
  assert.equal(r.draftUrl,f.draftUrl);
  assert.deepEqual(f.calls[0],['create',{url:'https://x.com/compose/articles',active:false}]);
  const actionOrder=f.calls.map(c=>c[0]);
  assert.deepEqual(actionOrder.filter(a=>['create_draft','upload_cover','fill','update','verify_saved','submit','proof'].includes(a)),[
    'create_draft',
    'upload_cover',
    'fill',
    'verify_saved',
    'submit',
    'proof'
  ]);
  assert.equal(f.calls.filter(c=>c[0]==='create').length,2);
  assert.equal(f.calls.some(c=>c[0]==='update'),false,'do not navigate away from unsaved writer');
  assert.ok(f.calls.some(c=>c[0]==='open_saved'&&c[2].expectedDraftId==='draft_778899')); 
  assert.deepEqual(f.removed,[102,101]);
});

test('dryRun prepares, reloads, and verifies a task-owned saved draft without clicking final Publish, returning draftUrl',async()=>{
  const f=fixture();
  const r=await f.publisher.publish({owner:'owner',article:SAMPLE_ARTICLE,dryRun:true});
  assert.equal(r.ok,true);
  assert.equal(r.attempted,false);
  assert.equal(r.status,'draft');
  assert.equal(r.draftUrl,f.draftUrl);
  assert.equal(f.calls.some(c=>c[0]==='submit'),false);
  assert.equal(f.calls.some(c=>c[0]==='verify_saved'),true);
  assert.deepEqual(f.removed,[102,101]);
});

test('canPublish is rechecked after reload verification right before final Publish',async()=>{
  const f=fixture();
  let checks=0;
  const r=await f.publisher.publish({
    owner:'owner',
    article:SAMPLE_ARTICLE,
    canPublish:async()=>++checks===1
  });
  assert.equal(r.ok,false);
  assert.equal(r.attempted,false);
  assert.equal(r.status,'draft');
  assert.equal(r.draftUrl,f.draftUrl);
  assert.equal(checks,2);
  assert.equal(f.calls.some(c=>c[0]==='submit'),false);
});

test('uncertain final dispatch or incomplete publication proof returns status:uncertain, attempted:true, draftUrl, and never retries',async()=>{
  for(const opts of [{submitError:true},{proof:null}]){
    const f=fixture(opts);
    const r=await f.publisher.publish({owner:'owner',article:SAMPLE_ARTICLE});
    assert.equal(r.ok,false);
    assert.equal(r.attempted,true);
    assert.equal(r.status,'uncertain');
    assert.equal(r.draftUrl,f.draftUrl);
    assert.equal(f.calls.filter(c=>c[0]==='submit').length,1);
    assert.deepEqual(f.removed,[102,101]);
  }
});

test('article page functions preserve preexisting drafts and use the exporter rich-paste entry without replacing ContentState directly',async()=>{
  const prevWin=globalThis.window,prevDoc=globalThis.document,prevLoc=globalThis.location;
  const prevFile=globalThis.File,prevDT=globalThis.DataTransfer,prevClip=globalThis.ClipboardEvent;
  try{
    const rect=()=>({width:400,height:160,top:10,bottom:170});
    let draftRowClicked=false;
    const draftRow={
      getBoundingClientRect:rect,
      click(){draftRowClicked=true;},
      closest:()=>draftRow
    };
    const titleEl={
      value:'',
      getBoundingClientRect:rect,
      closest:()=>null,
      focus(){},
      dispatchEvent(){return true;}
    };
    const editorEl={
      innerText:'',
      textContent:'',
      getBoundingClientRect:rect,
      closest:()=>null,
      contains:()=>false,
      focus(){},
      querySelectorAll:()=>[],
      dispatchEvent(){return true;}
    };
    const coverImg={
      complete:false,
      naturalWidth:0,
      naturalHeight:0,
      src:'blob:https://x.com/crop-preview',
      closest:()=>null
    };
    editorEl.dispatchEvent=ev=>{if(ev.type==='paste')editorEl.innerText=ev.clipboardData.getData('text/plain');return true;};
    editorEl.__reactFiber$test={stateNode:{_latestEditorState:{getCurrentContent:()=>({getBlocksAsArray:()=>editorEl.innerText.split('\n').map(text=>({getText:()=>text}))})}}};
    const fileInput={
      files:null,
      closest:()=>null,
      dispatchEvent(ev){
        if(ev.type==='change'){
          coverImg.complete=true;
          coverImg.naturalWidth=1200;
          coverImg.naturalHeight=480;
        }
        return true;
      }
    };
    const applyBtn={
      disabled:false,
      innerText:'Apply',
      getAttribute:k=>k==='data-testid'?'applyButton':null,
      getBoundingClientRect:rect,
      click(){this.clicked=true;coverImg.src='https://pbs.twimg.com/media/cover.png';}
    };
    const topPublishBtn={
      disabled:false,
      innerText:'Publish',
      getAttribute:()=>null,
      getBoundingClientRect:rect,
      closest:()=>null,
      click(){
        dialogVisible=true;
      }
    };
    let dialogVisible=false;
    const descTextarea={
      getBoundingClientRect:rect,
      tagName:'TEXTAREA',
      value:'',
      focus(){},
      dispatchEvent(){return true;}
    };
    const finalPublishBtn={
      disabled:false,
      innerText:'Publish',
      getAttribute:()=>null,
      getBoundingClientRect:rect,
      click(){
        this.clicked=true;
        globalThis.location.pathname='/owner/status/8899001122';
        globalThis.location.href='https://x.com/owner/status/8899001122';
      }
    };
    const publishDialog={
      innerText:'Publish article\nAdd a post',
      getBoundingClientRect:()=>({width:0,height:0}), // X dialog wrapper has no box; its textarea is visible
      querySelector:sel=>sel.includes('textarea')?descTextarea:null,
      querySelectorAll:sel=>sel.includes('button')?[finalPublishBtn]:[]
    };
    const createBtn={
      innerText:'Create',
      getAttribute:k=>k==='aria-label'?'create':null,
      getBoundingClientRect:rect,
      closest:()=>null,
      click(){
        globalThis.location.pathname='/compose/articles/edit/new_123';
        globalThis.location.href='https://x.com/compose/articles/edit/new_123';
      }
    };

    globalThis.location={
      pathname:'/compose/articles',
      href:'https://x.com/compose/articles',
      origin:'https://x.com'
    };
    globalThis.window={HTMLTextAreaElement:{prototype:{}}};
    globalThis.File=class{constructor(parts,name,opts){this.parts=parts;this.name=name;this.type=opts?.type;}};
    globalThis.DataTransfer=class{constructor(){this.files=[];this.data={};this.items={add:f=>this.files.push(f)};}setData(k,v){this.data[k]=v;}getData(k){return this.data[k]||'';}};
    globalThis.ClipboardEvent=class{constructor(type,options){this.type=type;this.clipboardData=options.clipboardData;}};
    globalThis.document={
      body:{innerText:'Saved',querySelectorAll:()=>[coverImg]},
      querySelector:sel=>{
        if(sel==='a[data-testid="AppTabBar_Profile_Link"]')return {getAttribute:()=>'/owner'};
        if(sel==='main')return {querySelectorAll:()=>[coverImg]};
        return null;
      },
      querySelectorAll:sel=>{
        if(sel.includes('article_draft_row'))return [draftRow];
        if(sel.includes('aria-label="create"'))return [draftRow,createBtn];
        if(sel.includes('textarea'))return globalThis.location.pathname.includes('/edit/')?[titleEl]:[];
        if(sel.includes('data-testid="composer"'))return globalThis.location.pathname.includes('/edit/')?[editorEl]:[];
        if(sel.includes('main img'))return coverImg.complete?[coverImg]:[];
        if(sel.includes('fileInput'))return [fileInput];
        if(sel.includes('applyButton'))return [applyBtn];
        if(sel==='[role="dialog"]')return dialogVisible?[publishDialog]:[];
        if(sel==='button,[role="button"]')return [topPublishBtn];
        return [];
      },
      execCommand:(cmd,_ui,val)=>{
        if(cmd==='insertText')editorEl.innerText+=(editorEl.innerText?'\n':'')+val;
        return true;
      }
    };

    const created=await articleComposerOnPage('owner',{},'create_draft');
    assert.equal(created.ok,true);
    assert.equal(draftRowClicked,false,'must never click preexisting article_draft_row');
    assert.equal(created.draftId,'new_123');

    const uploaded=await articleComposerOnPage('owner',{cover:SAMPLE_COVER,expectedDraftId:'new_123'},'upload_cover',created.scopeToken);
    assert.equal(uploaded.ok,true);
    assert.equal(uploaded.appliedCrop,true);
    assert.equal(uploaded.cover.isFiveByTwo,true);

    const filled=await articleComposerOnPage('owner',{title:SAMPLE_ARTICLE.title,body:SAMPLE_ARTICLE.body,expectedDraftId:'new_123'},'fill',created.scopeToken);
    assert.equal(filled.ok,true);

    const verified=await articleComposerOnPage('owner',{title:SAMPLE_ARTICLE.title,body:SAMPLE_ARTICLE.body,expectedDraftId:'new_123',allowRebind:true},'verify_saved',created.scopeToken);
    assert.equal(verified.ok,true);

    const submitted=await articleComposerOnPage('owner',{...SAMPLE_ARTICLE,expectedDraftId:'new_123'},'submit',created.scopeToken);
    assert.equal(submitted.ok,true);
    assert.equal(submitted.attempted,true);
    assert.equal(descTextarea.value,SAMPLE_ARTICLE.description);
    assert.equal(finalPublishBtn.clicked,true);

    globalThis.document.body.innerText=`${SAMPLE_ARTICLE.title}\n${SAMPLE_ARTICLE.description}`;
    const pubProof=readArticlePublicationOnPage('owner',SAMPLE_ARTICLE,40000);
    assert.deepEqual(pubProof,{
      id:'8899001122',
      url:'https://x.com/owner/status/8899001122',
      coverVerified:true,
      titleVerified:true
    });
  }finally{
    globalThis.window=prevWin;
    globalThis.document=prevDoc;
    globalThis.location=prevLoc;
    globalThis.File=prevFile;
    globalThis.DataTransfer=prevDT;
    globalThis.ClipboardEvent=prevClip;
  }
});


test('rich paste uses the latest Draft state, accepts Chinese saved feedback and never retries a rejected insertion',async()=>{
  const previous={window:globalThis.window,document:globalThis.document,location:globalThis.location,DataTransfer:globalThis.DataTransfer,ClipboardEvent:globalThis.ClipboardEvent};
  try{
    const run=async scramble=>{
      let draftText='',pastes=0;
      const rect=()=>({width:400,height:160});
      const titleEl={value:'',getBoundingClientRect:rect,closest:()=>null,focus(){},dispatchEvent(){}};
      const editorEl={innerText:'',getBoundingClientRect:rect,closest:()=>null,contains:()=>false,focus(){},querySelectorAll:()=>[],dispatchEvent(event){pastes++;draftText=scramble?'wrong':event.clipboardData.getData('text/plain');}};
      editorEl.__reactFiber$test={stateNode:{_latestEditorState:{getCurrentContent:()=>({getBlocksAsArray:()=>draftText.split('\n').map(text=>({getText:()=>text}))})}}};
      const button={disabled:false,innerText:'Publish',getAttribute:()=>null,getBoundingClientRect:rect,closest:()=>null};
      globalThis.location={pathname:'/compose/articles/edit/d1',href:'https://x.com/compose/articles/edit/d1',origin:'https://x.com'};
      globalThis.window={HTMLTextAreaElement:{prototype:{}},__xfArticleComposerScope:{token:'t',owner:'owner',draftId:'d1',draftUrl:location.href}};
      globalThis.DataTransfer=class{constructor(){this.data={};}setData(k,v){this.data[k]=v;}getData(k){return this.data[k];}};
      globalThis.ClipboardEvent=class{constructor(type,options){this.type=type;this.clipboardData=options.clipboardData;}};
      globalThis.document={body:{innerText:'刚刚最后保存'},querySelector:()=>({getAttribute:()=>'/owner'}),querySelectorAll:selector=>selector.includes('textarea')?[titleEl]:selector.includes('composer')?[editorEl]:selector==='button,[role="button"]'?[button]:[],execCommand:()=>{throw Error('Direct DOM insertion must not be used');}};
      const result=await articleComposerOnPage('owner',{title:'T',body:'p1\n\np2\n\np3',expectedDraftId:'d1'},'fill','t');
      return {result,pastes};
    };
    const ok=await run(false);assert.equal(ok.result.ok,true,ok.result.reason);assert.equal(ok.pastes,1);
    const bad=await run(true);assert.equal(bad.result.ok,false);assert.equal(bad.pastes,1);assert.match(bad.result.reason,/完整写入/);
  }finally{Object.assign(globalThis,previous);}
});
