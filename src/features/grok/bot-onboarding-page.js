// Serialized by chrome.scripting: keep every helper inside this function.
export function runBotOnboardingPage(input) {
  const url=new URL(location.href);
  const visible=e=>Boolean(e?.getClientRects().length)&&!e.closest('[aria-hidden="true"]');
  const text=e=>String(e?.innerText||e?.textContent||'').replace(/\s+/g,' ').trim();
  const buttons=()=>[...document.querySelectorAll('button,[role="button"],[role="menuitem"]')].filter(visible);
  const clickLabel=(pattern,root=document)=>{
    const found=[...root.querySelectorAll('button,[role="button"],[role="menuitem"]')].filter(visible).filter(e=>pattern.test(text(e))||pattern.test(e.getAttribute('aria-label')||''));
    if(found.length!==1||found[0].disabled||found[0].getAttribute('aria-disabled')==='true')return false;
    found[0].click();return true;
  };
  const fill=(element,value)=>{
    if(!element||!visible(element)||element.disabled||element.readOnly)return false;
    if(element.isContentEditable){
      if(element.innerText===value)return true;
      element.focus();const range=document.createRange();range.selectNodeContents(element);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
      document.execCommand('insertText',false,value);return element.innerText===value;
    }
    if(element.value===value)return true;
    const proto=element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value').set.call(element,value);
    element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return true;
  };
  if(!input||!['cloudflare','grok'].includes(input.provider))throw Error('未知接入页面');
  const expected=input.provider==='cloudflare'?'dash.cloudflare.com':'grok.com';
  if(url.protocol!=='https:'||url.hostname!==expected)return {state:'wrong-page'};
  const body=text(document.body);
  const challengeFrame=[...document.querySelectorAll('iframe')].some(e=>e.src?.startsWith('https://challenges.cloudflare.com/')&&visible(e)&&e.getBoundingClientRect().height>40);
  const challengeDialog=[...document.querySelectorAll('[role="dialog"]')].some(e=>visible(e)&&/^(Making sure you're human|正在进行安全验证)/i.test(text(e)));
  if(challengeFrame||challengeDialog||/^(请稍候|Just a moment)/i.test(document.title)||(/正在进行安全验证|Verify you are human/i.test(body)&&body.length<2000))return {state:'verification'};
  if(input.provider==='cloudflare'){
    if(/\/(login|sign-up|sign-in)/.test(url.pathname)||document.querySelector('input[type="password"]')&&!/api-tokens/.test(url.pathname))return {state:'login'};
    const accountId=url.pathname.match(/^\/([a-f\d]{32})(?:\/|$)/i)?.[1]||'';
    if(input.action==='account')return accountId?{state:'account',accountId}:{state:'choose-account'};
    if(input.action==='workers-onboarding'){
      if(accountId!==input.accountId||!url.pathname.includes('/workers-and-pages'))return {state:'wrong-page'};
      const labels=[...document.querySelectorAll('label')];
      const candidates=[...document.querySelectorAll('input')].filter(e=>visible(e)&&e.type==='text'&&/subdomain|子域/i.test([e.name,e.id,e.placeholder,e.getAttribute('aria-label'),...labels.filter(label=>label.htmlFor===e.id).map(label=>label.textContent)].join(' ')));
      if(candidates.length===1&&!candidates[0].value&&/^[a-z][a-z\d-]{5,40}$/.test(input.suggestedSubdomain||''))fill(candidates[0],input.suggestedSubdomain);
      return {state:'authorization',subdomainReady:candidates.length===1&&Boolean(candidates[0].value)};
    }
    if(!url.pathname.startsWith('/profile/api-tokens'))return {state:'wrong-page'};
    const name=input.tokenName;
    const nameInput=[...document.querySelectorAll('input')].find(e=>visible(e)&&e.value===name);
    // Never inspect a list of existing credentials. Only the owned creation flow.
    const owned=Boolean(nameInput)||url.searchParams.get('name')===name||body.includes(name);
    if(!owned)return {state:'wrong-page'};
    const newToken=/成功创建|已创建.*令牌|令牌已创建|Successfully created|successfully created|API token has been created|令牌.*已成功/i.test(body);
    if(newToken){
      const values=[...document.querySelectorAll('pre,code,input[readonly],input[type="password"],[data-testid*="token-value"],[class~="select-all"]')].filter(visible).map(e=>String(e.value||e.textContent||'').trim()).filter(v=>/^[A-Za-z0-9_-]{40,256}$/.test(v));
      const unique=[...new Set(values)];
      return unique.length===1?{state:'token',token:unique[0]}:{state:'token-not-readable'};
    }
    const permissionInputs=[...document.querySelectorAll('input')].map(e=>e.value);
    if(nameInput){
      if(!['workers_scripts','d1','account_settings'].every(key=>permissionInputs.includes(key)))return {state:'permission-mismatch'};
      if(input.action==='prepare-token'){
        const expiry=buttons().find(e=>/^(7 天|7 days)$/i.test(text(e)));if(expiry)expiry.click();
        if(clickLabel(/^(继续以显示摘要|Continue to summary)$/i))return {state:'authorization'};
      }
      return {state:'authorization'};
    }
    // Creating the API token is the human authorization boundary.
    if(buttons().some(e=>/^(创建令牌|Create Token|Create token)$/i.test(text(e))))return {state:'authorization'};
    return {state:'loading'};
  }
  if(!url.pathname.startsWith('/automations'))return {state:'wrong-page'};
  if(buttons().some(e=>/^(登录|Log in|Sign in)$/i.test(text(e)))&&!buttons().some(e=>/^(新建自动化|New automation)$/i.test(text(e))))return {state:'login'};
  const dialog=[...document.querySelectorAll('[role="dialog"],dialog')].find(e=>visible(e)&&e.querySelector('input[aria-label="自动化任务名称"],input[aria-label="Automation name"],[contenteditable="true"],textarea'));
  if(input.action==='scan')return {state:dialog?'dialog':'ready'};
  if(!input.botName||!input.instruction)return {state:'invalid-input'};
  // Radix hides the parent dialog from accessibility while its portal menu is open.
  // Handle this owned menu before requiring the dialog itself to be visible.
  const activeMenu=[...document.querySelectorAll('[role="menu"]')].find(visible);
  if(activeMenu){
    const owner=[...document.querySelectorAll('[role="dialog"],dialog')].find(e=>e.querySelector('input[aria-label="自动化任务名称"],input[aria-label="Automation name"]')?.value===input.botName);
    if(!owner)return {state:'wrong-task'};
    return clickLabel(/^(Webhook(?:\s|$)|当此 webhook 收到请求时|When a webhook is received)/i,activeMenu)?{state:'webhook-added'}:{state:'trigger-loading'};
  }
  if(!dialog){
    // Reopen only the exact task created by this setup; never another automation.
    const own=[...document.querySelectorAll('button,[role="button"],a,span')].filter(visible).filter(e=>text(e)===input.botName);
    if(own.length===1){own[0].click();return {state:'opening'};}
    if(input.created)return {state:'loading'};
    if(clickLabel(/^(新建自动化|New automation|Create automation)$/i))return {state:'opening'};
    return {state:'loading'};
  }
  const fields=[...dialog.querySelectorAll('input,textarea')].filter(e=>visible(e)&&!['checkbox','radio','hidden','password'].includes(e.type));
  const title=fields.find(e=>e.tagName==='INPUT'&&(e.value===input.botName||/自动化任务|automation|名称|name/i.test([e.placeholder,e.getAttribute('aria-label'),e.value].join(' '))));
  if(title&&title.value!==input.botName&&input.created)return {state:'wrong-task'};
  const instruction=[...dialog.querySelectorAll('[contenteditable="true"]')].find(visible)||fields.find(e=>e.tagName==='TEXTAREA');
  const instructionValue=()=>instruction?.isContentEditable?instruction.innerText:instruction?.value;
  if(input.action==='verify-save'){
    if(title?.value!==input.botName||instructionValue()!==input.instruction)return {state:'save-not-confirmed'};
    const endpoint=text(dialog).match(/(?:https:\/\/)?grok\.com\/webhook\/automation\/[a-f\d-]{36}/i)?.[0];
    if(!endpoint||!input.expectedWebhookUrl?.endsWith(endpoint.replace(/^https:\/\//,'')))return {state:'save-not-confirmed'};
    return {state:'saved'};
  }
  if(title)fill(title,input.botName);
  if(instruction)fill(instruction,input.instruction);
  const endpointMatch=text(dialog).match(/(?:https:\/\/)?grok\.com\/webhook\/automation\/[a-f\d-]{36}/i);
  const secretMatch=text(dialog).match(/whsec_[A-Za-z\d+/=_-]+/);
  if(input.action==='save-webhook'){
    if(title?.value!==input.botName||instructionValue()!==input.instruction||!endpointMatch)return {state:'save-not-confirmed'};
    return clickLabel(/^(保存|Save)$/i,dialog)?{state:'saving'}:{state:'save-pending'};
  }
  if(endpointMatch&&secretMatch){
    const endpoint=endpointMatch[0].startsWith('https:')?endpointMatch[0]:'https://'+endpointMatch[0];
    if(title?.value!==input.botName||instructionValue()!==input.instruction)return {state:'fill-pending'};
    if(input.action==='read-webhook')return {state:'webhook',webhookUrl:endpoint,webhookSecret:secretMatch[0]};
    // Secret is collected before Save closes a one-time display.
    return {state:input.createIntent?'webhook':'webhook-draft',webhookUrl:endpoint,webhookSecret:secretMatch[0]};
  }
  if(/webhook/i.test(text(dialog))&&endpointMatch)return {state:'secret-not-visible'};
  if(/当此 webhook 收到请求时|When this webhook receives a request/i.test(text(dialog))&&title?.value===input.botName&&instructionValue()===input.instruction){
    if(input.action==='inspect-created')return {state:'creation-pending'};
    if(input.action!=='create')return {state:'ready-to-create'};
    return clickLabel(/^(保存|Save)$/i,dialog)?{state:'creating'}:{state:'save-pending'};
  }
  if(clickLabel(/^(Webhook|Webhook 触发器|Add webhook|添加 Webhook)$/i,dialog))return {state:'webhook-added'};
  const menu=[...document.querySelectorAll('[role="menu"]')].find(visible);
  if(menu){return clickLabel(/^(Webhook(?:\s|$)|当此 webhook 收到请求时|When a webhook is received)/i,menu)?{state:'webhook-added'}:{state:'trigger-loading'};}
  if(clickLabel(/^(添加触发器|Add trigger|添加触发条件)$/i,dialog))return {state:'trigger-menu'};
  if(clickLabel(/^(Webhook|当此 webhook 收到请求时|When a webhook is received)$/i))return {state:'webhook-added'};
  return {state:'fill-pending',hasTitle:Boolean(title),hasInstruction:Boolean(instruction)};
}

// Run only in MAIN for this newly-created, owned task. Capture its explicit copy
// controls without reading or changing the user's system clipboard.
export async function captureOwnedGrokWebhook(input){
  const url=new URL(location.href);
  if(url.protocol!=='https:'||url.hostname!=='grok.com'||!url.pathname.startsWith('/automations')||!input.createdHere)return {state:'wrong-page'};
  const visible=e=>Boolean(e?.getClientRects().length)&&!e.closest('[aria-hidden="true"]');
  const dialog=[...document.querySelectorAll('[role="dialog"],dialog')].find(e=>visible(e)&&e.querySelector('input[aria-label="自动化任务名称"],input[aria-label="Automation name"]')?.value===input.botName);
  const editor=dialog?.querySelector('[contenteditable="true"],textarea');
  if(!dialog||String(editor?.isContentEditable?editor.innerText:editor?.value).replace(/\u00a0/g,' ').trim()!==input.instruction.trim())return {state:'wrong-task'};
  const labels=[...dialog.querySelectorAll('*')].filter(e=>e.children.length===0);
  function control(pattern){
    const label=labels.find(e=>pattern.test(e.textContent.trim()));
    for(let row=label?.parentElement;row&&row!==dialog;row=row.parentElement){
      const controls=[...row.querySelectorAll('button')].filter(visible).filter(e=>/^(复制到剪贴板|Copy to clipboard)$/i.test(e.getAttribute('aria-label')||''));
      if(controls.length===1)return controls[0];if(controls.length>1)break;
    }
    return null;
  }
  const endpointButton=control(/^(端点|Endpoint)$/i),secretButton=control(/^(签名密钥|Signing secret)$/i);
  if(!endpointButton||!secretButton||endpointButton===secretButton||!navigator.clipboard)return {state:'credential-unavailable'};
  const clipboard=navigator.clipboard,previous=Object.getOwnPropertyDescriptor(clipboard,'writeText');
  const captured=[];
  try{
    Object.defineProperty(clipboard,'writeText',{configurable:true,value:value=>{captured.push(String(value));return Promise.resolve();}});
    endpointButton.click();await new Promise(resolve=>setTimeout(resolve,80));
    secretButton.click();await new Promise(resolve=>setTimeout(resolve,80));
  }catch{return {state:'credential-unavailable'};}
  finally{if(previous)Object.defineProperty(clipboard,'writeText',previous);else delete clipboard.writeText;}
  const webhookUrl=captured.find(value=>/^https:\/\/grok\.com\/webhook\/automation\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value));
  const webhookSecret=captured.find(value=>/^whsec_[A-Za-z\d+/=_-]{16,}$/.test(value));
  return webhookUrl&&webhookSecret?{state:'webhook',webhookUrl,webhookSecret}:{state:'credential-unavailable'};
}
