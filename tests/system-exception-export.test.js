import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

test('exception JSON download remains readable through a delayed browser save, then releases its Blob', async () => {
  const component=readFileSync(new URL('../src/entries/panel/components/SystemExceptionLogs.vue',import.meta.url),'utf8');
  const download=component.match(/function download\(\)\{[^\n]+\}/)?.[0];
  assert.ok(download);
  const urls=new Map(),tasks=[],saved=[];let clock=0;
  const schedule=(run,delay)=>tasks.push({run,at:clock+delay});
  const entries=[{message:'selected error',source:'panel'}];
  const context=vm.createContext({Blob,Date,notice:{value:''},output:()=>JSON.stringify({entries}),
    URL:{createObjectURL:blob=>{urls.set('blob:export',blob);return 'blob:export';},revokeObjectURL:url=>urls.delete(url)},
    setTimeout:schedule,
    document:{createElement:()=>({href:'',download:'',click(){const href=this.href;schedule(()=>{const blob=urls.get(href);if(blob)saved.push(blob);},1500);}})}
  });
  vm.runInContext(download+';download();',context);
  async function advance(to){while(tasks.some(t=>t.at<=to)){tasks.sort((a,b)=>a.at-b.at);const next=tasks.shift();clock=next.at;await next.run();}clock=to;}
  await advance(2000);
  assert.equal(saved.length,1,'Chrome must still be able to read the download after its save delay');
  assert.deepEqual(JSON.parse(await saved[0].text()).entries,entries);
  assert.match(context.notice.value,/已开始下载/);
  await advance(300000);assert.equal(urls.size,0,'completed download URLs must eventually be released');
});
