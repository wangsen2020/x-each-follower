// Isolated UI acceptance with an optional real local Bot bridge. No publishing APIs.
import {createServer} from 'vite';
import vue from '@vitejs/plugin-vue';
const root=new URL('../',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');
let connection;
if(process.env.KNOWLEDGE_REAL_BOT==='1'){
  const targets=await fetch('http://127.0.0.1:9222/json/list').then(r=>r.json()),panel=targets.find(t=>t.url.includes('panel.html'));
  const ws=new WebSocket(panel.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
  const result=new Promise(resolve=>{ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1)resolve(m);};});
  ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`new Promise((resolve,reject)=>{const request=indexedDB.open('xfollower-grok-local');request.onsuccess=()=>{const db=request.result,r=db.transaction('config').objectStore('config').get('local');r.onsuccess=()=>{db.close();resolve(r.result)};r.onerror=()=>reject(r.error)}})`,awaitPromise:true,returnByValue:true}}));
  connection=(await result).result?.result?.value;ws.close();
  if(!connection?.testedAt||!connection.token||!connection.bot)throw Error('No tested local Bot connection');
}
const samples=[{ownerId:'123',postId:'111',text:'新版本提升了性能，值得试试。',kind:'low',purpose:'comment',key:'own:111',hash:'preview1',capturedAt:Date.now(),metrics:{impressions:12},metricStates:{impressions:'explicit'}}];
const server=await createServer({configFile:false,root,plugins:[vue(),{name:'acceptance-bridge',configureServer(server){server.middlewares.use(async(req,res,next)=>{
  if(!req.url?.startsWith('/acceptance/'))return next();
  res.setHeader('content-type','application/json');
  const send=v=>res.end(JSON.stringify(v));
  if(req.url==='/acceptance/info')return send({bot:connection?.bot||'preview-bot',botName:connection?.botName||'验收Bot',real:Boolean(connection),samples});
  try{
    let text='';for await(const chunk of req)text+=chunk;
    const input=text?JSON.parse(text):{},id=input.id||new URL(req.url,'http://localhost').searchParams.get('id');
    if(!/^acceptance-[\w-]+$/.test(id)||input.prompt?.length>8000)throw Error('Invalid acceptance request');
    if(!connection){
      const task=input.prompt?.match(/"taskId":"([^"]+)"/)?.[1];
      if(input.prompt?.includes('【智慧开始】')){
        const baseVersion=Number(input.prompt.match(/"baseVersion":(\d+)/)?.[1]||0),ids=JSON.parse(input.prompt.match(/"experienceIds":(\[[^\]]*\])/)?.[1]||'[]');
        const items=JSON.parse(input.prompt.split('待合入经验：')[1]||'[]'),before=JSON.parse(input.prompt.split('当前智慧：')[1]?.split('\n待合入经验：')[0]||'""');
        return send({ok:true,text:'【智慧开始】'+JSON.stringify({taskId:task,baseVersion,content:[before,...items.map(e=>e.statement+(e.scope?.conditions?'（'+e.scope.conditions+'）':''))].filter(Boolean).join('\n'),experienceIds:ids,conflicts:[]})+'【智慧结束】'});
      }
      return send({ok:true,text:'【经验开始】'+JSON.stringify({taskId:task,candidates:[{type:'pitfall',statement:'评论需补充具体信息，避免只有泛泛赞美',conditions:'产品发布或技术讨论；缺少可核实信息时提具体问题',evidencePostIds:['111'],reason:'样本只有笼统评价，不能推断曝光因果'}]})+'【经验结束】'});
    }
    const api=async(path,options={})=>{const response=await fetch(`http://127.0.0.1:${connection.port}${path}`,{...options,headers:{authorization:'Bearer '+connection.token,'content-type':'application/json'}});const value=await response.json();if(!response.ok)throw Error('Local Bot HTTP '+response.status);return value;};
    if(input.prompt)await api('/jobs',{method:'POST',body:JSON.stringify({jobId:id,bot:connection.bot,text:input.prompt,timeoutMs:300000})});
    const started=Date.now();while(Date.now()-started<280000){const result=await api('/jobs/'+encodeURIComponent(id));if(result.status==='completed')return send({ok:true,text:result.result});if(result.status==='unknown')return send({ok:false,pending:true,reason:'原任务状态待确认'});await new Promise(r=>setTimeout(r,3000));}
    send({ok:false,pending:true,reason:'等待原任务回复'});
  }catch(error){send({ok:false,pending:true,reason:error.message});}
});}}],server:{host:'127.0.0.1',port:Number(process.env.KNOWLEDGE_PREVIEW_PORT||5187),strictPort:true}});
await server.listen();console.log('Isolated knowledge UI ready; port: '+(process.env.KNOWLEDGE_PREVIEW_PORT||5187)+'; real Bot: '+Boolean(connection));
