import {createProfileTab} from './profile-access.js';
import {createXNetworkClient} from './network-client.js';
import {parseNetworkUsers} from '../../features/relationships/network-api.js';

// Serialized into the isolated world. Never inspect recommendation or tweet buttons.
export function profileRelationshipOnPage(handle, id, owner, action = 'read') {
  const key = String(handle).toLowerCase();
  if (location.pathname.toLowerCase().replace(/\/$/, '') !== '/' + key) return {ready:false};
  const viewer = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.replaceAll('/', '').toLowerCase();
  if (viewer !== String(owner).toLowerCase()) return {ready:false,reason:'登录账号不一致'};
  const root = document.querySelector('[data-testid="primaryColumn"]');
  const header = root?.querySelector('[data-testid="UserName"]');
  if (!header || !header.innerText.toLowerCase().split(/\s+/).includes('@' + key)) return {ready:false};
  const buttons = [...root.querySelectorAll('button')].filter(e => !e.closest('article,[data-testid="UserCell"]'));
  const actionState = element => {
    const text = String(element.innerText || '').trim();
    const label = String(element.getAttribute('aria-label') || '').trim();
    const testId = element.getAttribute('data-testid');
    // Creator Subscribe buttons can reuse the exact userId-unfollow test ID.
    // An ID alone is never sufficient evidence or permission to click.
    if (/订阅|訂閱|subscribe|subscription|購読/i.test(text + ' ' + label)) return null;
    if (/^\d+-(?:unfollow|follow)$/.test(testId || '') && testId !== id + '-unfollow' && testId !== id + '-follow') return null;
    const named = label.match(/^(取消关注|取消關注|Unfollow|正在关注|正在關注|Following|关注|關注|Follow|回关|回關|Follow back)\s+@([a-z0-9_]{1,15})$/i);
    if (named) {
      if (named[2].toLowerCase() !== key) return null;
      return /^(取消关注|取消關注|Unfollow|正在关注|正在關注|Following)$/i.test(named[1]);
    }
    if (testId === id + '-unfollow' && /^(正在关注|正在關注|Following|取消关注|取消關注|Unfollow)$/i.test(text)) return true;
    if (testId === id + '-follow' && /^(关注|關注|Follow|回关|回關|Follow back)$/i.test(text)) return false;
    return null;
  };
  const button = buttons.find(e => actionState(e) !== null);
  if (!button) return {ready:false,reason:'无法确认目标账号关注操作入口，已排除订阅按钮',code:'X_PROFILE_ACTION_UNAVAILABLE'};
  const following = actionState(button);
  const followedBy = /关注了你|關注了你|follows you/i.test(header.innerText) || /^(回关|follow back)$/i.test(button.innerText.trim());
  const evidence = {ready:true,following,followedBy,handle:key,id:String(id)};
  if (action === 'read') return evidence;
  if (action === 'followback') {
    if (!followedBy || following || !/^(回关|follow back)$/i.test(button.innerText.trim())) return {...evidence,clicked:false};
    button.click(); return {...evidence,clicked:true};
  }
  if (followedBy || !following) return {...evidence,clicked:false};
  if (action === 'unfollow') {
    if (document.querySelector('[role="dialog"],[role="alertdialog"],[data-testid="confirmationSheetDialog"]')) return {...evidence,clicked:false};
    button.click(); return {...evidence,clicked:true};
  }
  if (action === 'confirm') {
    const confirm = document.querySelector('[data-testid="confirmationSheetConfirm"]');
    const dialog = confirm?.closest('[data-testid="confirmationSheetDialog"],[role="alertdialog"],[role="dialog"]');
    if (confirm) {
      if (!dialog || !new RegExp('@' + key + '(?![a-z0-9_])', 'i').test(dialog.innerText)) return {...evidence,clicked:false,reason:'取关确认弹窗与目标账号不匹配'};
      confirm.click(); return {...evidence,clicked:true};
    }
    // Compact profile actions use a menu whose exact Unfollow item may submit
    // immediately. The caller reserves pending/attempted BEFORE this step.
    if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return {...evidence,clicked:false,reason:'存在其他弹窗，未操作'};
    const item = [...(document.querySelectorAll?.('[role="menuitem"]') || [])].find(e => {
      const match = String(e.innerText || '').trim().match(/^(取消关注|取消關注|Unfollow)\s+@([a-z0-9_]{1,15})$/i);
      return match && match[2].toLowerCase() === key;
    });
    if (!item) return {...evidence,clicked:false,reason:'未找到目标账号的取关确认入口'};
    item.click(); return {...evidence,clicked:true};
  }
  return {...evidence,clicked:false};
}

