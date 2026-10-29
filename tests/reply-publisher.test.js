import test from 'node:test';
import assert from 'node:assert/strict';
import {createReplyPublisher} from '../src/features/publishing/reply-publisher.js';
import {replyComposerOnPage,readReplyPublicationOnPage} from '../src/features/publishing/reply-page.js';

function fixture({
  sourcePostUrl='https://x.com/targetUser/status/987654321012345678',
  proof={id:'555666777',url:'https://x.com/owner/status/555666777',textComplete:true,sourcePostId:'987654321012345678'},
  inspect={ok:true,empty:true,scopeToken:'reply-scope-1',ready:false},
  fill={ok:true,filled:true,ready:true,textLength:18,scopeToken:'reply-scope-1'},
  submit={ok:true,attempted:true},
  submitError=false
}={}) {
  const calls=[],removed=[];
  const api={
    tabs:{
      create:async options=>{calls.push(['create',options]);return {id:91};},
      update:async(_id,options)=>calls.push(['update',options]),
      remove:async id=>removed.push(id)
    },
    scripting:{
      executeScript:async({func,args})=>{
        if(func.name==='setQuoteFrameFallbackOnPage')return [{result:undefined}];
        if(func.name==='readReplyPublicationOnPage'){
          calls.push(['proof',args[0],args[1],args[2]]);
          return [{result:typeof proof==='function'?proof(calls):proof}];
        }
        const [owner,srcUrl,text,action,token]=args;
        calls.push([action,owner,srcUrl,text,token]);
        if(action==='submit'&&submitError)throw Error('lost scripting response');
        if(['fill','submit'].includes(action))assert.equal(token,'reply-scope-1','must pin to the unique reply composer scopeToken');
        if(action==='inspect')return [{result:inspect}];
        if(action==='fill')return [{result:fill}];
        if(action==='submit')return [{result:submit}];
        return [{result:{ok:true,attempted:false}}];
      }
    }
  };
  return {
    calls,
    removed,
    sourcePostUrl,
    publisher:createReplyPublisher({
      api,
      sleep:async()=>{},
      now:()=>20000,
      openComposer:async url=>{
        const tab=await api.tabs.create({url,active:false});
        return {tabId:tab.id,close:()=>api.tabs.remove(tab.id)};
      }
    })
  };
}

test('direct reply opens task-owned inactive tab for exact source post, submits once, and verifies published reply',async()=>{
  const f=fixture();
  const r=await f.publisher.publish({
    owner:'owner',
    sourcePostUrl:f.sourcePostUrl,
    text:'直接回复需要验证原帖ID与回帖归属。'
  });
  assert.equal(r.ok,true);
  assert.equal(r.attempted,true);
  assert.equal(r.status,'posted');
  assert.equal(r.publishedPostId,'555666777');
  assert.equal(r.publishedPostUrl,'https://x.com/owner/status/555666777');
  assert.deepEqual(f.calls[0],['create',{url:f.sourcePostUrl,active:false}]);
  assert.equal(f.calls.filter(c=>c[0]==='fill').length,1);
  assert.equal(f.calls.filter(c=>c[0]==='submit').length,1);
  assert.equal(f.calls.some(c=>c[0]==='clear'),false);
  assert.deepEqual(f.removed,[91]);
});

test('direct reply rejects invalid sourcePostUrl or empty text before opening or submitting',async()=>{
  const f=fixture();
  const r1=await f.publisher.publish({owner:'owner',sourcePostUrl:'https://x.com/targetUser/likes',text:'valid text'});
  assert.equal(r1.ok,false);
  assert.equal(r1.attempted,false);
  assert.equal(r1.status,'draft');
  assert.match(r1.reason,/Snowflake ID/);

  const r2=await f.publisher.publish({owner:'owner',sourcePostUrl:f.sourcePostUrl,text:'   '});
  assert.equal(r2.ok,false);
  assert.equal(r2.attempted,false);
  assert.equal(r2.status,'draft');
  assert.equal(f.calls.length,0);
});

