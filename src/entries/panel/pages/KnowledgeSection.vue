<template>
  <section id="knowledgeSection" class="tab-panel knowledge-panel" data-panel="knowledge" :hidden="activeTab !== 'knowledge'" aria-label="知识库">
    <div class="kb-head"><p class="kb-context">经验持续积累，合入智慧后用于生成</p><PanelActionBar class="kb-head-actions"><KnowledgeWisdomPanel v-if="ownerId && activeTab === 'knowledge'" ref="wisdomRef" :owner-id="ownerId" @state="wisdomState=$event" @updated="onWisdomUpdated" /><PanelIconButton :icon="Settings" label="知识库设置" :disabled="!ownerId" @click="openSettings" /><PanelIconButton :icon="Plus" label="新增经验" :disabled="!ownerId || busy" @click="openCreateDrawer" /><PanelIconButton :icon="RefreshCw" label="刷新经验" :disabled="loading || busy" @click="loadData" /></PanelActionBar></div>
    <div v-if="error" class="kb-alert kb-alert-error" role="alert"><span>{{ error }}</span><PanelCloseButton label="关闭提示" @click="error=''" /></div><div v-if="notice" class="kb-alert kb-alert-notice" role="status"><span>{{ notice }}</span><PanelCloseButton label="关闭提示" @click="notice=''" /></div>
    <KnowledgeLearningPanel v-if="ownerId && activeTab === 'knowledge'" ref="automationRef" :owner-id="ownerId" @updated="loadData" />
    <div class="kb-filter-row"><div class="kb-status-tabs" role="tablist" aria-label="经验状态"><button v-for="st in statusTabs" :key="st.key" type="button" class="kb-status-tab" :class="{active:currentStatus===st.key}" role="tab" :aria-selected="currentStatus===st.key" @click="setStatusFilter(st.key)">{{ st.label }} <span class="kb-tab-count">{{ countByStatus[st.key] || 0 }}</span></button></div>
      <div class="kb-filter-controls"><label class="kb-select-field"><select v-model="sourceFilter" aria-label="经验来源"><option value="all">全部来源</option><option v-for="(label,key) in experienceChannels" :key="key" :value="key" :disabled="key==='blogger_analysis'">{{ label }}{{ key==='blogger_analysis'?' · 未接入':'' }}</option><option value="legacy">历史来源待核实</option></select></label><input v-model="searchQuery" type="search" aria-label="搜索经验" placeholder="搜索经验…"></div>
      <div class="experience-batch"><label><input type="checkbox" :checked="pageSelected" :disabled="!selectablePage.length" aria-label="选择本页经验" @change="togglePage($event.target.checked)"> 本页</label><span>已选 {{ selectedIds.length }} 条</span><button type="button" :disabled="!selectedIds.length" @click="wisdomRef?.merge([...selectedIds])">合入智慧</button><button v-if="selectedIds.length" type="button" class="secondary" @click="selectedIds=[]">清空</button><InfoTip text="单条或批量合入均生成一个智慧版本。先预览再确认；同一条经验不会重复合入当前版本。" /></div>
      <nav class="kb-pagination" aria-label="经验分页"><span>{{ currentPage }} / {{ pageCount }} · {{ filteredItems.length }} 条</span><div class="kb-page-controls"><label class="kb-select-field"><span>每页</span><select v-model.number="pageSize" aria-label="经验每页条数"><option :value="20">20</option><option :value="50">50</option><option :value="100">100</option></select><span>条</span></label><button type="button" class="secondary" :disabled="currentPage <= 1" @click="currentPage--">‹</button><button type="button" class="secondary" :disabled="currentPage >= pageCount" @click="currentPage++">›</button></div></nav>
    </div>
    <div class="kb-list-container" :aria-busy="loading || busy"><p v-if="loading && !knowledgeItems.length" class="kb-empty" role="status">正在读取经验…</p><div v-else-if="!ownerId" class="kb-empty-box"><p>请先登录 X，确认账号后刷新。</p></div><div v-else-if="!filteredItems.length" class="kb-empty-box"><p>暂无{{ currentStatus==='pending'?'待合入':'' }}经验</p><p class="kb-hint">定时总结或手动录入经验后，在这里选择合入智慧。</p></div><div v-else class="experience-table-wrap"><table class="experience-table" aria-label="经验列表"><thead><tr><th class="experience-select"></th><th>经验</th><th class="experience-source-col">来源</th><th class="experience-state-col">状态</th><th class="experience-time-col">总结时间</th><th class="experience-detail-col">操作</th></tr></thead><tbody><tr v-for="item in pagedItems" :key="item.id"><td class="experience-select"><input type="checkbox" :checked="selectedIds.includes(item.id)" :disabled="experienceState(item)!=='pending'" :aria-label="'选择经验 '+item.statement" @change="toggleItem(item.id,$event.target.checked)"></td><td class="experience-summary-col"><span class="experience-summary" :title="item.statement">{{ item.statement }}</span><span class="experience-mobile-source">{{ sourceLabel(item) }}</span></td><td class="experience-source-col"><span class="experience-source" :title="sourceLabel(item)">{{ sourceLabel(item) }}</span></td><td class="experience-state-col"><span class="kb-status-badge" :class="experienceState(item)==='included'?'active':'candidate'">{{ ({pending:'待合入',included:'已合入',ignored:'已忽略'})[experienceState(item)] }}</span></td><td class="experience-time-col">{{ formatDate(item.createdAt) }}</td><td class="experience-detail-col"><PanelIconButton :icon="Eye" label="查看经验详情" @click="openEvidence(item)" /></td></tr></tbody></table></div></div>

    <!-- Candidate Creation Drawer -->
    <ActionSettingsDrawer ref="createDrawerRef" title="新增经验" @close="resetCandidateDraft">
      <div class="kb-drawer-form">
        <label class="kb-form-field">
          <span>知识类型 <strong class="kb-req">*</strong></span>
          <select v-model="candidateDraft.type">
            <option value="writing_principle">写作原则</option>
            <option value="pitfall">常见陷阱</option>
            <option value="conditional_observation">条件观察</option>
          </select>
        </label>

        <label class="kb-form-field">
          <span>经验内容 <strong class="kb-req">*</strong></span>
          <textarea
            v-model="candidateDraft.statement"
            rows="3"
            maxlength="1000"
            placeholder="写下结论，并注明它适用的对象、条件或反例。"
          ></textarea>
        </label>

        <label class="kb-form-field">
          <span>原始参考文本（可选，完整保留原文）</span>
          <textarea
            v-model="candidateDraft.originalText"
            rows="3"
            maxlength="2000"
            placeholder="参考推文正文或备忘文本…"
          ></textarea>
        </label>

        <label class="kb-form-field">
          <span>来源 X 推文链接（可选）</span>
          <input
            v-model="candidateDraft.sourceUrl"
            type="url"
            placeholder="https://x.com/username/status/1234567890"
          >
          <small class="kb-hint">仅允许安全的 https://x.com 或 twitter.com 链接</small>
        </label>

        <label v-if="candidateDraft.sourceUrl.trim()" class="kb-form-field">
          <span>证据关联关系</span>
          <select v-model="candidateDraft.relation">
            <option value="support">正向支撑</option>
            <option value="counterexample">反例/避坑</option>
            <option value="scope_limitation">范围局限</option>
          </select>
        </label>

        <label class="kb-form-field">
          <span>关联主题/场景标签（可选）</span>
          <input
            v-model="candidateDraft.theme"
            type="text"
            placeholder="例如：技术分享、新账号、中文帖子"
          >
        </label>

        <label class="kb-form-field">
          <span>适用条件（可选）</span>
          <input v-model="candidateDraft.conditions" type="text" maxlength="2000" placeholder="例如：仅适用于中文技术分享，不适用于促销帖">
        </label>

        <label class="kb-form-field">
          <span>添加原因或备注（可选）</span>
          <input
            v-model="candidateDraft.reason"
            type="text"
            placeholder="人工经验沉淀、实机测试等…"
          >
        </label>

        <p v-if="createError" class="kb-form-error" role="alert">{{ createError }}</p>
      </div>

      <template #footer>
        <button type="button" class="secondary" @click="closeCreateDrawer">取消</button>
        <button
          type="button"
          class="kb-btn-primary"
          :disabled="busy || !candidateDraft.statement.trim()"
          @click="submitCandidate"
        >
          {{ busy ? '提交中…' : '新增经验' }}
        </button>
      </template>
    </ActionSettingsDrawer>

    <!-- Source Evidence Viewer Drawer -->
    <ActionSettingsDrawer ref="evidenceDrawerRef" title="经验详情" @close="activeEvidenceItem = null">
      <div v-if="activeEvidenceItem" class="kb-drawer-content">
        <section class="kb-drawer-section">
          <h3>经验内容</h3>
          <p class="kb-statement-preview">{{ activeEvidenceItem.statement }}</p><p v-if="activeEvidenceItem.scope?.conditions" class="kb-hint">适用条件：{{ activeEvidenceItem.scope.conditions }}</p><p class="kb-hint">{{ stateLabel(activeEvidenceItem) }} · 总结时间 {{ formatDate(activeEvidenceItem.createdAt) }}</p>
        </section>

        <section class="kb-drawer-section">
          <h3>来源渠道</h3><p>{{ sourceLabel(activeEvidenceItem) }}</p><article v-for="source in itemSources(activeEvidenceItem)" :key="source.key" class="kb-evidence-card"><p>{{ experienceChannels[source.channel] || '来源待核实' }}<span v-if="source.handle"> · @{{ source.handle }}</span></p><p class="kb-hint">总结时间：{{ formatDate(source.summarizedAt) }} · 采集时间：{{ formatDate(source.capturedAt) }}</p><a v-if="safeUrl(source.url)" :href="safeUrl(source.url)" target="_blank" rel="noopener noreferrer">查看来源帖子</a><small class="kb-hint" :title="source.analysisId"> 分析批次已记录</small></article><h3>原帖证据</h3>
          <p v-if="loadingEvidence" class="kb-hint">正在读取证据列表…</p>
          <div v-else-if="evidenceList.length === 0" class="kb-empty-box">
            <p class="kb-empty-title">暂无关联证据</p>
            <p class="kb-empty-desc">该知识条目为直接录入，未关联 X 推文证据快照。</p>
          </div>
          <div v-else class="kb-evidence-list">
            <article
              v-for="ev in evidenceList"
              :key="ev.id"
              class="kb-evidence-card"
            >
              <div class="kb-evidence-header">
                <span class="kb-relation-badge" :class="ev.relation">
                  {{ formatRelation(ev.relation) }}
                </span>
                <span v-if="ev.handleAtCapture" class="kb-evidence-handle">
                  @{{ ev.handleAtCapture }}
                </span>
                <a
                  v-if="safeUrl(ev.url)"
                  :href="safeUrl(ev.url)"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="kb-ext-link"
                >
                  在 X 查看原帖 ↗
                </a>
              </div>

              <blockquote class="kb-evidence-text">{{ ev.text || '（无正文）' }}</blockquote>

              <div v-if="ev.metrics" class="kb-evidence-metrics">
                <span>曝光 {{ ev.metrics.impressions ?? '—' }}</span>
                <span>点赞 {{ ev.metrics.likes ?? '—' }}</span>
                <span>评论 {{ ev.metrics.replies ?? '—' }}</span>
                <span>转帖 {{ ev.metrics.reposts ?? '—' }}</span>
              </div>

              <div class="kb-evidence-meta">
                <span>{{ ev.availability === 'legacy_reference' ? '手动引用，未抓取核验 · 录入时间' : '抓取时间' }}: {{ formatDate(ev.capturedAt) }}</span>
                <span v-if="ev.availability !== 'available' && ev.availability !== 'legacy_reference'"> · 来源状态：{{ ev.availability }}</span>
                <span v-if="ev.reason"> · {{ ev.reason }}</span>
              </div>
            </article>
          </div>
        </section>
      </div>
      <template #footer><template v-if="activeEvidenceItem"><button v-if="experienceState(activeEvidenceItem)==='pending'" type="button" class="secondary" :disabled="busy" @click="reviewItem(activeEvidenceItem,'reject')">忽略</button><button v-if="activeEvidenceItem.status==='disabled'" type="button" class="secondary" :disabled="busy" @click="reviewItem(activeEvidenceItem,'candidate')">恢复待合入</button><button v-if="experienceState(activeEvidenceItem)==='pending'" type="button" class="kb-btn-primary" :disabled="busy" @click="mergeFromDetail(activeEvidenceItem)">合入智慧</button></template></template>
    </ActionSettingsDrawer>

    <!-- Revision History Drawer -->
    <ActionSettingsDrawer ref="revisionsDrawerRef" title="知识修订历史" @close="activeRevisionsItem = null">
      <div v-if="activeRevisionsItem" class="kb-drawer-content">
        <section class="kb-drawer-section">
          <h3>知识条目</h3>
          <p class="kb-statement-preview">{{ activeRevisionsItem.statement }}</p>
        </section>

        <section class="kb-drawer-section">
          <h3>版本记录</h3>
          <p v-if="loadingRevisions" class="kb-hint">正在读取版本历史…</p>
          <div v-else-if="revisionsList.length === 0" class="kb-empty-box">
            <p class="kb-empty-title">暂无独立修订快照</p>
            <p class="kb-empty-desc">当前条目尚无历史修订记录，当前版本为 v{{ activeRevisionsItem.revision }}。</p>
          </div>
          <div v-else class="kb-revisions-timeline">
            <div
              v-for="rev in revisionsList"
              :key="rev.revision"
              class="kb-rev-item"
            >
              <div class="kb-rev-meta-line">
                <span class="kb-rev-tag">修订 v{{ rev.revision }}</span>
                <span class="kb-status-badge" :class="rev.status">{{ formatStatus(rev.status) }}</span>
                <span class="kb-rev-operator">操作者: {{ rev.operator || 'system' }}</span>
                <span class="kb-date-meta">{{ formatDate(rev.createdAt) }}</span>
              </div>
              <p class="kb-rev-reason">审核/变更原因: {{ rev.reason || '无备注' }}</p>
              <blockquote class="kb-rev-statement">{{ rev.statement }}</blockquote>
            </div>
          </div>
        </section>
      </div>
    </ActionSettingsDrawer>
  </section>