export function mergeVerifiedRelationship(apiRelationship, page) {
  if (!page?.ready) return {following:null,followedBy:null};
  return {
    following: typeof apiRelationship?.following === 'boolean' && apiRelationship.following === page.following ? page.following : null,
    followedBy: page.followedBy || apiRelationship?.followedBy === true ? true : apiRelationship?.followedBy === false ? false : null
  };
}

export function profileReadinessError(page) {
  return Object.assign(new Error(page?.reason || '主页关系信息未就绪，禁止操作'), {
    code: page?.reason === '登录账号不一致' ? 'X_PROFILE_OWNER_MISMATCH' : page?.code || 'X_PROFILE_IDENTITY_UNRESOLVED'
  });
}

export async function inspectOrActOnProfile(api, user, owner, action = 'read', {sleep = ms => new Promise(r => setTimeout(r, ms)), canAct = async () => true, beforeSubmit = async () => {}, timeoutMs = 60000} = {}) {
  const tab = await createProfileTab(api,{url:'https://x.com/' + user.handle,active:false},'relationship-preflight');
  let attempted = false, expired = false, timer;
  const timeoutError=()=>Object.assign(new Error('主页操作等待超时，已关闭本轮临时页面'),{code:'X_PROFILE_ACTION_UNAVAILABLE'});
  const assertActive=()=>{if(expired)throw timeoutError();};
  const readPage = async step => {
    assertActive();
    const result=(await api.scripting.executeScript({target:{tabId:tab.id},func:profileRelationshipOnPage,args:[user.handle,String(user.id),owner,step]}))[0]?.result;
    assertActive();return result;
  };
  const fresh = async () => {
    const response = await createXNetworkClient(api).profile(tab.id,user.handle);
    if(response.status !== 200) throw Object.assign(new Error('关系核验接口未成功，停止操作'),{code:'PROFILE_HTTP_ERROR',status:response.status});
    const target = parseNetworkUsers(response.json).find(e => e.handle.toLowerCase() === user.handle.toLowerCase());
    if(!target || String(target.id) !== String(user.id)) throw Object.assign(new Error('目标身份不一致，停止操作'),{code:'AUTO_UNFOLLOW_TARGET_MISMATCH'});
    const page = await readPage('read');
    return {...target,relationship:mergeVerifiedRelationship(target.relationship,page),evidence:{page,api:target.relationship}};
  };
  const inspect=async()=>{try {
    let page;
    for(let i=0;i<30;i++){page=await readPage('read');if(page?.ready)break;await sleep(500);}
    if(!page?.ready) throw profileReadinessError(page);
    const live=await fresh();
    if(action==='read')return live;
    const valid = action==='followback' ? live.relationship.followedBy===true && live.relationship.following===false : live.relationship.followedBy===false && live.relationship.following===true;
    if(!valid)return {status:409,attempted:false,live,error:'关注关系已变化或不明确，未执行操作'};
    if(!await canAct())return {status:409,attempted:false,error:'设置或保护条件已变化，未操作'};
    // A lost scripting response after a follow click is ambiguous, never retry blindly.
    if(action==='followback')attempted=true;
    const click=await readPage(action);
    if(!click?.clicked)return {status:409,attempted:false,live:await fresh(),error:'页面关系已变化，未执行操作'};
    if(action==='unfollow'){
      await sleep(400);
      // Recheck the API and the profile immediately before the confirmation click.
      const check=await fresh();
      if(check.relationship.followedBy!==false || check.relationship.following!==true)return {status:409,attempted:false,live:check,error:'打开确认前后主页关系变化或无法核实，未提交取关'};
      if(!await canAct())return {status:409,attempted:false,error:'设置或保护条件已变化，未操作'};
      await beforeSubmit();assertActive();
      attempted=true;
      if(!(await readPage('confirm'))?.clicked)return {status:409,attempted:false,live:await fresh(),error:'取关确认未通过'};
    }else attempted=true;
    for(let i=0;i<6;i++){
      await sleep(500);const verified=await fresh();
      if(action==='followback' ? verified.relationship.following===true && verified.relationship.followedBy===true : verified.relationship.following===false)return {status:200,attempted:true,live:verified};
    }
    return {status:0,attempted:true,error:'操作结果待确认，禁止重复操作'};
  }catch(error){if(action==='read')throw error;return {status:0,attempted,error:error.message};}
  finally{await api.tabs.remove(tab.id).catch(()=>{});}};
  const deadline=new Promise((resolve,reject)=>{timer=setTimeout(async()=>{
    expired=true;
    // Cancel queued page scripts by closing only this operation's owned tab.
    // Late read responses cannot advance to a click after assertActive fails.
    await api.tabs.remove(tab.id).catch(()=>{});
    if(action==='read')reject(timeoutError());
    else resolve({status:0,attempted,error:timeoutError().message});
  },timeoutMs);});
  try{return await Promise.race([inspect(),deadline]);}finally{clearTimeout(timer);}
}
