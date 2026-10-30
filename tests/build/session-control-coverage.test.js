import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from '@vue/compiler-sfc';
import {parse as parseTemplate} from '@vue/compiler-dom';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
for(const [file,model] of [['src/entries/panel/pages/MutualCommentsSection.vue',"draft[phase.key+'BotId']"],['src/entries/panel/components/KnowledgeLearningPanel.vue','draft.bot']])test(file+' session menu participates in shared bounded menu rules',()=>{
 const {descriptor}=parse(read(file));const nodes=[];function visit(n){if(n.type===1&&n.tag==='PanelSelect')nodes.push(n);for(const c of n.children||[])visit(c);}visit(parseTemplate(descriptor.template.content));const control=nodes.find(n=>n.props.some(p=>p.name==='model'&&p.exp?.content===model));assert.ok(control);assert.ok(control.props.some(p=>p.name==='class'&&p.value.content.includes('ai-session-select')));assert.ok(control.props.some(p=>p.name==='bind'&&p.arg?.content==='title'));
 const css=read('src/entries/panel/styles/select-control.css');assert.match(css,/.ai-session-select/);assert.match(css,/align-items:center/);assert.match(css,/max-height:320px/);
});
