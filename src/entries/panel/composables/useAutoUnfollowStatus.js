import {ref, computed} from 'vue';
import {autoUnfollowView, autoUnfollowRowView} from '../../../features/relationships/auto-unfollow-view.js';
import {normalizeUnreciprocatedConfig} from './useUnreciprocatedSettings.js';

const snapshot = ref({config:{},ledger:{},alarm:null,now:Date.now()});
const error = ref('');
const view = computed(()=>autoUnfollowView(snapshot.value.config,snapshot.value.ledger,snapshot.value.alarm,snapshot.value.now));
let sequence=0;
const rowUsers=new WeakMap();
export function paintAutoUnfollowRow(node,user) {
  rowUsers.set(node,user);
  node.dataset.unfollowHandle=user.handle||'';
  node.dataset.unfollowId=String(user.id||'');
  const status=autoUnfollowRowView(user,view.value);
  node.textContent=status.label;
  node.title=status.tip;
  node.setAttribute('data-tip',status.tip);
  node.hidden=!status.label;
}
async function refresh() {
  const token=++sequence;
  try {
    const [data,alarm]=await Promise.all([chrome.storage.local.get(['autoUnfollowState','unreciprocatedSettings']),chrome.alarms.get('x-auto-unfollow')]);
    if(token!==sequence)return;
    snapshot.value={config:normalizeUnreciprocatedConfig(data.unreciprocatedSettings),ledger:data.autoUnfollowState||{},alarm,now:Date.now()};error.value='';
    for(const node of document.querySelectorAll('[data-unfollow-handle]'))paintAutoUnfollowRow(node,rowUsers.get(node)||{handle:node.dataset.unfollowHandle,id:node.dataset.unfollowId});
  } catch(failure){if(token===sequence)error.value=`调度状态读取失败：${failure.message}`;}
}
function start() {
  const listener=(changes,area)=>{if(area==='local' && (changes.autoUnfollowState||changes.unreciprocatedSettings))void refresh();};
  chrome.storage.onChanged.addListener(listener);
  const timer=setInterval(refresh,15000);
  void refresh();
  return ()=>{chrome.storage.onChanged.removeListener(listener);clearInterval(timer);sequence++;};
}
export const autoUnfollowStatusController={view,error,refresh,start};