</template>

<script setup>
import InfoTip from '../components/InfoTip.vue';
import PanelActionBar from '../components/PanelActionBar.vue';
import PanelIconButton from '../components/PanelIconButton.vue';
import {Settings, Plus, RefreshCw, Eye} from 'lucide';
import { ref, reactive, computed, watch, onUnmounted } from 'vue';
import ActionSettingsDrawer from '../components/ActionSettingsDrawer.vue';
import PanelCloseButton from '../components/PanelCloseButton.vue';
import { panelNavigationController } from '../composables/usePanelNavigation.js';
import KnowledgeWisdomPanel from '../components/KnowledgeWisdomPanel.vue';
import {EXPERIENCE_CHANNELS as experienceChannels} from '../../../features/knowledge/wisdom.js';
import KnowledgeLearningPanel from '../components/KnowledgeLearningPanel.vue';
import { createKnowledgeStore } from '../../../features/knowledge/knowledge-store.js';
import { createKnowledgeReviewService } from '../../../features/knowledge/knowledge-review.js';
import { createKnowledgeOwner } from '../../../features/knowledge/knowledge-owner.js';
import { safeXPostUrl } from '../../../shared/urls.js';

const { activeTab } = panelNavigationController;

// Store and Review Service
const automationRef=ref(null),wisdomRef=ref(null),wisdomState=ref(null),selectedIds=ref([]),sourceFilter=ref('all');
const store = createKnowledgeStore();
const reviewService = createKnowledgeReviewService({ store });
const account = createKnowledgeOwner({resolve:() => chrome.runtime.sendMessage({cmd:'followQueueIdentity'})});
const reviewReasons = reactive({});
let loadSequence = 0;
let evidenceSequence = 0;
let revisionSequence = 0;

