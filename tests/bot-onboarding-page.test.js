import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {runBotOnboardingPage} from '../src/features/grok/bot-onboarding-page.js';

function element({tag='BUTTON',text='',value='',role='',visible=true,...attributes}={}){
  return {tagName:tag,textContent:text,innerText:text,value,disabled:false,readOnly:false,type:tag==='TEXTAREA'?'textarea':'text',placeholder:'',clicked:0,
    dispatchEvent:()=>true,getClientRects:()=>visible?[{}]:[],getBoundingClientRect:()=>({height:attributes.height||30}),closest:()=>null,
    getAttribute:key=>key==='role'?role:attributes[key]||null,click(){this.clicked++;},querySelector:()=>null,querySelectorAll:()=>[],...attributes};
}
function run({url='https://dash.cloudflare.com/profile/api-tokens?name=owned',body='',title='Cloudflare',inputs=[],buttons=[],codes=[],frames=[],dialogs=[],menu=null,input}={}){
  const document={title,body:{innerText:body},querySelector:selector=>selector==='input[type="password"]'?inputs.find(e=>e.type==='password'):null,
    querySelectorAll:selector=>{
      if(selector==='iframe')return frames;
      if(selector==='[role="dialog"]'||selector==='[role="dialog"],dialog')return dialogs;
      if(selector==='[role="menu"]')return menu?[menu]:[];
      if(selector==='input')return inputs;
      if(selector.startsWith('pre,code,'))return codes.filter(e=>!e.selectorRequired||selector.includes(e.selectorRequired));
      if(selector.startsWith('button,'))return buttons;
      return [];
    }};
  const context={URL,location:{href:url},document,Event,HTMLInputElement:{prototype:Object.defineProperty({},'value',{set(value){this.value=value;}})},HTMLTextAreaElement:{prototype:{}}};
  const fn=vm.runInNewContext('('+runBotOnboardingPage.toString()+')',context);
  return fn(input||{provider:'cloudflare',action:'prepare-token',tokenName:'owned'});
}

test('token template checks expected permissions and advances summary but never clicks Create Token',()=>{
  const next=element({text:'继续以显示摘要'}),create=element({text:'创建令牌'}),expiry=element({text:'7 天'});
  const result=run({inputs:['owned','workers_scripts','d1','account_settings'].map(value=>element({tag:'INPUT',value})),buttons:[next,create,expiry],body:'创建令牌 owned'});
  assert.equal(result.state,'authorization');assert.equal(next.clicked,1);assert.equal(expiry.clicked,1);assert.equal(create.clicked,0);
});
test('authorization summary stays manual even if creation button is enabled',()=>{
  const create=element({text:'Create Token'});const result=run({body:'owned permission summary',buttons:[create]});assert.equal(result.state,'authorization');assert.equal(create.clicked,0);
});
test('only a just-created token in the owned creation flow can be extracted',()=>{
  const secret='z'.repeat(48);const codes=[element({tag:'CODE',text:secret,value:''})];
  assert.equal(run({body:'owned API token successfully created',codes}).token,secret);
  assert.equal(run({body:'owned Existing API tokens',codes}).token,undefined);
  assert.equal(run({url:'https://dash.cloudflare.com/profile/api-tokens',body:'unrelated API token successfully created',codes}).state,'wrong-page');
});
test('ambiguous secret values are not guessed',()=>{
  const codes=['a','b'].map(c=>element({tag:'CODE',text:c.repeat(48),value:''}));assert.equal(run({body:'owned successfully created',codes}).state,'token-not-readable');
});
test('permission template omissions stop before continuing to token authorization',()=>{
  const next=element({text:'继续以显示摘要'});const result=run({inputs:['owned','workers_scripts'].map(value=>element({tag:'INPUT',value})),buttons:[next]});assert.equal(result.state,'permission-mismatch');assert.equal(next.clicked,0);
});
test('untrusted origins and challenge pages do not read configuration data',()=>{
  assert.equal(run({url:'https://grok.com.evil.example/automations',input:{provider:'grok',action:'configure'}}).state,'wrong-page');
  assert.equal(run({title:'Just a moment...',body:'Verify you are human'}).state,'verification');
});
test('an invisible challenge frame does not block a normal page',()=>{
  const frame=element({tag:'IFRAME',src:'https://challenges.cloudflare.com/turnstile',height:1});const result=run({frames:[frame],url:'https://dash.cloudflare.com/'+'a'.repeat(32)+'/home',input:{provider:'cloudflare',action:'account'}});assert.equal(result.state,'account');
});
test('Grok save is followed by a separate persistence check, with only the intended task accepted',()=>{
  const name=element({tag:'INPUT',value:'owned', 'aria-label':'自动化任务名称'}),instruction=element({tag:'TEXTAREA',value:'fixed instruction'}),save=element({text:'保存'});
  const endpoint='https://grok.com/webhook/automation/11111111-2222-3333-4444-555555555555';
  const dialog=element({tag:'DIV',text:'owned '+endpoint+' whsec_abcdefghijklmnopqrstuv1234567890',role:'dialog'});
  dialog.querySelector=()=>name;
  dialog.querySelectorAll=selector=>selector==='input,textarea'?[name,instruction]:selector==='[contenteditable="true"]'?[]:selector.startsWith('button,')?[save]:[];
  const input={provider:'grok',action:'save-webhook',botName:'owned',instruction:'fixed instruction',expectedWebhookUrl:endpoint};
  assert.equal(run({url:'https://grok.com/automations',dialogs:[dialog],input}).state,'saving');assert.equal(save.clicked,1);
  assert.equal(run({url:'https://grok.com/automations',dialogs:[dialog],input:{...input,action:'verify-save'}}).state,'saved');
  instruction.value='not persisted';assert.equal(run({url:'https://grok.com/automations',dialogs:[dialog],input:{...input,action:'verify-save'}}).state,'save-not-confirmed');
});

