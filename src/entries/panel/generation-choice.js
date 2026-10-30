import {grokLocal,getLocalAiService,isLocalAiProvider} from '../../features/grok/grok-local.js';
import {grokBotRelay} from '../../features/grok/grok-bot-relay.js';
import {readGrokProvider, selectGrokProvider} from '../../features/grok/grok-provider.js';

export const GENERATION_ENGINES = Object.freeze([
  {value:'grok',label:'X Grok'},
  {value:'grok-local',label:'Grok Bot'},
  {value:'codex',label:'Codex'},
  {value:'antigravity',label:'Antigravity'},
  {value:'grok-bot',label:'Grok Webhook'}
]);

// Connection checks never send a generation request or change the selected engine.
export async function inspectGenerationEngine(provider, local=grokLocal, webhook=grokBotRelay) {
  if(provider==='grok')return {ready:true};
  if(provider==='grok-bot')return {ready:Boolean((await webhook.status()).enabled)};
  if(!isLocalAiProvider(provider))throw Error('请选择 AI 引擎');
  if(provider!=='grok-local'&&local===grokLocal)local=getLocalAiService(provider);
  const config=await local.configuration();
  if(!config?.testedAt)return {ready:false,bots:[]};
  const bots=await local.list(config);
  return {ready:bots.length>0,bots,bot:config.bot};
}

export async function saveGenerationChoice(draft, save, {local=grokLocal,readProvider=readGrokProvider,selectProvider=selectGrokProvider}={}) {
  if(!draft.generationProvider)return save(); // Legacy callers retain their settings semantics.
  const engine=draft.generationProvider;
  if(isLocalAiProvider(engine)&&engine!=='grok-local'&&local===grokLocal)local=getLocalAiService(engine);
  if(!draft.grokEnabled)return save();
  const previousBot=isLocalAiProvider(engine) ? (await local.configuration?.())?.bot : null;
  if(isLocalAiProvider(engine))await local.selectBot(draft.generationBotId);
  const previous=await readProvider();
  const result=await selectProvider(engine);
  if(result.connectionRequired)throw Error('请先完成所选引擎的连接配置');
  // Restore only on a definite rejection. A lost response may already have saved settings.
  const response=await save();
  if(!response?.ok){
    if(previousBot && previousBot!==draft.generationBotId)await local.selectBot(previousBot);
    if(engine!==previous)await selectProvider(previous);
  }
  return response;
}

export function generationChoice({el,help,draft,provider,onConfigure,local=grokLocal,inspect=inspectGenerationEngine}) {
  draft.generationProvider ||= provider || 'grok';
  const details=el('div',{className:'fq-generation-details'});
  const botSlot=el('div',{className:'fq-generation-bot'});
  let revision=0;
  async function refresh(){
    const ticket=++revision;
    details.replaceChildren();
    botSlot.replaceChildren();
    if(!draft.grokEnabled)return;
    const engine=draft.generationProvider;
    if(engine==='grok'){
      details.appendChild(el('span',{},'使用当前 X 登录账号生成内容。'));
      return;
    }
    details.appendChild(el('span',{role:'status'},'正在检测连接…'));
    try{
      const state=await inspect(engine,local);
      if(ticket!==revision)return;
      details.replaceChildren();
      if(isLocalAiProvider(engine) && state.ready){
        if(!draft.generationBotId)draft.generationBotId=state.bot || state.bots[0]?.id || '';
        const control=el('select',{id:'fq_generationBot','aria-label':'生成会话',value:draft.generationBotId,onChange:e=>{draft.generationBotId=e.target.value;}},[
          el('option',{value:'',selected:!state.bots.some(b=>b.id===draft.generationBotId)},'请选择会话'),
          ...state.bots.map(bot=>el('option',{value:bot.id,selected:bot.id===draft.generationBotId},bot.name))
        ]);
        botSlot.appendChild(control);
      }
      details.appendChild(el('span',{role:'status'},isLocalAiProvider(engine)
        ? state.ready?'引擎可用 · 使用所选会话':'本地服务尚未连接'
        : state.ready?'Webhook 已连接 · 仅建议备用':'Webhook 尚未连接 · 仅建议备用'));
      details.appendChild(el('button',{type:'button',className:'fq-btn fq-btn-secondary',onClick:()=>onConfigure(engine)},state.ready?'管理连接':'配置连接'));
      details.appendChild(el('button',{type:'button',className:'fq-btn fq-btn-secondary',onClick:refresh},'重新检测'));
    }catch(error){
      if(ticket!==revision)return;
      details.replaceChildren(el('span',{role:'alert'},error.message),
        el('button',{type:'button',className:'fq-btn fq-btn-secondary',onClick:()=>onConfigure(engine)},'检查连接'),
        el('button',{type:'button',className:'fq-btn fq-btn-secondary',onClick:refresh},'重新检测'));
    }
  }
  const select=el('select',{id:'fq_grokProvider','aria-label':'AI 引擎',value:draft.generationProvider,onChange:e=>{
    draft.generationProvider=e.target.value;draft.generationBotId='';
    void refresh();
  }},GENERATION_ENGINES.map(engine=>el('option',{value:engine.value,selected:draft.generationProvider===engine.value},engine.label)));
  const engineRow=el('div',{className:'fq-setting-row fq-generation-row'},[el('label',{'for':'fq_grokProvider'},'AI 引擎'),select,botSlot]);
  engineRow.hidden=!draft.grokEnabled;
  const toggle=el('input',{id:'fq_commentEnabled',type:'checkbox',checked:draft.grokEnabled,onChange:e=>{draft.grokEnabled=e.target.checked;engineRow.hidden=!draft.grokEnabled;void refresh();}});
  void refresh();
  return el('div',{className:'fq-generation-choice'},[
    el('div',{className:'fq-setting-row'},[el('label',{'for':'fq_commentEnabled'},[toggle,el('span',{},'评论开关'),help('开启后选择 AI 引擎，关闭则暂停生成、不影响关注。是否公开由“自动公开发布”控制。点击保存后生效；连接保存在本机；选择的引擎和会话用于评论。')])]),engineRow,details
  ]);
}