// Reactive State
const ownerId = ref('');
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const notice = ref('');

const knowledgeItems = ref([]);
const currentStatus = ref('pending');
const currentType = ref('all');
const searchQuery = ref('');
const currentPage = ref(1);
const displaySettingsKey = 'xfollower.knowledge.pageSize';
function savedPageSize() { try { const n = Number(localStorage.getItem(displaySettingsKey)); return [20,50,100].includes(n) ? n : 20; } catch { return 20; } }
const pageSize = ref(savedPageSize());
function openSettings() { automationRef.value?.open(); }
function saveSettings() {
  try { localStorage.setItem(displaySettingsKey, String(settingsPageSize.value)); pageSize.value = settingsPageSize.value; settingsDrawerRef.value?.close(); }
  catch { settingsError.value = '显示设置保存失败，请重试。'; }
}
watch(pageSize, size => { try { localStorage.setItem(displaySettingsKey, String(size)); } catch { notice.value = '每页条数已生效，但未能保存到浏览器。'; } });
const pageCount = computed(() => Math.max(1, Math.ceil(filteredItems.value.length / pageSize.value)));
const pagedItems = computed(() => filteredItems.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value));
watch([currentStatus, currentType, searchQuery, pageSize, ownerId], () => { currentPage.value = 1; }, { flush: 'sync' });