test('Cloudflare may remove template query parameters after prefill; exact owned input still identifies the form',()=>{
  const next=element({text:'继续以显示摘要'});
  const result=run({url:'https://dash.cloudflare.com/profile/api-tokens',inputs:['owned','workers_scripts','d1','account_settings'].map(value=>element({tag:'INPUT',value})),buttons:[next],body:'创建令牌'});
  assert.equal(result.state,'authorization');assert.equal(next.clicked,1);
});

test('Cloudflare new-token text block is read without copying to clipboard',()=>{const secret='x'.repeat(48);const block=element({tag:'DIV',text:secret,value:'',selectorRequired:'[class~="select-all"]'});const result=run({body:'owned API token successfully created',codes:[block]});assert.equal(result.state,'token');assert.equal(result.token,secret);});

test('Grok trigger menu remains operable when Radix aria-hides its owned parent dialog',()=>{
  const name=element({tag:'INPUT',value:'owned'}),dialog=element({tag:'DIV',text:'owned'});dialog.closest=()=>({});dialog.querySelector=()=>name;
  const webhook=element({tag:'DIV',text:'Webhook\n当此 webhook 收到请求时',role:'menuitem'}),menu=element({tag:'DIV',role:'menu'});menu.querySelectorAll=()=>[webhook];
  const result=run({url:'https://grok.com/automations',dialogs:[dialog],menu,input:{provider:'grok',action:'configure',botName:'owned',instruction:'fixed'}});
  assert.equal(result.state,'webhook-added');assert.equal(webhook.clicked,1);
});

test('Grok initial page loading waits instead of rejecting a page before its New button renders',()=>{
  assert.equal(run({url:'https://grok.com/automations',input:{provider:'grok',action:'configure',botName:'owned',instruction:'fixed'}}).state,'loading');
});

test('Grok catalog can load after its schedule menu; no different trigger is clicked',()=>{
  const name=element({tag:'INPUT',value:'owned'}),dialog=element({tag:'DIV'});dialog.querySelector=()=>name;
  const schedule=element({tag:'DIV',text:'每天',role:'menuitem'}),menu=element({tag:'DIV',role:'menu'});menu.querySelectorAll=()=>[schedule];
  const result=run({url:'https://grok.com/automations',dialogs:[dialog],menu,input:{provider:'grok',action:'configure',botName:'owned',instruction:'fixed'}});
  assert.equal(result.state,'trigger-loading');assert.equal(schedule.clicked,0);
});

test('first Workers onboarding prefills an empty subdomain but leaves authorization and user edits untouched',()=>{const field=element({tag:'INPUT',value:'',id:'worker-subdomain'}),confirm=element({text:'确认开通'});const input={provider:'cloudflare',action:'workers-onboarding',accountId:'a'.repeat(32),suggestedSubdomain:'xfollower-example123'};const url='https://dash.cloudflare.com/'+'a'.repeat(32)+'/workers-and-pages';let result=run({url,inputs:[field],buttons:[confirm],input});assert.equal(result.subdomainReady,true);assert.equal(field.value,'xfollower-example123');assert.equal(confirm.clicked,0);field.value='user-choice';run({url,inputs:[field],buttons:[confirm],input});assert.equal(field.value,'user-choice');});