test('dryRun fills and verifies reply composer without submitting, then clears only task-owned draft',async()=>{
  const f=fixture();
  const r=await f.publisher.publish({
    owner:'owner',
    sourcePostUrl:f.sourcePostUrl,
    text:'Dry run reply body.',
    dryRun:true
  });
  assert.equal(r.ok,true);
  assert.equal(r.attempted,false);
  assert.equal(r.status,'draft');
  assert.equal(f.calls.some(c=>c[0]==='submit'),false);
  assert.equal(f.calls.some(c=>c[0]==='clear'),true);
  assert.deepEqual(f.removed,[91]);
});

test('existing user draft is preserved without clearing or submitting',async()=>{
  const f=fixture({fill:{ok:false,filled:false,reason:'回复编辑器已有草稿，未覆盖'}});
  const r=await f.publisher.publish({
    owner:'owner',
    sourcePostUrl:f.sourcePostUrl,
    text:'Should not overwrite existing draft'
  });
  assert.equal(r.ok,false);
  assert.equal(r.attempted,false);
  assert.equal(r.status,'draft');
  assert.equal(f.calls.some(c=>c[0]==='submit'),false);
  assert.equal(f.calls.some(c=>c[0]==='clear'),false);
});

test('canPublish is rechecked immediately before submit and aborts cleanly when revoked',async()=>{
  const f=fixture();
  let checks=0;
  const r=await f.publisher.publish({
    owner:'owner',
    sourcePostUrl:f.sourcePostUrl,
    text:'Recheck before submit.',
    canPublish:async()=>++checks===1
  });
  assert.equal(r.ok,false);
  assert.equal(r.attempted,false);
  assert.equal(r.status,'draft');
  assert.equal(checks,2);
  assert.equal(f.calls.some(c=>c[0]==='submit'),false);
  assert.equal(f.calls.some(c=>c[0]==='clear'),true);
});

test('ambiguous submit dispatch or missing proof returns attempted:true and status:uncertain without clearing or retrying',async()=>{
  for(const opts of [{submitError:true},{proof:null}]){
    const f=fixture(opts);
    const r=await f.publisher.publish({
      owner:'owner',
      sourcePostUrl:f.sourcePostUrl,
      text:'Uncertain dispatch test.'
    });
    assert.equal(r.ok,false);
    assert.equal(r.attempted,true);
    assert.equal(r.status,'uncertain');
    assert.equal(f.calls.filter(c=>c[0]==='submit').length,1);
    assert.equal(f.calls.some(c=>c[0]==='clear'),false);
    assert.deepEqual(f.removed,[91]);
  }
});