// Drawers
const createDrawerRef = ref(null);
const evidenceDrawerRef = ref(null);
const revisionsDrawerRef = ref(null);

const activeEvidenceItem = ref(null);
const evidenceList = ref([]);
const loadingEvidence = ref(false);

const activeRevisionsItem = ref(null);
const revisionsList = ref([]);
const loadingRevisions = ref(false);

const createError = ref('');
const candidateDraft = reactive({
  type: 'writing_principle',
  statement: '',
  originalText: '',
  sourceUrl: '',
  relation: 'support',
  theme: '',
  conditions: '',
  reason: ''
});

const statusTabs=[{key:'pending',label:'待合入'},{key:'included',label:'已合入'},{key:'all',label:'全部'},{key:'ignored',label:'已忽略'}];
function experienceState(item){if(wisdomState.value?.head?.experiences.some(e=>e.id===item.id&&e.revision===item.revision))return 'included';if(['disabled','archived','merged'].includes(item.status))return 'ignored';return 'pending';}
function stateLabel(item){return ({pending:'待合入',included:'已合入当前智慧',ignored:'已忽略'})[experienceState(item)];}
function itemSources(item){return wisdomState.value?.sources?.filter(s=>s.knowledgeId===item.id)||[];}
function sourceKeys(item){const sources=itemSources(item);return sources.length?[...new Set(sources.map(s=>s.channel))]:[item.scope?.sourceChannel==='manual'?'manual':'legacy'];}
function sourceLabel(item){const sources=itemSources(item);const labels=sourceKeys(item).map(k=>experienceChannels[k]||'历史来源待核实');const handles=[...new Set(sources.map(s=>s.handle).filter(Boolean))];return labels.join('、')+(handles.length?' · @'+handles.slice(0,2).join('、@'):'');}
const countByStatus=computed(()=>{const counts={all:knowledgeItems.value.length,pending:0,included:0,ignored:0};for(const item of knowledgeItems.value)counts[experienceState(item)]++;return counts;});
const filteredItems=computed(()=>knowledgeItems.value.filter(item=>(currentStatus.value==='all'||experienceState(item)===currentStatus.value)&&(sourceFilter.value==='all'||sourceKeys(item).includes(sourceFilter.value))&&(!searchQuery.value.trim()||[item.statement,sourceLabel(item)].join(' ').toLowerCase().includes(searchQuery.value.trim().toLowerCase()))));
const selectablePage=computed(()=>pagedItems.value.filter(item=>experienceState(item)==='pending'));
const pageSelected=computed(()=>selectablePage.value.length>0&&selectablePage.value.every(item=>selectedIds.value.includes(item.id)));
function toggleItem(id,checked){selectedIds.value=checked?[...new Set([...selectedIds.value,id])]:selectedIds.value.filter(v=>v!==id);}
function togglePage(checked){for(const item of selectablePage.value)toggleItem(item.id,checked);}
async function onWisdomUpdated(){selectedIds.value=[];await loadData();}
watch([currentStatus,sourceFilter,ownerId],()=>{selectedIds.value=[];currentPage.value=1;});

watch(pageCount, count => { currentPage.value = Math.min(currentPage.value, count); }, { flush: 'sync' });

function safeUrl(url) {
  return safeXPostUrl(url);
}

function formatDate(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return String(ts);
  }
}

function formatType(type) {
  switch (type) {
    case 'writing_principle': return '写作原则';
    case 'pitfall': return '常见陷阱';
    case 'conditional_observation': return '条件观察';
    default: return type || '知识';
  }
}

function formatStatus(status) {
  switch (status) {
    case 'candidate': return '待审核';
    case 'active': return '已采纳';
    case 'disabled': return '已拒绝/停用';
    case 'archived': return '已归档';
    case 'merged': return '已合并';
    default: return status || '未知';
  }
}

function formatRelation(relation) {
  switch (relation) {
    case 'support': return '正向支撑';
    case 'counterexample': return '反例';
    case 'scope_limitation': return '范围局限';
    default: return relation || '支撑';
  }
}

async function resolveCurrentOwnerId() {
  return account.current();
}

async function loadData() {
  const sequence = ++loadSequence;
  error.value = '';
  loading.value = true;
  try {
    const currentOwner = await resolveCurrentOwnerId();
    if (sequence !== loadSequence) return;
    if (ownerId.value !== currentOwner) {
      knowledgeItems.value = [];
      for (const key of Object.keys(reviewReasons)) delete reviewReasons[key];
      evidenceDrawerRef.value?.close();
      revisionsDrawerRef.value?.close();
      closeCreateDrawer();
    }
    ownerId.value = currentOwner;
    const list = await reviewService.listKnowledge(currentOwner);
    if (sequence !== loadSequence) return;
    // Sort by updatedAt descending
    knowledgeItems.value = (list || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    await wisdomRef.value?.refresh();
  } catch (err) {
    if (sequence !== loadSequence) return;
    ownerId.value = '';
    knowledgeItems.value = [];
    error.value = err.message || '加载知识库条目失败';
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}

function setStatusFilter(status) {
  currentStatus.value = status;
}

function applyFilters() {
  // Handled reactively by filteredItems
}

async function reviewItem(item, action) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await account.assert(item.ownerId);
    const result = await reviewService.reviewKnowledge({
      ownerId: item.ownerId,
      knowledgeId: item.id,
      action,
      expectedRevision: item.revision,
      reason: reviewReasons[item.id] || '',
      operator: 'user'
    });

    if (!result.ok) throw Error(result.error || '审核失败');
    if (result.ok) {
      if (result.idempotent) {
        notice.value = `条目已是目标状态，无需重复变更`;
      } else {
        const actionLabel = action === 'approve' ? '审核通过' : '审核拒绝';
        notice.value = `经验已${actionLabel}（版本升级至 v${result.knowledge?.revision || item.revision+1}）`;
      }
      await loadData();
    }
  } catch (err) {
    error.value = err.message || '审核操作失败';
  } finally {
    busy.value = false;
  }
}

