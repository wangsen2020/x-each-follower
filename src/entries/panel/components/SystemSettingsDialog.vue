<template>
  <button id="openSystemSettings" type="button" class="local-data-entry" title="系统设置" aria-label="系统设置" data-tip="系统设置" @click="open">
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 2-1 3 2 3-2 2 1 3-2-1-3 2-2-2-3-3-1-1-3z"/><circle cx="12" cy="11" r="3"/></svg>

  </button>
  <Teleport to="body">
    <div v-if="isOpen" class="profile-drawer-mask system-settings-mask" @click="close"></div>
    <aside v-if="isOpen" id="systemSettingsDrawer" ref="drawer" class="system-settings" role="dialog" aria-modal="true" aria-labelledby="systemSettingsTitle" @keydown.esc="close" @keydown.tab="trapFocus">
      <nav class="system-settings-nav" aria-label="设置分类">
        <strong>系统设置</strong>
        <button v-for="tab in settingTabs" :key="tab.key" type="button" :class="{selected:activeSection===tab.key}" :aria-current="activeSection===tab.key?'page':undefined" @click="selectSection(tab.key)">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path :d="tab.icon"/></svg>{{ tab.label }}
        </button>
      </nav>
      <div class="system-settings-main">
      <div class="profile-drawer-head"><strong id="systemSettingsTitle">{{ settingTabs.find(tab=>tab.key===activeSection)?.label }}</strong><PanelCloseButton @click="close" /></div>
      <div class="profile-drawer-content system-settings-content">
        <GrokBotSettings v-if="activeSection==='grok-bot'" />
        <GrokLocalSettings v-if="activeSection==='grok-local'" />
        <section v-show="activeSection==='data'" aria-labelledby="localDataTitle">
          <div class="system-section-heading"><h3 id="localDataTitle">备份概览</h3><button type="button" class="secondary system-icon" title="刷新备份状态" aria-label="刷新备份状态" :disabled="loading" @click="refresh"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M19 12a7 7 0 0 0-12-5M5 12a7 7 0 0 0 12 5"/></svg></button></div>
          <div v-if="loading" class="system-state" role="status">正在读取备份状态…</div>
          <div v-if="loadError" class="system-error" role="alert">{{ loadError }}</div>
          <dl class="backup-summary" :aria-busy="loading">
            <div><dt>完整快照</dt><dd id="backupSnapshotCount">{{ status ? `${status.snapshotCount} 份` : '—' }}</dd></div>
            <div><dt>保留增量 <span class="info-tip" tabindex="0" role="note" data-tip="最早保留快照之后的变更条数，不是账号数，也不包括执行日志。" aria-label="最早保留快照之后的变更条数，不是账号数，也不包括执行日志。">?</span></dt><dd id="backupIncrementalCount">{{ status ? `${status.incrementalCount.toLocaleString()} 条` : '—' }}</dd></div>
            <div><dt>最近备份</dt><dd id="backupLastTime">{{ status ? date(status.lastBackupAt) : '—' }}</dd></div>
            <div><dt>恢复校验 <span class="info-tip" tabindex="0" role="note" data-tip="显示最近成功快照的隔离恢复校验结果，不代表此刻重新校验。" aria-label="显示最近成功快照的隔离恢复校验结果，不代表此刻重新校验。">?</span></dt><dd id="backupVerification">{{ verification }}</dd></div>
          </dl>
          <p v-if="status?.lastAttempt?.ok === false" class="system-error" role="alert">最近备份失败：{{ status.lastAttempt.error }}</p>
          <button id="createBackupNow" type="button" class="secondary" :disabled="busy || status?.running" @click="backupNow">{{ busy || status?.running ? '备份与校验中…' : '立即备份并校验' }}</button>
        </section>
        <section v-show="activeSection==='backup'" aria-labelledby="backupPolicyTitle">
          <h3 id="backupPolicyTitle">备份设置</h3>
          <label class="system-switch"><input id="backupEnabled" v-model="form.enabled" type="checkbox" :disabled="saving">自动快照 <span class="info-tip" tabindex="0" role="note" data-tip="关闭后仍保存业务变更增量，但不定期生成快照和清理旧增量；可手动备份。" aria-label="关闭后仍保存业务变更增量，但不定期生成快照和清理旧增量；可手动备份。">?</span></label>
          <div v-for="field in fields" :key="field.key" class="system-setting-row">
            <label :for="`backup-${field.key}`">{{ field.label }}</label>
            <input :id="`backup-${field.key}`" v-model.number="form[field.key]" type="number" :min="field.min" :max="field.max" :disabled="saving">
            <span class="info-tip" tabindex="0" role="note" :data-tip="field.tip" :aria-label="field.tip">?</span>
          </div>
        </section>
        <section v-show="activeSection==='versions'" aria-labelledby="versionHistoryTitle">
          <div class="system-section-heading"><h3 id="versionHistoryTitle">版本历史</h3><button type="button" class="secondary system-icon" title="刷新版本历史" aria-label="刷新版本历史" :disabled="historyLoading" @click="loadVersionHistory"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M19 12a7 7 0 0 0-12-5M5 12a7 7 0 0 0 12 5"/></svg></button></div>
          <p class="system-version-current">当前版本 <strong>v{{ APP_VERSION }}</strong></p>
          <p class="system-state">仅显示本机开始记录后的安装与升级，不推断更早的版本经历。</p>
          <p v-if="historyLoading" class="system-state" role="status">正在读取版本历史…</p>
          <p v-if="historyError" class="system-error" role="alert">{{ historyError }}</p>
          <ol v-if="versionData.versions.length" class="system-history-list">
            <li v-for="entry in versionData.versions" :key="entry.id"><strong>v{{ entry.version }}</strong><span>{{ entry.kind==='update' ? `从 v${entry.previousVersion || '未知版本'} 升级` : '安装或首次记录' }}</span><time :datetime="entry.at">{{ formatTime(entry.at) }}</time></li>
          </ol>
          <p v-else-if="!historyLoading && !historyError" class="system-state">尚无本机安装或升级记录。</p>
        </section>
        <section v-show="activeSection==='upgrades'" aria-labelledby="upgradeLogTitle">
          <div class="system-section-heading"><h3 id="upgradeLogTitle">升级详细日志</h3><button type="button" class="secondary system-icon" title="刷新升级日志" aria-label="刷新升级日志" :disabled="historyLoading" @click="loadVersionHistory"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M19 12a7 7 0 0 0-12-5M5 12a7 7 0 0 0 12 5"/></svg></button></div>
          <p class="system-state">记录版本变更及本地数据迁移的启动、完成或失败；最近保留 200 条。</p>
          <p v-if="migrationStatus" class="system-version-current">当前数据状态：{{ migrationStatus.stage==='ready' ? '已就绪' : migrationStatus.stage }}<span v-if="migrationStatus.total"> · {{ migrationStatus.completed }}/{{ migrationStatus.total }} 条</span></p>
          <p v-if="migrationStatus?.error" class="system-error" role="alert">{{ migrationStatus.error }}</p>
          <p v-if="historyLoading" class="system-state" role="status">正在读取升级日志…</p>
          <p v-if="historyError" class="system-error" role="alert">{{ historyError }}</p>
          <ol v-if="versionData.logs.length" class="system-history-list">
            <li v-for="entry in versionData.logs" :key="entry.id"><strong>{{ entry.kind==='version' ? (entry.stage==='update' ? '扩展升级' : '扩展安装') : (entry.stage==='started' ? '数据迁移开始' : entry.stage==='failed' ? '数据迁移失败' : entry.stage==='importing' ? '数据迁移进度' : '数据迁移完成') }}</strong><span>v{{ entry.version }}<template v-if="entry.previousVersion"> · 从 v{{ entry.previousVersion }}</template><template v-if="entry.total!==null && entry.total!==undefined"> · {{ entry.completed }}/{{ entry.total }} 条</template></span><time :datetime="entry.at">{{ formatTime(entry.at) }}</time><small v-if="entry.migrationId">任务：{{ entry.migrationId }}</small><small v-if="entry.error" class="system-error">{{ entry.error }}</small></li>
          </ol>
          <p v-else-if="!historyLoading && !historyError" class="system-state">尚无升级日志；既往未记录的过程无法补造。</p>
        </section>
        <section v-for="group in preferenceGroups" v-show="activeSection===group.key" :key="group.key">
