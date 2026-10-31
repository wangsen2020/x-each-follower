// Display-only adapter for legacy modules that return fully formatted messages.
// Domain values and saved records are never passed back through this adapter.
export function messageId(source){let hash=2166136261;for(let i=0;i<source.length;i++){hash^=source.charCodeAt(i);hash=Math.imul(hash,16777619);}return 'ui_'+(hash>>>0).toString(16);}
export function createLegacyTranslator(keys, lookup){
  const exact=new Set(keys),cache=new Map(),groups=new Map();
  const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const patterns=keys.filter(key=>/\{\{\w+\}\}/.test(key)&&/[\u3400-\u9fff]/.test(key.replace(/\{\{\w+\}\}/g,''))).map(key=>{
    const names=[];let expression='',last=0;for(const match of key.matchAll(/\{\{(\w+)\}\}/g)){expression+=escape(key.slice(last,match.index))+'([\\s\\S]*?)';names.push(match[1]);last=match.index+match[0].length;}expression+=escape(key.slice(last));
    return {key,names,pattern:new RegExp('^'+expression+'$'),prefix:key.split('{{')[0],weight:key.replace(/\{\{\w+\}\}/g,'').length};
  }).sort((a,b)=>b.weight-a.weight);
  for(const p of patterns){const bucket=p.prefix[0]||'*';if(!groups.has(bucket))groups.set(bucket,[]);groups.get(bucket).push(p);}
  function translate(text,depth=0){
    if(typeof text!=='string'||!text)return text;
    if(exact.has(text))return lookup(text,{});
    if(!/[\u3400-\u9fff]/.test(text))return text;
    if(cache.has(text))return cache.get(text);
    for(const p of [...groups.get(text[0])||[],...groups.get('*')||[]]){if(p.prefix&&!text.startsWith(p.prefix))continue;const match=p.pattern.exec(text);if(!match)continue;const values=Object.fromEntries(p.names.map((name,i)=>[name,depth<2?translate(match[i+1],depth+1):match[i+1]]));const value=lookup(p.key,values);if(cache.size>2000)cache.clear();cache.set(text,value);return value;}
    return text;
  }
  return {translate,clear:()=>cache.clear()};
}