function openCreateDrawer() {
  createError.value = '';
  createDrawerRef.value?.open();
}

function closeCreateDrawer() {
  createDrawerRef.value?.close();
  resetCandidateDraft();
}

function resetCandidateDraft() {
  candidateDraft.type = 'writing_principle';
  candidateDraft.statement = '';
  candidateDraft.originalText = '';
  candidateDraft.sourceUrl = '';
  candidateDraft.relation = 'support';
  candidateDraft.theme = '';
  candidateDraft.conditions = '';
  candidateDraft.reason = '';
  createError.value = '';
}

async function submitCandidate() {
  if (busy.value) return;
  createError.value = '';
  const draft = { ...candidateDraft };

  const cleanStmt = (draft.statement || '').trim();
  if (!cleanStmt) {
    createError.value = '经验内容不能为空';
    return;
  }

  if (draft.sourceUrl.trim()) {
    const safe = safeXPostUrl(draft.sourceUrl.trim());
    if (!safe) {
      createError.value = '来源链接必须是有效的 X (Twitter) 链接（如 https://x.com/username/status/123）';
      return;
    }
  }

  busy.value = true;
  try {
    const verifiedOwner = await account.assert(ownerId.value);
    const scope = {sourceChannel:'manual'};
    if (draft.theme.trim()) scope.theme = draft.theme.trim();
    if (draft.conditions.trim()) scope.conditions = draft.conditions.trim();
    const res = await reviewService.createCandidate({
      ownerId: verifiedOwner,
      type: draft.type,
      statement: cleanStmt,
      originalText: draft.originalText || null,
      scope,
      sourceUrl: draft.sourceUrl.trim() || '',
      relation: draft.relation,
      reason: draft.reason.trim() || '手动录入候选知识',
      operator: 'user'
    });

    if (res.ok) {
      notice.value = '经验已记录，待合入智慧';
      closeCreateDrawer();
      await loadData();
    }
  } catch (err) {
    createError.value = err.message || '新增经验失败';
  } finally {
    busy.value = false;
  }
}

function mergeFromDetail(item){const id=item.id;evidenceDrawerRef.value?.close();wisdomRef.value?.merge([id]);}

async function openEvidence(item) {
  const sequence = ++evidenceSequence;
  activeEvidenceItem.value = item;
  evidenceList.value = [];
  loadingEvidence.value = true;
  evidenceDrawerRef.value?.open();

  try {
    await account.assert(item.ownerId);
    const list = await reviewService.listEvidenceForKnowledge(item.ownerId, item.id);
    if (sequence !== evidenceSequence) return;
    evidenceList.value = list || [];
  } catch (err) {
    if (sequence === evidenceSequence) { error.value = err.message; evidenceDrawerRef.value?.close(); }
  } finally {
    loadingEvidence.value = false;
  }
}

async function openRevisions(item) {
  const sequence = ++revisionSequence;
  activeRevisionsItem.value = item;
  revisionsList.value = [];
  loadingRevisions.value = true;
  revisionsDrawerRef.value?.open();

  try {
    await account.assert(item.ownerId);
    const list = await reviewService.listRevisions(item.ownerId, item.id);
    if (sequence !== revisionSequence) return;
    revisionsList.value = list || [];
  } catch (err) {
    if (sequence === revisionSequence) { error.value = err.message; revisionsDrawerRef.value?.close(); }
  } finally {
    loadingRevisions.value = false;
  }
}

watch(activeTab, tab => { if (tab === 'knowledge') loadData(); }, {immediate:true});
onUnmounted(() => { ++loadSequence; ++evidenceSequence; ++revisionSequence; store.close(); });
</script>

<style scoped>
/* Scoped layout: flex and 10px margins, avoid excessive gap */
.experience-batch{display:flex;align-items:center;flex-wrap:wrap;gap:10px;width:100%;font-size:12px}.experience-batch label{display:flex;align-items:center;gap:10px}.knowledge-panel[hidden] { display: none; }
.kb-review-reason { display:flex; flex-direction:column; margin:10px 0; font-size:12px; }
.kb-review-reason input { margin-top:5px; width:100%; box-sizing:border-box; }
.knowledge-panel {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  margin: 0;
  padding: 10px;
  min-width: 0;
  width: 100%;
}

.kb-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin: 10px 0;
  flex-wrap: wrap;
}
.kb-head > :not(:last-child) { margin-right: 10px; }

.kb-heading {
  display: flex;
  flex-direction: column;
  margin: 0;
}

.kb-title-row {
  display: flex;
  align-items: center;
}
.kb-title-row > :not(:last-child) { margin-right: 10px; }

.kb-title-row h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: #18302e;
}

.kb-owner-badge {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 99px;
  background: #e9f2e9;
  color: #245b45;
  border: 1px solid #c8dccb;
}

.kb-subtitle {
  margin: 4px 0 0;
  font-size: 13px;
  color: #63716a;
}

.kb-head-actions {
  display: flex;
  align-items: center;
}
.kb-head-actions > :not(:last-child) { margin-right: 10px; }

.kb-btn-primary {
  border: 0;
  background: #245b45;
  color: #ffffff;
  border-radius: 7px;
  font: inherit;
  font-weight: 600;
  padding: 8px 14px;
  cursor: pointer;
  transition: background 0.15s;
}

.kb-btn-primary:hover:not(:disabled) {
  background: #1b4736;
}

.kb-btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.kb-alert {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px;
  margin: 10px 0;
  border-radius: 7px;
  font-size: 13px;
}

.kb-alert-error {
  background: #fff4f1;
  color: #8a2e21;
  border: 1px solid #f7d7d0;
}

.kb-alert-notice {
  background: #eef8f2;
  color: #1d5c3a;
  border: 1px solid #cce8d7;
}

