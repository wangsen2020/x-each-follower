import i18next from 'i18next';
import {ref,watchEffect} from 'vue';
import {parameters} from '../locales/parameters.js';
import {createLegacyTranslator} from './i18n-text.js';
import en from '../locales/en.json' with {type:'json'};
import zh from '../locales/zh-CN.json' with {type:'json'};
import pt from '../locales/pt-BR.json' with {type:'json'};
import es from '../locales/es-419.json' with {type:'json'};
import fullEn from '../locales/full-en.json' with {type:'json'};
import fullZh from '../locales/full-zh-CN.json' with {type:'json'};
import fullPt from '../locales/full-pt-BR.json' with {type:'json'};
import fullEs from '../locales/full-es-419.json' with {type:'json'};
import extraEn from '../locales/extra-en.json' with {type:'json'};
import extraZh from '../locales/extra-zh-CN.json' with {type:'json'};
import extraPt from '../locales/extra-pt-BR.json' with {type:'json'};
import extraEs from '../locales/extra-es-419.json' with {type:'json'};
export function resolveLanguage(value){
  const language=String(value||'').replaceAll('_','-').toLowerCase();
  if(/^zh(?:-|$)/.test(language))return 'zh-CN';
  if(/^pt(?:-|$)/.test(language))return 'pt-BR';
  if(/^es(?:-|$)/.test(language))return 'es-419';
  return 'en';
}
export function browserLanguage(){return resolveLanguage(globalThis.chrome?.i18n?.getUILanguage?.()||globalThis.navigator?.language);}
export const locale=ref(browserLanguage());
const resources={en:{...fullEn,...en,...parameters.en,...extraEn},'zh-CN':{...fullZh,...zh,...parameters['zh-CN'],...extraZh},'pt-BR':{...fullPt,...pt,...parameters['pt-BR'],...extraPt},'es-419':{...fullEs,...es,...parameters['es-419'],...extraEs}};
const engine=i18next.createInstance();
engine.init({lng:locale.value,fallbackLng:'en',initAsync:false,keySeparator:false,nsSeparator:false,resources:Object.fromEntries(Object.entries(resources).map(([key,translation])=>[key,{translation}])),interpolation:{escapeValue:false},returnNull:false});
const lookup=(source,values)=>engine.t(source,{...values,lng:locale.value,defaultValue:source});
const legacy=createLegacyTranslator(Object.keys(resources['zh-CN']),lookup);
export function t(source,values){
  if(typeof source!=='string'||!source)return source;
  // Track locale in render effects; never change underlying data or inputs.
  const language=locale.value;
  if(values||Object.hasOwn(resources['zh-CN'],source))return lookup(source,values);
  if(language==='zh-CN')return source;
  return source.includes('\n') ? source.split('\n').map(line=>legacy.translate(line)).join('\n') : legacy.translate(source);
}
export function refreshBrowserLanguage(){locale.value=browserLanguage();legacy.clear();}
globalThis.addEventListener?.('languagechange',refreshBrowserLanguage);
watchEffect(()=>{if(globalThis.document){document.documentElement.lang=locale.value;document.documentElement.dir='ltr';if(globalThis.location?.pathname.endsWith('/panel.html'))document.title=`XFollower · ${t('粉丝跟进')}`;}});
