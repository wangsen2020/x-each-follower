import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parameters} from '../src/locales/parameters.js';
import {RUNTIME_RESOURCES} from '../tools/runtime-resources.mjs';
import {createLegacyTranslator} from '../src/shared/i18n-text.js';
const codes=['en','zh-CN','pt-BR','es-419'];
const read=path=>JSON.parse(fs.readFileSync(new URL(path,import.meta.url),'utf8'));
const catalogs=Object.fromEntries(codes.map(code=>[code,{...read(`../src/locales/full-${code}.json`),...read(`../src/locales/${code}.json`),...parameters[code],...read(`../src/locales/extra-${code}.json`)}]));
const tokens=s=>[...s.matchAll(/{{\s*(\w+)\s*}}/g)].map(m=>m[1]).sort();

test('four complete catalogs preserve every interpolation parameter',()=>{
 for(const code of codes){assert.deepEqual(Object.keys(catalogs[code]).sort(),Object.keys(catalogs['zh-CN']).sort());for(const [key,value]of Object.entries(catalogs[code])){assert.ok(value.trim(),`${code}: ${key}`);assert.deepEqual(tokens(value),tokens(catalogs['zh-CN'][key]),`${code}: ${key}`);}}
});
test('Chrome catalogs include UI messages and are loaded before classic content scripts',()=>{
 let keys;
 for(const code of ['en','zh_CN','pt_BR','es_419']){const path=`_locales/${code}/messages.json`;assert.equal(RUNTIME_RESOURCES[path],`src/${path}`);const catalog=read(`../src/${path}`);for(const key of ['extName','extDesc','extAction'])assert.ok(catalog[key]);assert.ok([...catalog.extDesc.message].length<=132);const current=Object.keys(catalog).sort();if(keys)assert.deepEqual(current,keys);keys=current;assert.ok(keys.length>3000);}
 const manifest=read('../src/manifest.json');assert.equal(manifest.default_locale,'en');assert.equal(manifest.content_scripts[0].js[0],'i18n-content.js');
});
test('browser language wins over old local preferences, with English fallback',async()=>{
 let browser='pt-BR';globalThis.chrome={i18n:{getUILanguage:()=>browser}};
 globalThis.localStorage={getItem:()=>{throw Error('must not read old preference');},setItem:()=>{throw Error('must not persist a UI override');}};
 const {t,locale,refreshBrowserLanguage,resolveLanguage}=await import('../src/shared/i18n.js');
 for(const [input,expected]of [['es-MX','es-419'],['pt_PT','pt-BR'],['zh_CN','zh-CN'],['fr-FR','en']])assert.equal(resolveLanguage(input),expected);
 assert.equal(locale.value,'pt-BR');assert.match(t('verifiedSession',{session:'<原文 & session>'}),/<原文 & session>/);
 assert.equal(t(24),24);assert.equal(t('Unknown user content'),'Unknown user content');
 browser='en-US';refreshBrowserLanguage();assert.equal(locale.value,'en');assert.equal(t('pageSummary',{page:2,total:30}),'Page 2 · 30 records');
 browser='zh-CN';refreshBrowserLanguage();assert.equal(t('关闭'),'关闭');browser='fr-FR';refreshBrowserLanguage();assert.equal(locale.value,'en');
 delete globalThis.chrome;delete globalThis.localStorage;
});
test('legacy display matching preserves complete sentences and punctuation',()=>{
 const translate=createLegacyTranslator(['已读取 {{count}} 条（{{state}}）','完成'],(key,values)=>key==='完成'?'Done':`Read ${values.count} (${values.state})`).translate;
 assert.equal(translate('已读取 12 条（完成）'),'Read 12 (Done)');assert.equal(translate('User-authored original'),'User-authored original');assert.equal(translate(null),null);
});
test('AI instructions and authored content remain raw display values',()=>{
 const source=fs.readFileSync(new URL('../src/entries/tutorial/grok-bot-guide.js',import.meta.url),'utf8');assert.ok(!source.includes('t(buildGrokBotInstruction'));
 const wisdom=fs.readFileSync(new URL('../src/entries/panel/components/KnowledgeWisdomPanel.vue',import.meta.url),'utf8');assert.ok(wisdom.includes('{{ draft.content }}'));assert.ok(wisdom.includes('{{ item.statement }}'));
 const logs=fs.readFileSync(new URL('../src/entries/panel/components/ExecutionLogsModal.vue',import.meta.url),'utf8');assert.ok(logs.includes('value ?? t("未记录")'));assert.ok(!fs.existsSync(new URL('../src/entries/panel/components/LanguageSelect.vue',import.meta.url)));
});

test('translation never becomes part of a legacy UI control condition', async()=>{
 const {parse}=await import('@babel/parser');
 const source=fs.readFileSync(new URL('../src/entries/panel/panel.js',import.meta.url),'utf8');
 const ast=parse(source,{sourceType:'module'});
 function visit(node){if(!node||typeof node!=='object')return;if(node.type==='ConditionalExpression')assert.ok(!/\bt\(/.test(source.slice(node.test.start,node.test.end)),'translation must not change a condition');for(const[key,value]of Object.entries(node))if(!['loc','comments','tokens'].includes(key)){if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}}visit(ast);
 const feed=fs.readFileSync(new URL('../src/entries/panel/pages/MutualCommentsSection.vue',import.meta.url),'utf8');assert.ok(feed.includes(`row.reply || t(row.error) || (row.tag==='mutual'?`));
});

test('profile bios and named AI sessions are not translated as UI labels',()=>{
 const panel=fs.readFileSync(new URL('../src/entries/panel/panel.js',import.meta.url),'utf8');
 for(const expression of ['t(cleanFollowerBio(', 't(displayBio)', 't(`「${commentText}」`)'])assert.ok(!panel.includes(expression));
 const sessions=fs.readFileSync(new URL('../src/entries/panel/components/GrokLocalSettings.vue',import.meta.url),'utf8');assert.ok(sessions.includes('item.name?.trim() ? sessionLabel(item.name,item.id)'));
 const badge=fs.readFileSync(new URL('../src/entries/content/profile-followback-badge.js',import.meta.url),'utf8');assert.ok(badge.includes('const title = t(describe('));assert.ok(badge.includes('if (badge.title !== title)'));assert.ok(badge.includes('api.destroy(); return;'));
});