.kb-filter-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  margin: 10px 0;
  padding: 10px;
  background: #ffffff;
  border: 1px solid #dce3d9;
  border-radius: 10px;
}
.kb-filter-row > :not(:last-child) { margin-right: 10px; }

.kb-status-tabs {
  display: flex;
  flex-wrap: wrap;
}
.kb-status-tabs > :not(:last-child) { margin-right: 10px; }

.kb-status-tab {
  display: inline-flex;
  align-items: center;
  border: 1px solid #ccd7cc;
  background: #f4f6f2;
  color: #4b5d52;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.kb-status-tab > :not(:last-child) { margin-right: 10px; }

.kb-status-tab.active {
  background: #245b45;
  color: #ffffff;
  border-color: #245b45;
}

.kb-tab-count {
  font-size: 11px;
  background: rgba(0, 0, 0, 0.08);
  padding: 1px 5px;
  border-radius: 99px;
}

.kb-status-tab.active .kb-tab-count {
  background: rgba(255, 255, 255, 0.25);
  color: #ffffff;
}

.kb-filter-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}
.kb-filter-controls > :not(:last-child) { margin-right: 10px; }

.kb-select-field {
  display: flex;
  align-items: center;
  font-size: 13px;
  font-weight: 600;
}
.kb-select-field > :not(:last-child) { margin: 0 10px 0 0; }

.kb-select-field select {
  font: inherit;
  padding: 6px 10px;
  border: 1px solid #ccd7cc;
  border-radius: 6px;
  background: #ffffff;
}

.kb-search-wrap input {
  font: inherit;
  padding: 6px 10px;
  border: 1px solid #ccd7cc;
  border-radius: 6px;
  width: 180px;
}

.kb-list-container {
  display: flex;
  flex-direction: column;
  margin: 10px 0;
}

.kb-empty {
  padding: 10px;
  text-align: center;
  color: #7a877b;
  font-size: 14px;
}

.kb-empty-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 10px;
  background: #ffffff;
  border: 1px dashed #ccd7cc;
  border-radius: 10px;
  margin: 10px 0;
}

.kb-empty-title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
  color: #4b5d52;
}

.kb-empty-desc {
  margin: 0;
  font-size: 13px;
  color: #7a877b;
  text-align: center;
  max-width: 480px;
}

.kb-cards-list {
  display: flex;
  flex-direction: column;
}
.kb-cards-list > :not(:last-child) { margin-bottom: 10px; }

.kb-card {
  display: flex;
  flex-direction: column;
  background: #ffffff;
  border: 1px solid #dce3d9;
  border-radius: 10px;
  padding: 10px;
  transition: box-shadow 0.15s;
}

.kb-card:hover {
  box-shadow: 0 2px 8px rgba(24, 48, 46, 0.06);
}

.kb-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 10px;
  border-bottom: 1px solid #f0f4ee;
  padding-bottom: 8px;
}
.kb-card-header > :not(:last-child) { margin-right: 10px; }

.kb-card-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}
.kb-card-meta > :not(:last-child) { margin-right: 10px; }

.kb-type-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 4px;
  background: #eef2ea;
  color: #44594c;
}

.kb-status-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 4px;
}

.kb-status-badge.candidate {
  background: #fff1d9;
  color: #795622;
}

.kb-status-badge.active {
  background: #d9eee1;
  color: #1d5c3a;
}

.kb-status-badge.disabled {
  background: #f7d7d0;
  color: #8a2e21;
}

.kb-status-badge.archived {
  background: #eef2ea;
  color: #69766c;
}

.kb-rev-badge {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: #f4f6f2;
  color: #63766a;
  border: 1px solid #dce3d9;
}

.kb-date-meta {
  font-size: 12px;
  color: #88998d;
}

.kb-card-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}
.kb-card-actions > :not(:last-child) { margin-right: 10px; }

.kb-btn-approve {
  border: 0;
  background: #245b45;
  color: #ffffff;
  border-radius: 5px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  padding: 5px 10px;
  cursor: pointer;
}

.kb-btn-approve:hover:not(:disabled) {
  background: #1a4434;
}

.kb-btn-reject {
  border: 0;
  background: #e76f51;
  color: #ffffff;
  border-radius: 5px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  padding: 5px 10px;
  cursor: pointer;
}

.kb-btn-reject:hover:not(:disabled) {
  background: #d15637;
}

.kb-btn-aux {
  font-size: 12px;
  padding: 5px 9px;
  border-radius: 5px;
}

.kb-card-body {
  display: flex;
  flex-direction: column;
}
.kb-card-body > :not(:last-child) { margin-bottom: 10px; }

.kb-statement {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
  color: #18302e;
}

.kb-orig-box {
  background: #f8faf7;
  border-left: 3px solid #ccd7cc;
  padding: 6px 10px;
  border-radius: 0 4px 4px 0;
  margin: 4px 0;
}

.kb-orig-label {
  font-size: 11px;
  font-weight: 600;
  color: #728477;
}

.kb-orig-text {
  margin: 2px 0 0;
  font-size: 12px;
  color: #55675b;
  line-height: 1.4;
}

.kb-scope-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 4px;
}
.kb-scope-row > :not(:last-child) { margin-right: 10px; }

.kb-scope-label {
  font-size: 11px;
  color: #7a8c80;
}

.kb-scope-tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: #eef2ea;
  color: #4b5d52;
}

/* Drawer Form Styles */
.kb-drawer-form {
  display: flex;
  flex-direction: column;
  padding: 6px 0;
}
/* Drawer Form Styles */
.kb-drawer-form > :not(:last-child) { margin-bottom: 10px; }

.kb-form-field {
  display: flex;
  flex-direction: column;
  font-size: 13px;
  font-weight: 600;
  color: #18302e;
}
.kb-form-field > :not(:last-child) { margin-bottom: 10px; }

.kb-req {
  color: #e76f51;
}

