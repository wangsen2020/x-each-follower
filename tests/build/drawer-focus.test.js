import test from 'node:test';
import assert from 'node:assert/strict';
import {ref,nextTick} from 'vue';
import {useDrawerFocus} from '../../src/entries/panel/composables/useDrawerFocus.js';
test('drawer returns focus synchronously before hidden and cancels late opening focus',async()=>{
 const state=ref(false),doc={activeElement:null};
 const opener={isConnected:true,getClientRects:()=>[{}],focus:()=>doc.activeElement=opener};
 const close={focus:()=>doc.activeElement=close,blur:()=>doc.activeElement=null};
 const drawer={contains:node=>node===close,querySelector:()=>close};
 doc.getElementById=id=>id==='drawer'?drawer:opener;doc.activeElement=opener;
 const stop=useDrawerFocus(state,'drawer','open',doc);
 try{state.value=true;await nextTick();assert.equal(doc.activeElement,close);state.value=false;assert.equal(doc.activeElement,opener);state.value=true;state.value=false;await nextTick();assert.equal(doc.activeElement,opener);
 state.value=true;await nextTick();opener.isConnected=false;state.value=false;assert.equal(doc.activeElement,opener);
 }finally{stop();}
});
