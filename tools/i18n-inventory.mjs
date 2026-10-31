import fs from 'node:fs';
import path from 'node:path';
import {parse} from '@babel/parser';
import {parse as parseSfc} from '@vue/compiler-sfc';
import {parse as parseHtml} from '@vue/compiler-dom';
const chinese=s=>/[\u3400-\u9fff]/.test(s);
const messages={},sources={};
const existing=JSON.parse(fs.readFileSync('src/locales/zh-CN.json','utf8'));
function add(text,file){if(!chinese(text)||text.length>1800||/<(?:svg|path|div|span|button|input|style|script)\b/i.test(text))return;messages[text]=text;(sources[text]??=[]).push(file);}
function walk(n,fn){if(!n||typeof n!=='object')return;fn(n);for(const [k,v]of Object.entries(n))if(!['loc','comments','tokens'].includes(k)){if(Array.isArray(v))v.forEach(x=>walk(x,fn));else if(v&&typeof v==='object')walk(v,fn);}}
function js(source,file){try{walk(parse(source,{sourceType:'unambiguous'}),n=>{if(n.type==='StringLiteral')add(n.value,file);if(n.type==='TemplateLiteral')add(n.quasis.map((q,i)=>q.value.cooked+(i<n.expressions.length?`{{v${i}}}`:'')).join(''),file);});}catch(e){console.log(file,e.message);}}
function html(source,file){try{const ast=parseHtml(source);function visit(n){if(n.type===2)add(n.content.trim(),file);for(const p of n.props||[])if(p.type===6&&p.value)add(p.value.content,file);else if(p.type===7&&p.exp)js(p.exp.content,file);if(n.type===5)js(n.content.content,file);for(const c of n.children||[])if(c.tag!=='script'&&c.tag!=='style'&&c.tag!=='code'&&c.tag!=='pre')visit(c);}visit(ast);}catch(e){console.log(file,e.message);}}
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);}
for(const file of files('src')){if(/[/\\](locales|_locales|vendor|assets)[/\\]/.test(file))continue;if(/(prompt|scoring|page-reader|network-api|reply-page|original-page|publication-writer)/.test(file))continue;const source=fs.readFileSync(file,'utf8');if(file.endsWith('.js'))js(source,file);if(file.endsWith('.vue')){const {descriptor:d}=parseSfc(source);if(d.template)html(d.template.content,file);if(d.scriptSetup)js(d.scriptSetup.content,file);if(d.script)js(d.script.content,file);}if(file.endsWith('.html'))html(source,file);}
const extra=Object.fromEntries(Object.entries(messages).filter(([key])=>!Object.hasOwn(existing,key)));
fs.mkdirSync('artifacts/i18n',{recursive:true});fs.writeFileSync('artifacts/i18n/inventory.json',JSON.stringify(extra,null,2));fs.writeFileSync('artifacts/i18n/sources.json',JSON.stringify(sources,null,2));console.log(`${Object.keys(extra).length} additional messages`);