<h3>{{ group.label }}</h3><div v-for="field in group.fields" :key="field.key" class="system-setting-row">
<label :for="`system-${group.key}-${field.key}`">{{ field.label }}</label>
<select v-if="field.options" :id="`system-${group.key}-${field.key}`" v-model.number="preferences[group.key][field.key]" :disabled="saving"><option v-for="option in field.options" :key="option.value" :value="option.value">{{ option.label }}</option></select>
<input v-else :id="`system-${group.key}-${field.key}`" v-model.number="preferences[group.key][field.key]" type="number" :min="field.min" :max="field.max" :disabled="saving">
<span class="info-tip" tabindex="0" role="note" :data-tip="field.tip" :aria-label="field.tip">?</span></div></section>
<p class="system-state" role="status">{{ message }}</p>
        <p v-if="error" class="system-error" role="alert">{{ error }}</p>
      </div>
      <div v-show="!['data','versions','upgrades','grok-bot','grok-local'].includes(activeSection)" class="system-settings-footer"><button id="saveSystemSettings" type="button" :disabled="saving || !settingsLoaded" @click="save">{{ saving ? '保存中…' : '保存设置' }}</button><button type="button" class="secondary" :disabled="saving" @click="resetDefaults">恢复默认</button></div>
      </div>
    </aside>
  </Teleport>