.kb-form-field input,
.kb-form-field select,
.kb-form-field textarea {
  font: inherit;
  padding: 8px 10px;
  border: 1px solid #ccd7cc;
  border-radius: 6px;
  background: #ffffff;
  color: #18302e;
}

.kb-form-field input:focus,
.kb-form-field select:focus,
.kb-form-field textarea:focus {
  outline: 2px solid #245b45;
}

.kb-hint {
  font-size: 11px;
  color: #728477;
  font-weight: normal;
}

.kb-form-error {
  margin: 6px 0;
  font-size: 13px;
  color: #8a2e21;
  background: #fff4f1;
  padding: 8px;
  border-radius: 6px;
  border: 1px solid #f7d7d0;
}

/* Drawer Content Styles */
.kb-drawer-content {
  display: flex;
  flex-direction: column;
}
/* Drawer Content Styles */
.kb-drawer-content > :not(:last-child) { margin-bottom: 10px; }

.kb-drawer-section {
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid #e7ece5;
  padding-bottom: 10px;
}
.kb-drawer-section > :not(:last-child) { margin-bottom: 10px; }

.kb-drawer-section:last-child {
  border-bottom: none;
}

.kb-drawer-section h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  color: #4b5d52;
}

.kb-statement-preview {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #18302e;
  line-height: 1.5;
}

.kb-evidence-list {
  display: flex;
  flex-direction: column;
}
.kb-evidence-list > :not(:last-child) { margin-bottom: 10px; }

.kb-evidence-card {
  display: flex;
  flex-direction: column;
  background: #f8faf7;
  border: 1px solid #dce3d9;
  border-radius: 8px;
  padding: 10px;
}
.kb-evidence-card > :not(:last-child) { margin-bottom: 10px; }

.kb-evidence-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.kb-evidence-header > :not(:last-child) { margin-right: 10px; }

.kb-relation-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  background: #eef2ea;
  color: #245b45;
}

.kb-relation-badge.counterexample {
  background: #fff1d9;
  color: #795622;
}

.kb-relation-badge.scope_limitation {
  background: #e6eef5;
  color: #25587e;
}

.kb-evidence-handle {
  font-size: 12px;
  font-weight: 600;
  color: #4b5d52;
}

.kb-ext-link {
  font-size: 12px;
  color: #245b45;
  text-decoration: none;
  font-weight: 600;
}

.kb-ext-link:hover {
  text-decoration: underline;
}

.kb-evidence-text {
  margin: 0;
  font-size: 13px;
  color: #18302e;
  line-height: 1.45;
  padding: 10px;
  background: #ffffff;
  border-radius: 6px;
  border: 1px solid #e7ece5;
}

.kb-evidence-metrics {
  display: flex;
  font-size: 11px;
  color: #55675b;
}
.kb-evidence-metrics > :not(:last-child) { margin-right: 10px; }

.kb-evidence-meta {
  font-size: 11px;
  color: #88998d;
}

.kb-revisions-timeline {
  display: flex;
  flex-direction: column;
}
.kb-revisions-timeline > :not(:last-child) { margin-bottom: 10px; }

.kb-rev-item {
  display: flex;
  flex-direction: column;
  background: #f8faf7;
  border: 1px solid #dce3d9;
  border-radius: 8px;
  padding: 10px;
}
.kb-rev-item > :not(:last-child) { margin-bottom: 10px; }

.kb-rev-meta-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}
.kb-rev-meta-line > :not(:last-child) { margin-right: 10px; }

.kb-rev-tag {
  font-size: 12px;
  font-weight: 700;
  color: #245b45;
}

.kb-rev-operator {
  font-size: 12px;
  color: #55675b;
}

.kb-rev-reason {
  margin: 0;
  font-size: 12px;
  color: #4b5d52;
}

.kb-rev-statement {
  margin: 0;
  font-size: 13px;
  line-height: 1.4;
  padding: 10px;
  background: #ffffff;
  border-radius: 6px;
  border: 1px solid #e7ece5;
  color: #18302e;
}

