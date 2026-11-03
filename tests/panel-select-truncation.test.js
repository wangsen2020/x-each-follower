import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {h} from 'vue';
const source=readFileSync(new URL('../src/entries/panel/components/PanelSelect.vue',import.meta.url),'utf8');
const component=Function('h',source.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/import .*?;\s*/, '').replace('export default','return'))(h);
test('truncated session select keeps the full option/title and emits its original ID',()=>{
 const events=[],title='Antigravity · Product conversations — a long session title';
 const render=component.setup({modelValue:'session-1',modelModifiers:{},truncateSelection:true},{attrs:{title},emit:(...event)=>events.push(event),slots:{default:()=>[h('option',{value:'session-1'},title)]}});
 const vnode=render();assert.equal(vnode.props.title,title);assert.equal(vnode.children[0].type,'button');assert.equal(vnode.children[0].children[0].type,'selectedcontent');assert.equal(vnode.children[1].children,title);
 vnode.props.onChange[0]({target:{selectedOptions:[{_value:'session-2'}]}});assert.deepEqual(events,[['update:modelValue','session-2']]);
});
test('other native selects retain option-only markup and numeric model values',()=>{
 const events=[];const render=component.setup({modelValue:10,modelModifiers:{number:true},truncateSelection:false},{attrs:{},emit:(...args)=>events.push(args),slots:{default:()=>[h('option',{value:10},'10')]}});
 const vnode=render();assert.equal(vnode.children.length,1);assert.equal(vnode.children[0].type,'option');assert.equal(vnode.props['data-truncate-selection'],undefined);
 vnode.props.onChange[0]({target:{value:'20',selectedOptions:[{}]}});assert.deepEqual(events,[['update:modelValue',20]]);
});
