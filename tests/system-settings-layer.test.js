import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/entries/panel/components/SystemSettingsDialog.vue',import.meta.url),'utf8');
function fixture(){
 const opener={focused:0,focus(){this.focused++;}};
 const dialog={open:false,shown:0,close(){this.open=false;},showModal(){this.open=true;this.shown++;},querySelector:()=>({focus(){}})};
 const state={document:{activeElement:opener},opener:null,isOpen:{value:false},message:{value:''},error:{value:''},drawer:{value:dialog},nextTick:async()=>{},refresh:async()=>{},loadSettings:async()=>{},grokProviderController:{cancel(){}},generation:0,historyGeneration:0,timer:null,clearTimeout};
 vm.createContext(state);vm.runInContext(source.match(/async function open\(\)[^\r\n]*/)[0]+source.match(/function close\(\)[^\r\n]*/)[0],state);return {state,dialog,opener};
}
test('shared system settings uses native modal top layer for both native and legacy parent drawers',()=>{
 assert.match(source,/<dialog[^>]*id="systemSettingsDrawer"[^>]*@cancel.prevent="close"/);
 assert.match(source,/@keydown\.esc\.stop\.prevent="close"/);assert.match(source,/\.system-settings::backdrop/);assert.doesNotMatch(source,/<aside[^>]*id="systemSettingsDrawer"|class="profile-drawer-mask system-settings-mask"/);
});
test('opening repeatedly uses one modal, closing restores its opener without discarding the parent',async()=>{
 const {state,dialog,opener}=fixture();await state.open();await state.open();assert.equal(dialog.shown,1);assert.equal(dialog.open,true);state.close();assert.equal(dialog.open,false);assert.equal(state.isOpen.value,false);assert.equal(opener.focused,1);
});
test('closing during nextTick cannot reopen a dismissed system dialog',async()=>{
 const {state,dialog}=fixture();let resume;state.nextTick=()=>new Promise(r=>resume=r);const task=state.open();state.close();resume();await task;assert.equal(dialog.shown,0);
});
