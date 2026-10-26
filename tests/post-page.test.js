import test from 'node:test';
import assert from 'node:assert/strict';
import {standaloneComposerOnPage,readStandalonePublicationOnPage} from '../src/features/publishing/post-page.js';

test('new-post composer ignores the background home editor, pastes once and guards the final submit',async()=>{
  const names=['document','location','DataTransfer','ClipboardEvent','window','MutationObserver'];
  const saved=Object.fromEntries(names.map(k=>[k,globalThis[k]]));
  let value='',pastes=0,clicks=0,actor='owner',hasQuote=false,extraDialog=false;
  const button={disabled:false,getAttribute:()=>null,getBoundingClientRect:()=>({width:80,height:30}),click:()=>clicks++};
  let input;const observations=[];
  const root={innerText:'发帖',isConnected:true,getBoundingClientRect:()=>({width:500,height:300}),querySelector:()=>hasQuote?{}:null,
    querySelectorAll:selector=>selector.includes('tweetTextarea')?[input]:[button]};
  input={get innerText(){return value;},get textContent(){return value;},isConnected:true,focus:()=>{},closest:()=>root,
    getBoundingClientRect:()=>({width:400,height:120}),dispatchEvent:event=>{pastes++;value=event.clipboardData.getData('text/plain');}};
  const background={closest:()=>null,getBoundingClientRect:()=>({width:400,height:120})};
  globalThis.location={pathname:'/compose/post'};
  globalThis.window={};
  globalThis.MutationObserver=class{observe(target){observations.push(target);}disconnect(){}};
  globalThis.DataTransfer=class{setData(_type,text){this.text=text;}getData(){return this.text;}};
  globalThis.ClipboardEvent=class{constructor(type,options){this.type=type;Object.assign(this,options);}};
  globalThis.document={querySelector:()=>({getAttribute:()=>'/'+actor}),querySelectorAll:selector=>{
    assert.equal(selector,'[role="dialog"]','global discovery is restricted to dialogs');return extraDialog?[root,{getBoundingClientRect:()=>({width:100,height:100})}]:[root];},
    execCommand:()=>assert.fail('native insert must not duplicate handled paste')};
  try{
    const result=await standaloneComposerOnPage('owner','具体论点\n\n独立依据。','fill');
    assert.equal(result.ok,true);assert.equal(pastes,1);assert.equal(value,'具体论点\n\n独立依据。');
    assert.deepEqual(observations,[root],'observe the bound dialog only');
    assert.equal((await standaloneComposerOnPage('owner',value,'submit','foreign-scope')).attempted,false);
    assert.equal((await standaloneComposerOnPage('owner',value,'submit')).attempted,true);assert.equal(clicks,1);
    assert.equal((await standaloneComposerOnPage('owner','different','submit')).attempted,false);assert.equal(clicks,1);
    extraDialog=true;assert.equal((await standaloneComposerOnPage('owner',value,'submit')).ok,false);assert.equal(clicks,1);extraDialog=false;
    hasQuote=true;assert.equal((await standaloneComposerOnPage('owner',value,'submit')).ok,false);
    hasQuote=false;actor='other';assert.equal((await standaloneComposerOnPage('owner',value,'submit')).ok,false);
    actor='owner';root.isConnected=false;
    assert.equal((await standaloneComposerOnPage('owner',value,'submit',result.scopeToken)).ok,false);assert.equal(clicks,1);
  }finally{for(const k of names){if(saved[k]===undefined)delete globalThis[k];else globalThis[k]=saved[k];}}
});

test('Chinese collapsed posts below 200 characters are discovered and require full-text proof',()=>{
  const savedDocument=globalThis.document,savedLocation=globalThis.location;
  const body='自动化需要完整正文、明确边界和真实结果。'.repeat(8);
  assert.ok(body.length<200);
  let collapsed=true;
  const article={querySelector:selector=>selector==='time'?{getAttribute:()=>new Date(10000).toISOString(),closest:()=>({href:'https://x.com/owner/status/123'})}
    :selector==='[data-testid="tweetText"]'?{innerText:collapsed?body.slice(0,65):body}
    :selector==='[data-testid="tweet-text-show-more-link"]'&&collapsed?{}:null};
  globalThis.location={origin:'https://x.com'};
  globalThis.document={querySelector:()=>({getAttribute:()=>'/owner'}),querySelectorAll:()=>[article]};
  try{
    assert.equal(readStandalonePublicationOnPage('owner',body,10000).textComplete,false);
    collapsed=false;assert.equal(readStandalonePublicationOnPage('owner',body,10000).textComplete,true);
    assert.equal(readStandalonePublicationOnPage('other',body,10000),null);
    assert.equal(readStandalonePublicationOnPage('owner',body,20000),null);
  }finally{globalThis.document=savedDocument;globalThis.location=savedLocation;}
});
