import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('knowledge settings drawer opens while session discovery is still pending',async()=>{
 let opened=0,resolveSessions,exposed;
 const sessions=new Promise(resolve=>{resolveSessions=resolve;});
 const config={ownerId:'123',generationProvider:'codex',bot:'saved-session',enabled:false};
 const scope=vm.createContext({defineProps:()=>({ownerId:'123'}),defineEmits:()=>()=>{},defineExpose:value=>{exposed=value;},ref:value=>({value}),reactive:value=>value,computed:fn=>({get value(){return fn();}}),watch(){},onBeforeUnmount(){},setInterval:()=>0,clearInterval(){},getLocalAiService:()=>({status:async()=>({enabled:true}),configuration:async()=>({testedAt:1}),list:()=>sessions}),LOCAL_AI_ENGINES:[],chrome:{runtime:{sendMessage:async()=>({ok:true,config,runs:[]})}}});
 const source=fs.readFileSync(new URL('../src/entries/panel/components/KnowledgeLearningPanel.vue',import.meta.url),'utf8').split('<script setup>')[1].split('</script>')[0].replace(/^import .*;\r?\n/gm,'');
 vm.runInContext(source,scope);scope.recordOpen=()=>{opened++;};vm.runInContext('drawer.value={open:recordOpen}',scope);
 const opening=exposed.open();for(let i=0;i<12;i++)await Promise.resolve();assert.equal(opened,1,'a slow AI session request must not delay the drawer');resolveSessions([]);await opening;
});