/* Match the panel toolbar and drawer controls, including inherited global label styles. */
.knowledge-panel > :not(:last-child) { margin-bottom: 10px; }
.kb-head, .kb-filter-row, .kb-list-container, .kb-empty-box { margin: 0; }
.kb-head { align-items: center; }
.kb-heading { min-width: 0; flex: 1; }
.kb-title-row { flex-wrap: wrap; }
.kb-owner-badge { white-space: nowrap; }
.kb-filter-row { justify-content: flex-start; }
.kb-filter-controls { margin-left: 0; }
.kb-status-tabs, .kb-filter-controls, .kb-card-meta, .kb-card-actions { }
.kb-select-field { flex-direction: row; margin: 0; white-space: nowrap; flex-shrink: 0; }
.kb-select-field select { width: auto; margin: 0; }
.kb-status-tab, .kb-head-actions button, .kb-card-actions button, .kb-page-controls button { white-space: nowrap; flex-shrink: 0; }
.kb-head-actions button, .kb-filter-row button, .kb-filter-row input, .kb-filter-row select,
.kb-page-controls button, .kb-page-controls select { box-sizing: border-box; height: 32px; min-height: 32px; padding: 0 10px; margin-top: 0; margin-bottom: 0; }
.kb-statement, .kb-orig-text, .kb-statement-preview, .kb-evidence-text, .kb-rev-statement { overflow-wrap: anywhere; }
.kb-type-badge, .kb-status-badge { display: inline-flex; align-items: center; font-size: 12px; height: 24px; padding: 0 10px; white-space: nowrap; }
.kb-pagination, .kb-page-controls { display: flex; align-items: center; }
.kb-pagination { justify-content: space-between; font-size: 13px; }
.kb-page-controls > :not(:last-child) { margin-right: 10px; }
.kb-page-controls label select { margin: 0 10px 0 0; }
.kb-empty-box { min-height: 120px; padding: 10px; box-sizing: border-box; }
.kb-drawer-form { padding: 0; }
@media (max-width: 1100px) {
  .kb-filter-row, .kb-head, .kb-card-header, .kb-pagination { flex-direction: column; align-items: stretch; }
  .kb-filter-row > :not(:last-child), .kb-head > :not(:last-child), .kb-card-header > :not(:last-child), .kb-pagination > :not(:last-child) { margin: 0 0 10px; }
  .kb-filter-controls { margin-left: 0; }
}
@media (max-width: 600px) {
  .kb-status-tabs, .kb-card-meta, .kb-card-actions { flex-wrap: wrap; margin-bottom: -10px; }
  .kb-status-tabs > *, .kb-card-meta > *, .kb-card-actions > * { margin-bottom: 10px; }
  .kb-filter-controls { flex-direction: column; align-items: stretch; }
  .kb-filter-controls > :not(:last-child) { margin: 0 0 10px; }
  .kb-search-wrap input { width: 100%; }
  .kb-page-controls { flex-wrap: wrap; }
  .kb-page-controls > * { margin-bottom: 10px; }
}
.kb-context { flex: 1 1 auto; min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #63766a; font-size: 12px; }
.kb-head-actions { flex: 0 0 auto; }
.kb-head-actions .kb-icon-btn { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 30px; width: 30px; min-width: 30px; height: 30px; min-height: 30px; max-height: 30px; padding: 0; }
.kb-icon-btn svg { display: block; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.kb-settings-trigger svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; }

.kb-filter-row .kb-pagination { margin: 0 0 0 auto; flex-direction: row; align-items: center; flex-shrink: 0; white-space: nowrap; }
.kb-pagination > span { margin-right: 10px; }
.kb-pagination .kb-page-controls > button { width: 32px; padding: 0; font-size: 18px; }
@media (max-width: 1100px) {
  .kb-filter-row { flex-direction: row; align-items: center; }
  .kb-filter-row > :not(:last-child) { margin-right: 10px; margin-bottom: 10px; }
  .kb-filter-row .kb-pagination { margin-left: auto; }
  .kb-pagination > span { margin: 0 10px 0 0; }
}
@media (max-width: 600px) {
  .kb-filter-row .kb-pagination { flex-wrap: wrap; }
  .kb-pagination .kb-page-controls { flex-wrap: nowrap; }
  .kb-pagination .kb-page-controls > * { margin-bottom: 0; }
}

@media (max-width: 1100px) { .kb-head { flex-direction: row; align-items: center; } .kb-head > :not(:last-child) { margin: 0 10px 0 0; } }
.kb-head { justify-content: space-between; }

/* One spacing owner per row: gap handles both horizontal and wrapped rows. */
.kb-filter-row,.kb-status-tabs,.kb-filter-controls,.kb-card-header,.kb-card-meta,.kb-card-actions,.kb-page-controls { gap:10px; }
.kb-filter-row > :not(:last-child),.kb-status-tabs > :not(:last-child),.kb-filter-controls > :not(:last-child),.kb-card-header > :not(:last-child),.kb-card-meta > :not(:last-child),.kb-card-actions > :not(:last-child),.kb-page-controls > :not(:last-child) { margin:0; }
.kb-status-tabs,.kb-card-meta,.kb-card-actions { margin-bottom:0; }
.kb-status-tabs > *,.kb-card-meta > *,.kb-card-actions > *,.kb-page-controls > * { margin-bottom:0; }
.kb-form-field input,.kb-form-field textarea,.kb-form-field select { padding:10px; }
.kb-empty-title { margin:0 0 10px; }

.experience-table-wrap { max-width:100%;overflow-x:auto;border:1px solid #dce6df;border-radius:8px; }
.experience-table { width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px; }
.experience-table th,.experience-table td { padding:10px;text-align:left;vertical-align:middle;border-bottom:1px solid #e7ece8; }
.experience-table th { background:#f7faf7;color:#4f6658;font-weight:600; }
.experience-table tbody tr:last-child td { border-bottom:0; }
.experience-table tbody tr:hover { background:#f7faf7; }
.experience-select { width:34px;box-sizing:border-box; }
.experience-source-col { width:170px; }
.experience-state-col { width:80px; }
.experience-time-col { width:140px;color:#6b7b71; }
.experience-detail-col { width:40px; }
.experience-summary,.experience-source { display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.experience-mobile-source { display:none; }
.experience-table .kb-status-badge { margin:0; }
@media(max-width:600px){.experience-table .experience-source-col,.experience-table .experience-time-col{display:none}.experience-state-col{width:60px}.experience-detail-col{width:30px}.experience-table .kb-status-badge{padding:0 10px}.experience-mobile-source{display:block;margin-top:10px;font-size:12px;color:#6b7b71;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.experience-summary{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:normal;overflow-wrap:anywhere}}

.kb-select-field{display:inline-flex;flex-direction:row;align-items:center;gap:10px;flex-wrap:nowrap}
.kb-select-field > :not(:last-child){margin:0}
.kb-page-controls .kb-select-field select{margin:0}

.kb-pagination,.kb-page-controls,.kb-pagination .kb-select-field{align-items:center;align-content:center;gap:10px}
.kb-pagination > span,.kb-pagination .kb-select-field > span{display:inline-flex;align-items:center;min-height:30px;line-height:30px;margin:0}
.kb-pagination > :not(:last-child){margin-top:0;margin-bottom:0}
.experience-batch label{flex-direction:row}
.experience-batch label > input[type="checkbox"]{margin:0}
.experience-table td:first-child{min-width:0;max-width:none}
.experience-select{width:36px}
.experience-select input[type="checkbox"]{display:block;width:16px;height:16px;margin:0;padding:0}
.experience-detail-col{width:50px}
@media(max-width:600px){.experience-state-col{width:80px}.experience-detail-col{width:50px}}
</style>
