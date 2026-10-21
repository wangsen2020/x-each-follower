import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../src/entries/main-world/net-hook.js',import.meta.url),'utf8');
function fixture(response){
 class XHR {open(){}send(){}setRequestHeader(){}}
 const messages=[];
 const window={fetch:async()=>response,postMessage:value=>messages.push(value)};
 vm.runInNewContext(source,{window,XMLHttpRequest:XHR,crypto,TextDecoder,URL,location:{origin:'https://x.com'}});
 return {window,messages};
}
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setImmediate(resolve));}assert.fail('stream observation did not settle');}

test('Grok fetch observer tracks chunks and EOF without consuming the application response',async()=>{
 let controller;const response=new Response(new ReadableStream({start(c){controller=c;}}));
 const f=fixture(response);
 const app=await f.window.fetch('https://x.com/i/api/2/grok/add_response.json',{body:JSON.stringify({message:'独立任务 任务编号stream123',authorization:'must-not-be-recorded'})});
 assert.equal(app,response);assert.equal(f.window.__xefGrokStream.nonce,'任务编号stream123');
 const appText=app.text();
 controller.enqueue(new TextEncoder().encode('{"result":{"messageTag":"final","message":"完整回答"}}\n'));
 await until(()=>f.window.__xefGrokStream.chunks===1);
 assert.equal(f.window.__xefGrokStream.status,'streaming');
 assert.equal(f.window.__xefGrokStream.endedAt,0);
 controller.close();
 assert.match(await appText,/完整回答/);
 await until(()=>f.window.__xefGrokStream.status==='complete');
 assert.ok(f.window.__xefGrokStream.endedAt>0);
 assert.equal(JSON.stringify(f.window.__xefGrokStream).includes('must-not-be-recorded'),false);
 assert.equal(f.messages.at(-1).payload.text,'完整回答');
});

test('Grok network errors and unsuccessful HTTP responses never count as EOF success',async()=>{
 let controller;const f=fixture(new Response(new ReadableStream({start(c){controller=c;}})));
 await f.window.fetch('https://x.com/i/api/2/grok/add_response.json',{body:'{"message":"任务编号error123"}'});
 controller.error(new Error('stream interrupted'));
 await until(()=>f.window.__xefGrokStream.status==='error');
 assert.match(f.window.__xefGrokStream.error,/interrupted/);
 const bad=fixture(new Response('unavailable',{status:503}));
 await bad.window.fetch('https://x.com/i/api/2/grok/add_response.json',{body:'{"message":"任务编号http123"}'});
 await until(()=>bad.window.__xefGrokStream.endedAt>0);
 assert.equal(bad.window.__xefGrokStream.status,'http-error');
});

function socketFixture(){
 class XHR {open(){}send(){}setRequestHeader(){}}
 class Socket extends EventTarget {send(data){this.lastSent=data;}receive(event){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({event})}));}}
 const window={WebSocket:Socket,postMessage:()=>{}};
 vm.runInNewContext(source,{window,XMLHttpRequest:XHR,crypto,TextDecoder,URL,location:{origin:'https://x.com'}});
 return {window,socket:new window.WebSocket(),Socket:window.WebSocket};
}

test('WebSocket completion is correlated to request and response IDs; heartbeats and other responses cannot complete it',()=>{
 const {window,socket}=socketFixture();
 const payload=JSON.stringify({event:{type:'response.create',event_id:'request-1',item:{text:'任务编号ws123'}}});
 socket.send(payload);assert.equal(socket.lastSent,payload);
 const state=window.__xefGrokStream;assert.equal(state.nonce,'任务编号ws123');assert.equal(state.transport,'websocket');
 socket.receive({type:'pong'});assert.equal(state.chunks,0);
 socket.receive({type:'response.created',client_event_id:'other-request',response:{id:'other-response'}});
 assert.equal(state.responseId,'');
 socket.receive({type:'response.created',client_event_id:'request-1',response:{id:'response-1'}});
 socket.receive({type:'response.chunk',response_id:'response-1'});assert.equal(state.chunks,1);
 socket.receive({type:'response.done',response:{id:'other-response',status:'completed'}});assert.equal(state.status,'streaming');
 socket.receive({type:'response.output_text.done',response_id:'response-1'});assert.equal(state.status,'streaming');
 socket.receive({type:'response.done',response:{id:'response-1',status:'completed'}});
 assert.equal(state.status,'complete');assert.equal(state.terminalEvent,'response.done');
 socket.dispatchEvent(new Event('close'));assert.equal(state.status,'complete');
});

test('cancelled WebSocket replies and disconnected sockets do not count as completed answers',()=>{
 const {window,socket}=socketFixture();
 socket.send(JSON.stringify({event:{type:'response.create',event_id:'r1',item:{text:'任务编号wsFail'}}}));
 socket.receive({type:'response.created',client_event_id:'r1',response:{id:'response-fail'}});
 socket.receive({type:'response.done',response:{id:'response-fail',status:'cancelled'}});
 assert.equal(window.__xefGrokStream.status,'error');
 socket.send(JSON.stringify({event:{type:'response.create',event_id:'r2',item:{text:'任务编号wsClosed'}}}));
 socket.receive({type:'response.done',response:{id:'response-fail',status:'completed'}});
 assert.equal(window.__xefGrokStream.status,'pending');
 socket.dispatchEvent(new Event('close'));assert.equal(window.__xefGrokStream.status,'reconnecting');
});

test('WebSocket response IDs survive reconnection and a stale socket close cannot invalidate a completed response',()=>{
 const {window,socket,Socket}=socketFixture();
 socket.send(JSON.stringify({event:{type:'response.create',event_id:'resume-r',item:{text:'任务编号resume123'}}}));
 socket.receive({type:'response.created',client_event_id:'resume-r',response:{id:'resume-response'}});
 socket.dispatchEvent(new Event('close'));
 assert.equal(window.__xefGrokStream.status,'reconnecting');
 const next=new Socket();
 next.receive({type:'response.chunk',response_id:'resume-response'});
 assert.equal(window.__xefGrokStream.status,'streaming');
 next.receive({type:'response.done',response:{id:'resume-response',status:'completed'}});
 assert.equal(window.__xefGrokStream.status,'complete');
 socket.dispatchEvent(new Event('close'));assert.equal(window.__xefGrokStream.status,'complete');
});