</template>
<script setup>
import {ref, reactive, computed, nextTick, onUnmounted} from 'vue';
import {SYSTEM_DEFAULTS, readSystemSettings, saveSystemSettings} from '../../../shared/system-settings.js';
import {APP_VERSION} from '../../../shared/version.js';
import PanelCloseButton from './PanelCloseButton.vue';
import GrokBotSettings from './GrokBotSettings.vue';
import GrokLocalSettings from './GrokLocalSettings.vue';
import {grokProviderController} from '../composables/useGrokProvider.js';
import {BACKUP_DEFAULTS, validateBackupSettings} from '../../../features/records/record-snapshots.js';
const isOpen=ref(false), drawer=ref(null), status=ref(null), loading=ref(false), loadError=ref(''), busy=ref(false), saving=ref(false), settingsLoaded=ref(false), error=ref(''), message=ref('');
const activeSection=ref('data');
const settingTabs=[{key:'data',label:'本地数据',icon:'M4 4h16v16H4z M4 9h16 M8 13h8 M8 16h5'},{key:'backup',label:'备份设置',icon:'M5 7h14v14H5z M8 7V3h8v4 M8 14h8 M12 10v8'}];
const options=values=>values.map(value=>({value,label:String(value)}));
const preferenceGroups=[
{key:'pagination',label:'默认每页条数',fields:Object.entries({fans:'粉丝跟进',mutual:'互关追踪',comments:'评论追踪',unreciprocated:'回关监控',queue:'关注队列'}).map(([key,label])=>({key,label,options:options([10,20,50,100]),tip:'保存后回到第一页并立即应用；重新打开面板仍使用此默认值。列表顶部可临时调整。'}))},
{key:'logs',label:'日志查询',fields:[
{key:'pageSize',label:'每页日志（条）',options:options([10,20,30,50]),tip:'默认 30 条，打开执行日志时生效。'},
{key:'days',label:'默认查询范围',options:[{value:0,label:'全部时间'},...[7,30,90].map(value=>({value,label:`近 ${value} 天`}))],tip:'打开日志时按此范围查询，翻页保持相同时间边界；不会删除历史日志，执行日志与业务备份独立。'}]},
{key:'windows',label:'临时窗口回收',fields:[
{key:'idleMinutes',label:'闲置回收（分）',min:1,max:120,tip:'默认 8 分钟。Grok 窗口释放或结束前台使用后开始计时；保存后在下次释放或触碰时使用新值。'},
{key:'lifetimeMinutes',label:'任务保留（分）',min:15,max:120,tip:'默认 15 分钟，新临时窗口的最低保留时间；任务申请更长时间时优先保障任务。'},
{key:'checkMinutes',label:'检查间隔（分）',min:1,max:30,tip:'默认每 1 分钟检查。只回收扩展拥有的闲置窗口；前台、忙碌、人工验证及常驻窗口保留。'}]}
];
settingTabs.push(...preferenceGroups.map(group=>({key:group.key,label:{pagination:'列表分页',logs:'执行日志',windows:'临时窗口'}[group.key],icon:{pagination:'M4 5h16 M4 12h16 M4 19h16',logs:'M5 3h14v18H5z M8 8h8 M8 12h8 M8 16h5',windows:'M3 4h18v16H3z M3 8h18 M15 12l4 4 M19 12l-4 4'}[group.key]})));
settingTabs.push({key:'versions',label:'版本历史',icon:'M4 5h16 M4 12h10 M4 19h16 M17 10l3 3-3 3'}, {key:'upgrades',label:'升级日志',icon:'M5 3h14v18H5z M8 8h8 M8 12h8 M8 16h5'});
settingTabs.splice(2,0,{key:'grok-bot',label:'Grok Webhook',icon:'M5 8h14v12H5z M12 4v4 M9 13h1 M14 13h1 M9 17h6'});
settingTabs.splice(3,0,{key:'grok-local',label:'Grok Bot',icon:'M5 8h14v12H5z M12 4v4 M9 13h1 M14 13h1 M9 17h6'});
const versionData=reactive({versions:[],logs:[]});
const historyLoading=ref(false),historyError=ref(''),migrationStatus=ref(null);
let historyGeneration=0;
const preferences=reactive(structuredClone(SYSTEM_DEFAULTS));
const form=reactive({...BACKUP_DEFAULTS});
const fields=[
  {key:'retain',label:'历史快照（份）',min:1,max:10,tip:'默认保留 3 份，可设 1–10 份。减少数量在下次新快照恢复校验通过后生效。'},
  {key:'incrementalLimit',label:'增量触发（条）',min:100,max:10000,tip:'默认 1,000 条。与最长间隔满足任一条件时，在下次后台检查生成新快照。'},
  {key:'maxAgeHours',label:'最长间隔（小时）',min:1,max:168,tip:'默认 24 小时，有新变更才生成快照，没有变化不会重复备份。'},
  {key:'checkMinutes',label:'检查间隔（分）',min:5,max:1440,tip:'默认每 60 分钟检查备份条件。保存后更新后台计划；浏览器关闭期间不执行。'}
];
const verification=computed(()=>!status.value?'—':status.value.verification?.verified?`已通过 · ${status.value.verification.rows.toLocaleString()} 条记录`:status.value.snapshotCount?'未记录校验结果':'尚无快照');
const date=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'尚未备份';
const formatTime=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';
async function request(op,extra={}){const response=await chrome.runtime.sendMessage({action:'recordData',op,...extra});if(!response?.ok)throw new Error(response?.error||'操作未完成，请重试');return response;}
let opener, timer, generation=0;
async function open(){opener=document.activeElement;isOpen.value=true;message.value='';error.value='';await nextTick();drawer.value?.querySelector('button')?.focus();await Promise.all([refresh(),loadSettings()]);}
function close(){grokProviderController.cancel();isOpen.value=false;generation++;historyGeneration++;clearTimeout(timer);opener?.focus();}
function selectSection(section){activeSection.value=section;message.value='';error.value='';if(section==='versions'||section==='upgrades')void loadVersionHistory();}
async function loadVersionHistory(){const ticket=++historyGeneration;historyLoading.value=true;historyError.value='';try{const response=await chrome.runtime.sendMessage({cmd:'versionHistory'});if(!response?.ok)throw new Error(response?.error||'版本记录读取失败');if(ticket!==historyGeneration)return;versionData.versions=response.versions||[];versionData.logs=response.logs||[];if(activeSection.value==='upgrades'){let migration;try{migration=(await request('status')).status;}catch(e){migration={stage:'无法读取',error:e.message};}if(ticket===historyGeneration)migrationStatus.value=migration;}}catch(e){if(ticket===historyGeneration)historyError.value=e.message;}finally{if(ticket===historyGeneration)historyLoading.value=false;}}
async function loadSettings(){settingsLoaded.value=false;try{await Promise.all([request('backupSettings').then(result=>Object.assign(form,result.settings)),...preferenceGroups.map(async group=>Object.assign(preferences[group.key],await readSystemSettings(group.key)))]);settingsLoaded.value=true;}catch(e){error.value=e.message;}}
async function refresh(){const ticket=++generation;loading.value=true;loadError.value='';try{const data=(await request('backupStatus')).result;if(ticket===generation){status.value=data;if(data.running)timer=setTimeout(refresh,3000);}}catch(e){if(ticket===generation){status.value=null;loadError.value=e.message;}}finally{if(ticket===generation)loading.value=false;}}
async function save(){error.value='';message.value='';try{saving.value=true;if(activeSection.value==='backup'){const value=validateBackupSettings({...form});Object.assign(form,(await request('backupSettings',{value})).settings);}else{const group=activeSection.value;Object.assign(preferences[group],await saveSystemSettings(group,{...preferences[group]}));}message.value='设置已保存';}catch(e){error.value=e.message;}finally{saving.value=false;}}
function resetDefaults(){if(activeSection.value==='backup')Object.assign(form,BACKUP_DEFAULTS);else Object.assign(preferences[activeSection.value],SYSTEM_DEFAULTS[activeSection.value]);message.value='已填入默认值，保存后生效';error.value='';}
async function backupNow(){busy.value=true;error.value='';message.value='';try{await request('maintainBackups',{force:true});message.value='备份完成，恢复校验通过';}catch(e){error.value=e.message;}finally{busy.value=false;if(isOpen.value)await refresh();}}
function trapFocus(event){const items=[...drawer.value.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(e=>e.getClientRects().length);const first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
const openBot=()=>{activeSection.value='grok-bot';void open();};
const openLocal=()=>{activeSection.value='grok-local';void open();};
document.addEventListener('xfollower:bind-grok-bot',openBot);
document.addEventListener('xfollower:bind-grok-local',openLocal);
onUnmounted(()=>{document.removeEventListener('xfollower:bind-grok-bot',openBot);document.removeEventListener('xfollower:bind-grok-local',openLocal);generation++;historyGeneration++;clearTimeout(timer);});
</script>
<style scoped>
.local-data-entry{display:inline-flex;align-items:center;justify-content:center;flex:0 0 30px;width:30px;min-width:30px;height:30px;padding:0!important;background:transparent!important;border:0!important;color:inherit!important;box-shadow:none!important;position:relative}
.local-data-entry>svg{flex:0 0 20px;width:20px;height:20px}
.local-data-entry:hover{background:#ffffff12!important}.local-data-entry::after{content:attr(data-tip);position:absolute;left:40px;bottom:0;white-space:nowrap;background:#18302e;color:white;padding:6px 9px;border-radius:5px;opacity:0;pointer-events:none;font-size:12px}.local-data-entry:hover::after,.local-data-entry:focus-visible::after{opacity:1}
.system-settings{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:min(780px,calc(100vw - 40px));height:min(580px,calc(100vh - 40px));display:flex;background:#fff;border:1px solid #dce6de;border-radius:10px;box-shadow:0 16px 60px #18302e33;box-sizing:border-box;z-index:10001;overflow:hidden}
.system-settings-nav{width:164px;flex-shrink:0;background:#eef3ef;padding:20px 10px;box-sizing:border-box}.system-settings-nav>strong{display:block;font-size:13px;color:#607c70;margin:0 10px 24px}.system-settings-nav button{display:flex;align-items:center;width:100%;height:34px;border:0;background:transparent;color:#24483b;font-size:12px;text-align:left;margin-bottom:6px;padding:0 10px;box-shadow:none}.system-settings-nav button svg{margin-right:10px;flex-shrink:0}.system-settings-nav button.selected{background:#d4e7da;color:#1f604a}
.system-settings-main{display:flex;flex-direction:column;flex:1;min-width:0}.system-settings .profile-drawer-head{min-height:54px;padding:0 20px}.system-settings-content{flex:1;min-height:0;overflow:auto;padding:10px 20px!important}
.system-settings-mask{z-index:10000}.system-settings .info-tip:focus::after{opacity:1}.system-setting-row .info-tip::after{left:auto;right:0;transform:none}.backup-summary .info-tip::after,.system-switch .info-tip::after{left:0;transform:none}
.system-settings section{margin-bottom:16px}.system-settings h3{font-size:13px;margin:0;padding:8px 0;color:#24594a}.system-section-heading{display:flex;align-items:center;justify-content:space-between}
.system-icon{width:30px;height:30px;padding:0!important;display:inline-flex;align-items:center;justify-content:center}
.backup-summary{margin:0 0 10px;font-size:12px}.backup-summary>div{display:flex;align-items:center;min-height:36px;border-bottom:1px solid #e5ede8}.backup-summary dt{width:100px;flex-shrink:0;display:flex;align-items:center}.backup-summary dd{margin:0;flex:1;overflow-wrap:anywhere}.info-tip{margin-left:6px}
.system-switch{display:flex;align-items:center;min-height:36px;font-size:12px}.system-switch input{margin:0 8px 0 0}
.system-setting-row{display:flex;align-items:center;min-height:44px;border-bottom:1px solid #e5ede8;font-size:12px}.system-setting-row label{width:120px;text-align:left;margin-right:10px;flex-shrink:0}.system-setting-row input,.system-setting-row select{width:100px;min-width:0;height:30px;box-sizing:border-box;font-size:12px}.system-setting-row .info-tip{margin-left:10px}
.system-settings-footer{display:flex;padding:10px 12px;border-top:1px solid #dce6de}.system-settings-footer button{flex:1;margin-right:10px;height:30px;font-size:12px}.system-settings-footer button:last-child{margin-right:0}.system-state,.system-error{font-size:12px;line-height:1.6;margin:8px 0;overflow-wrap:anywhere}.system-state{color:#607c70}.system-error{color:#b42318}
.system-version-current{font-size:12px;color:#24483b;margin:8px 0}.system-version-current strong{font-size:16px}.system-history-list{list-style:none;margin:10px 0;padding:0}.system-history-list li{display:grid;grid-template-columns:minmax(105px,1fr) minmax(120px,2fr) auto;gap:4px 12px;padding:10px 0;border-bottom:1px solid #e5ede8;font-size:12px;line-height:1.5}.system-history-list strong{color:#24594a}.system-history-list time{color:#607c70;white-space:nowrap}.system-history-list small{grid-column:1/-1;overflow-wrap:anywhere;color:#607c70}.system-history-list small.system-error{color:#b42318}
@media(max-width:560px){.system-settings{width:calc(100vw - 20px);height:calc(100dvh - 20px);flex-direction:column}.system-settings-nav{width:100%;padding:8px 10px;display:flex;overflow-x:auto;flex-shrink:0}.system-settings-nav>strong{display:none}.system-settings-nav button{width:auto;flex-shrink:0;margin:0 10px 0 0}.system-settings-main{min-height:0}.system-settings-content{padding:10px 12px!important}.system-setting-row label{width:120px}.system-setting-row input,.system-setting-row select{width:76px}.system-history-list li{grid-template-columns:minmax(0,1fr) auto;gap:2px 8px}.system-history-list li span{grid-column:1/-1;grid-row:2;overflow-wrap:anywhere}.system-history-list time{grid-column:2;grid-row:1;text-align:right;white-space:normal}}
</style>