test('page functions are self-contained and enforce owner, Snowflake ID, unique editor and attached proof in mocked DOM',async()=>{
  const prevWin=globalThis.window,prevDoc=globalThis.document,prevLoc=globalThis.location;
  try{
    const rect=()=>({width:200,height:60,top:10,bottom:70});
    const input={
      innerText:'',
      textContent:'',
      isConnected:true,
      isContentEditable:true,
      getAttribute:k=>k==='contenteditable'?'true':null,
      getBoundingClientRect:rect,
      focus(){},
      dispatchEvent(){
        this.innerText='测试精确回复正文';
        return true;
      },
      closest:sel=>sel==='[data-testid="primaryColumn"]'?primaryColumn:null
    };
    const sendBtn={
      disabled:false,
      getAttribute:()=>null,
      getBoundingClientRect:rect,
      click(){this.clicked=true;}
    };
    const sourceLink={href:'https://x.com/author/status/11223344',getAttribute:()=>'/author/status/11223344',contains:()=>false};
    const sourceArticle={
      getBoundingClientRect:rect,
      querySelectorAll:sel=>sel==='a[href]'?[sourceLink]:[],
      querySelector:()=>null
    };
    const replyTime={getAttribute:k=>k==='datetime'?new Date(25000).toISOString():null};
    const replyLink={href:'https://x.com/owner/status/99887766',getAttribute:()=>'/owner/status/99887766',contains:n=>n===replyTime};
    const replyArticle={
      innerText:'Replying to @author\n测试精确回复正文',
      getBoundingClientRect:rect,
      querySelectorAll:sel=>sel==='a[href]'?[replyLink]:[],
      querySelector:sel=>sel==='time'?replyTime:sel==='[data-testid="tweetText"]'?{innerText:'测试精确回复正文'}:null
    };
    const primaryColumn={
      isConnected:true,
      contains:()=>true,
      querySelector:sel=>sel.includes('tweetButton')?sendBtn:null,
      querySelectorAll:sel=>sel.includes('tweetButton')?[sendBtn]:[]
    };
    globalThis.location={pathname:'/author/status/11223344',origin:'https://x.com'};
    globalThis.window={};
    globalThis.MutationObserver=class{observe(){}disconnect(){}};
    globalThis.DataTransfer=class{setData(){}};
    globalThis.ClipboardEvent=class{constructor(){}};
    globalThis.document={
      body:primaryColumn,
      querySelector:sel=>sel==='a[data-testid="AppTabBar_Profile_Link"]'?{getAttribute:()=>'/owner'}:null,
      querySelectorAll:sel=>{
        if(sel==='[role="dialog"]')return [];
        if(sel.includes('article'))return [sourceArticle,replyArticle];
        if(sel.includes('tweetTextarea_0'))return [input];
        return [];
      },
      execCommand:()=>true
    };

    const wrongOwner=await replyComposerOnPage('other','https://x.com/author/status/11223344','','inspect');
    assert.equal(wrongOwner.ok,false);

    const inspected=await replyComposerOnPage('owner','https://x.com/author/status/11223344','','inspect');
    assert.equal(inspected.ok,true);
    assert.ok(inspected.scopeToken);

    const filled=await replyComposerOnPage('owner','https://x.com/author/status/11223344','测试精确回复正文','fill',inspected.scopeToken);
    assert.equal(filled.ok,true);
    assert.equal(filled.ready,true);

    const submitted=await replyComposerOnPage('owner','https://x.com/author/status/11223344','测试精确回复正文','submit',inspected.scopeToken);
    assert.equal(submitted.ok,true);
    assert.equal(submitted.attempted,true);
    assert.equal(sendBtn.clicked,true);

    const proof=readReplyPublicationOnPage('owner','https://x.com/author/status/11223344','测试精确回复正文',20000);
    assert.deepEqual(proof,{
      id:'99887766',
      url:'https://x.com/owner/status/99887766',
      textComplete:true,
      sourcePostId:'11223344'
    });
  }finally{
    globalThis.window=prevWin;
    globalThis.document=prevDoc;
    globalThis.location=prevLoc;
  }
});

test('publication proof includes X emoji image alt text and still requires exact content',()=>{
 const oldDoc=globalThis.document,oldLoc=globalThis.location;
 const textNode=text=>({nodeType:3,textContent:text});const emoji={nodeName:'IMG',getAttribute:()=> '🤝'};
 const body={innerText:'关注我，必回关！\n#互关',querySelector:()=>emoji,childNodes:[textNode('关注我，必回关！'),emoji,{nodeName:'BR'},textNode('#互关')]};
 const time={getAttribute:()=>new Date(30000).toISOString()},link={href:'https://x.com/owner/status/9988',contains:()=>true,getAttribute:()=>'/owner/status/9988'};
 const article={querySelector:s=>s==='time'?time:s.includes('tweetText')?body:null,querySelectorAll:()=>[link]};
 globalThis.location={pathname:'/author/status/1122',origin:'https://x.com'};globalThis.document={querySelector:()=>({getAttribute:()=>'/owner'}),querySelectorAll:()=>[article,{querySelectorAll:()=>[{href:'https://x.com/author/status/1122'}],querySelector:()=>null}]};
 try{assert.equal(readReplyPublicationOnPage('owner','https://x.com/author/status/1122','关注我，必回关！🤝\n#互关',20000)?.id,'9988');assert.equal(readReplyPublicationOnPage('owner','https://x.com/author/status/1122','关注我，必回关！😄\n#互关',20000),null);}finally{globalThis.document=oldDoc;globalThis.location=oldLoc;}
});
