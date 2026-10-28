import fs from 'node:fs';
const sessionPath=new URL('../knowledge-acceptance-session.json',import.meta.url);
const targets=()=>fetch('http://127.0.0.1:9222/json/list').then(r=>r.json());
async function connect(target){
  const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>socket.onopen=r);let serial=0;const pending=new Map();
  socket.onmessage=e=>{const value=JSON.parse(e.data);if(value.id){pending.get(value.id)?.(value);pending.delete(value.id);}};
  return {close:()=>socket.close(),send:(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},30000);pending.set(id,value=>{clearTimeout(timer);value.error?reject(Error(JSON.stringify(value.error))):resolve(value.result);});socket.send(JSON.stringify({id,method,params}));})};
}
const mode=process.argv[2];
if(mode==='open'){
  const panel=(await targets()).find(t=>t.url.includes('panel.html')),connection=await connect(panel);
  const url='http://127.0.0.1:'+(process.env.KNOWLEDGE_PREVIEW_PORT||5187)+'/tests/fixtures/knowledge-learning-preview.html';
  const result=await connection.send('Runtime.evaluate',{expression:`chrome.tabs.create({url:${JSON.stringify(url)},active:false})`,awaitPromise:true,returnByValue:true});
  connection.close();fs.writeFileSync(sessionPath,JSON.stringify({tabId:result.result.value.id,url}));console.log('Created inactive acceptance tab '+result.result.value.id);
}else{
  const session=JSON.parse(fs.readFileSync(sessionPath,'utf8'));
  if(mode==='close'){
    const panel=(await targets()).find(t=>t.url.includes('panel.html')),connection=await connect(panel);
    await connection.send('Runtime.evaluate',{expression:`chrome.tabs.remove(${session.tabId})`,awaitPromise:true});connection.close();console.log('Closed only acceptance tab');
  }else{
    const target=(await targets()).find(t=>t.url===(session.url||'http://127.0.0.1:'+(process.env.KNOWLEDGE_PREVIEW_PORT||5187)+'/tests/fixtures/knowledge-learning-preview.html'));if(!target)throw Error('Acceptance tab absent');
    const connection=await connect(target);
    if(mode==='screenshot'){
      const width=Number(process.argv[3]||1280),path=process.argv[4];
      await connection.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<600});
      const alignment=await connection.send('Runtime.evaluate',{expression:"({centers:[...document.querySelectorAll('.kb-pagination > span,.kb-pagination .kb-select-field > span,.kb-pagination select,.kb-page-controls > button')].map(e=>e.getBoundingClientRect().y+e.getBoundingClientRect().height/2),gap:document.querySelector('.kb-page-controls')?.getBoundingClientRect().left-document.querySelector('.kb-pagination > span')?.getBoundingClientRect().right})",returnByValue:true});console.log(JSON.stringify(alignment.result.value));
      const shot=await connection.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path,Buffer.from(shot.data,'base64'));const metrics=await connection.send('Runtime.evaluate',{expression:"({viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,tableWidth:document.querySelector('.experience-table')?.getBoundingClientRect().width,dialogWidth:document.querySelector('dialog[open]')?.getBoundingClientRect().width})",returnByValue:true});console.log(path+' '+JSON.stringify(metrics.result.value));
    }else{
      let expression='';for await(const chunk of process.stdin)expression+=chunk;
      const result=await connection.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});
      if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
      console.log(JSON.stringify(result.result?.value));
    }
    connection.close();
  }
}
