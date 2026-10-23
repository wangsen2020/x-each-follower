<template>
  <section id="postTrackingSection" class="tab-panel own-posts" data-panel="postTracking" :hidden="activeTab !== 'postTracking'" aria-label="帖子追踪">
    <div class="post-head">
      <div class="post-heading"><div class="post-title-row"><h2>帖子追踪</h2><button class="secondary post-help-trigger" aria-label="帖子追踪使用指南" title="使用指南" @click="openHelp"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3v.1"/></svg></button></div><div class="post-subtitle"><span>{{ data.config?.owner ? '@'+data.config.owner.handle : '待识别账号' }}</span><span class="post-monitor-count" title="最近30条监控">◉ {{ data.monitored || 0 }}/30</span><span class="post-task-state" :class="{'is-cooling':cooling}" :title="statusTitle"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span>{{ taskLabel }}</span><time v-if="data.config?.enabled && data.config?.ownerId && !scanning" :datetime="nextAt ? new Date(nextAt).toISOString() : undefined">{{ countdown }}</time></span></div></div>
      <div class="post-head-icons"><button class="secondary post-refresh-trigger" aria-label="立即更新帖子" :title="manualBlockedUntil>clockNow ? '请求冷却至 '+date(manualBlockedUntil) : '立即更新'" :disabled="busy || loading || manualBlockedUntil>clockNow" @click="refresh(true)"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9"/></svg></button><button class="secondary post-memory-trigger" aria-label="写作记忆" title="写作记忆" @click="openMemory"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 5C9 3 5 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 1Zm0 0v15"/></svg><span v-if="data.learning?.memory?.rules?.length">{{ data.learning.memory.rules.filter(r=>r.enabled).length }}/{{ data.learning.memory.rules.length }}</span></button><button class="secondary post-settings-trigger" aria-label="帖子追踪设置" title="追踪设置" @click="openSettings"><svg viewBox="0 0 24 24" width="16" height="16" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/></svg></button></div>
    </div>
    <div class="follower-tabs" role="tablist" aria-label="帖子价值视图"><button v-for="tab in views" :key="tab.key" class="follower-tab" :class="{active:options.view===tab.key}" role="tab" :aria-selected="options.view===tab.key" @click="changeView(tab.key)">{{ tab.label }} <span>{{ data.counts?.[tab.key] || 0 }}</span></button></div>
    <div class="post-filters">
      <input v-model="options.search" class="post-search" type="search" placeholder="搜索正文或帖子 ID" aria-label="搜索帖子" @input="search">
      <label>范围 <select v-model.number="options.days" :disabled="busy" @change="rangeChanged"><option :value="7">7天</option><option :value="14">14天</option><option :value="28">28天</option><option :value="90">90天</option></select></label>
      <label>类型 <select v-model="options.type" @change="loadFirst"><option value="all">帖子及回复</option><option value="post">仅帖子</option><option value="reply">仅回复</option><option value="auto-quote">自动引用</option></select></label>
      <label>排序 <select v-model="options.sort" @change="loadFirst"><option value="date">发布时间</option><option value="impressions">曝光</option><option value="likes">点赞</option><option value="replies">评论</option><option value="reposts">转帖</option></select></label>
      <button class="secondary" :aria-label="options.direction==='desc'?'改为升序':'改为降序'" @click="toggleDirection">{{ options.direction==='desc'?'降序 ↓':'升序 ↑' }}</button>
      <label><input v-model="options.onlyMonitored" type="checkbox" @change="loadFirst">仅监控最近30条</label>
    </div>
    <div v-if="error || data.meta?.error" class="post-error post-compact-error" role="alert"><span>操作异常</span><button class="secondary" @click="openHelp">详情</button><button class="secondary" :disabled="busy" @click="refresh(true)">重试</button></div>
    <p v-if="notice" role="status" class="post-notice">{{ notice }}</p>
    <nav class="post-pagination" aria-label="帖子分页" :aria-busy="pending">
      <div class="post-list-summary">
        <span class="post-page-summary" role="status">共 {{ data.total || 0 }} 条<span v-if="data.total">，当前 {{ (data.page-1)*options.pageSize+1 }}–{{ (data.page-1)*options.pageSize+data.rows.length }} 条</span></span>
        <div class="post-learning-toolbar" :class="{'is-inactive':!selectedIds.length && !learningRunning}" :inert="!selectedIds.length && !learningRunning" :aria-hidden="!selectedIds.length && !learningRunning"><span class="post-selection-count">已选 {{ selectedIds.length }}/20</span><button class="secondary" :disabled="!selectedIds.length || learningRunning || busy" @click="analyzeSelection('high')">分析优点</button><button class="secondary" :disabled="!selectedIds.length || learningRunning || busy" @click="analyzeSelection('low')">Grok二审</button><button class="secondary post-batch-delete" :disabled="!selectedIds.length || busy || loading || learningRunning" @click="prepareBatch">批量删除</button><button class="secondary" @click="openMemory">写作记忆 {{ data.learning?.memory?.rules?.length || 0 }}</button><span class="post-learning-result"><span v-if="learningRunning" class="post-learning-status" role="status">分析中…</span><span v-else-if="data.learning?.job?.status==='completed'" class="post-learning-status">本轮 +{{ data.learning.job.added }}</span><button v-else-if="['failed','interrupted'].includes(data.learning?.job?.status)" class="secondary" @click="openMemory">未完成</button></span></div>
      </div>
      <div class="post-page-controls">
        <label class="post-page-size">每页<select v-model.number="options.pageSize" aria-label="每页条数" :disabled="pending" @change="loadFirst"><option :value="20">20</option><option :value="50">50</option><option :value="100">100</option></select>条</label>
        <div class="post-page-buttons">
          <button class="secondary" aria-label="上一页" :disabled="pending || data.page<=1" @click="goToPage(data.page-1)">‹</button>
          <template v-for="(item,index) in pageNumbers" :key="index">
            <span v-if="item==='…'" class="post-page-ellipsis" aria-hidden="true">…</span>
            <button v-else class="secondary post-page-number" :class="{'is-current':item===data.page}" :aria-label="`第${item}页`" :aria-current="item===data.page?'page':undefined" :disabled="pending" @click="goToPage(item)">{{ item }}</button>
          </template>
          <button class="secondary" aria-label="下一页" :disabled="pending || data.page>=data.pages" @click="goToPage(data.page+1)">›</button>
        </div>
        <form class="post-page-jump" @submit.prevent="goToPage(jumpPage)"><label>前往<input v-model.number="jumpPage" type="number" min="1" :max="data.pages" step="1" aria-label="跳转页码" :disabled="pending">/ {{ data.pages }} 页</label><button class="secondary" type="submit" :disabled="pending">跳转</button></form>
      </div>
    </nav>
    <div class="post-table-wrap" :aria-busy="busy || loading">
      <table class="post-table"><thead><tr><th class="post-select-col"><input type="checkbox" aria-label="选择本页帖子" :checked="pageAllSelected" :indeterminate="pageSomeSelected && !pageAllSelected" :disabled="!selectableRows.length || busy" @change="selectPage($event.target.checked,$event)"></th><th>帖子</th><th v-for="column in metricColumns" :key="column.key" :aria-sort="options.sort===column.key ? (options.direction==='desc' ? 'descending' : 'ascending') : 'none'"><button class="post-sort-header" :class="{'is-sorted':options.sort===column.key}" :data-sort-key="column.key" :disabled="pending" :aria-label="column.label+'，点击按'+(options.sort===column.key && options.direction==='desc'?'从小到大':'从大到小')+'排序'" @click="sortByMetric(column.key)">{{ column.label }}<svg class="post-sort-icon" viewBox="0 0 10 14" aria-hidden="true"><path d="M5 1 9 6H1Z" :class="{'is-active':options.sort===column.key && options.direction==='asc'}"/><path d="m5 13 4-5H1Z" :class="{'is-active':options.sort===column.key && options.direction==='desc'}"/></svg></button></th><th>价值与监控</th><th>操作</th></tr></thead><tbody>
        <tr v-for="post in data.rows" :key="post.postId" :data-post-id="post.postId">
          <td class="post-select-col"><input type="checkbox" :aria-label="'选择帖子 '+post.postId" :checked="selectedIds.includes(post.postId)" :disabled="!canSelect(post) || busy" @change="selectOne(post.postId,$event.target.checked,$event)"></td>
          <td><a :href="post.url" target="_blank" rel="noopener noreferrer" class="post-excerpt">{{ post.text }}</a><small>{{ date(post.createdAt) }} · {{ post.type==='reply'?'回复':'帖子' }} · 数据更新 {{ date(post.capturedAt) }}</small></td>
          <td>{{ metric(post,'impressions') }}</td><td>{{ metric(post,'likes') }}</td><td>{{ metric(post,'replies') }}</td><td>{{ metric(post,'reposts') }}</td>
          <td><span v-if="post.source" class="post-badge">自动引用</span><span v-if="post.monitored" class="post-badge">最近30条</span><span v-if="post.protected" class="post-badge">已保护</span><span v-if="post.retained" class="post-badge">已保留</span><span v-if="post.grokReview?.keep" class="post-badge positive">Grok建议保留</span><span v-if="post.evaluation.stagnant" class="post-badge">曝光停滞</span><span v-if="post.evaluation.performance==='high'" class="post-badge positive">表现突出</span><span v-if="post.evaluation.performance==='low'" class="post-badge">同龄低曝光</span><span v-if="post.deletion" class="post-badge danger">{{ post.deletion.status=== 'failed' ? '未发出删除请求' : '删除待对账' }}</span><small>{{ post.evaluation.reason }}</small></td>
          <td><div class="post-row-actions">
            <button class="secondary post-action-icon" title="查看详情" aria-label="查看详情" :disabled="loading" @click="open(post)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button>
            <button v-if="!post.deletion || post.deletion.status=== 'failed'" class="secondary post-action-icon" :title="post.protected?'已保护，无法删除':'删除帖子'" aria-label="删除帖子" :disabled="busy || loading || post.protected" @click="prepare(post)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></svg></button>
            <button v-else class="secondary post-action-icon" title="核验删除结果" aria-label="核验删除结果" :disabled="busy || loading" @click="verify(post)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9"/></svg></button>
          </div></td>
        </tr>
      </tbody></table>
      <p v-if="loading && !data.rows?.length" class="post-empty" role="status">正在读取帖子…</p>
      <p v-else-if="!data.rows?.length && !busy" class="post-empty">{{ !data.config?.ownerId ? '先检测一批帖子' : '暂无匹配帖子' }}</p>
    </div>
    <ActionSettingsDrawer ref="memoryDrawer" title="写作记忆"><p v-if="memoryDraft.rules.length" class="post-memory-status">勾选后用于生成评论</p>
      <p v-if="data.learning?.job" class="post-memory-status">{{ learningRunning ? 'Grok 分析中…' : data.learning.job.status==='completed' ? '本轮新增 '+data.learning.job.added+' 条' : '分析未完成' }}</p><p v-if="data.learning?.job?.memorySkipped" class="post-memory-status">特点已满，跳过 {{ data.learning.job.memorySkipped }} 条；二审结果已保留。</p><p v-if="data.learning?.job?.error" class="post-help-error post-memory-status">{{ data.learning.job.error }}</p>
      <p v-if="!memoryDraft.rules.length" class="post-memory-status">选择帖子，分析优点或缺点。</p>
      <section v-for="rule in memoryDraft.rules" :key="rule.id" class="post-memory-card"><div class="post-memory-head"><label><input v-model="rule.enabled" type="checkbox" :disabled="learningRunning">{{ rule.kind==='high' ? '借鉴' : '回避' }}</label><button class="secondary" :disabled="learningRunning" @click="memoryDraft.rules=memoryDraft.rules.filter(r=>r.id!==rule.id)">移除</button></div><textarea v-model="rule.text" maxlength="240" :disabled="learningRunning" aria-label="写作特点"></textarea><p class="post-memory-reason">{{ rule.reason }}</p><div class="post-memory-sources"><a v-for="id in rule.evidencePostIds" :key="id" :href="'https://x.com/i/status/'+id" target="_blank" rel="noopener noreferrer">{{ id }}</a></div></section>
      <p v-if="error" class="post-help-error post-memory-status">{{ error }}</p>
      <template #footer><button class="secondary" @click="reloadMemory">重新读取</button><button :disabled="busy || learningRunning" @click="saveMemory">保存记忆</button></template>
    </ActionSettingsDrawer>
    <ActionSettingsDrawer ref="settingsDrawer" title="帖子追踪设置">
      <section class="post-setting-section"><h3>定时监测</h3><div class="post-setting-card"><label class="post-setting-switch"><span>帖子指标检测</span><input v-model="settingsDraft.enabled" type="checkbox" :disabled="busy" role="switch" aria-label="帖子指标定时检测"></label><label class="post-setting-field"><span>检测间隔</span><select v-model.number="settingsDraft.intervalMinutes" :disabled="busy" aria-label="帖子检测间隔"><option :value="15">15分钟</option><option :value="30">30分钟</option><option :value="60">60分钟</option></select></label><label class="post-setting-field"><span>每批上限</span><input v-model.number="settingsDraft.batchLimit" type="number" min="10" max="1000" step="1" :disabled="busy" aria-label="每批检测上限"></label><label class="post-setting-field"><span>复查周期</span><select v-model.number="settingsDraft.reviewIntervalHours" :disabled="busy" aria-label="待二审复查周期"><option :value="12">12小时</option><option :value="24">24小时</option><option :value="48">48小时</option></select></label></div></section>
      <section class="post-setting-section"><h3>低质帖<button class="secondary post-help-trigger" aria-label="低质帖判定说明" title="判定说明" @click="openHelp"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3v.1"/></svg></button></h3><div class="post-setting-card"><label v-for="field in LOW_RULE_FIELDS" :key="field.key" class="post-setting-field" :title="field.hint"><span>{{ field.label }} · {{ field.unit }} <span class="info-tip" tabindex="0" role="note" :data-tip="field.hint" :aria-label="field.hint">?</span></span><input v-model.number="settingsDraft.lowRules[field.key]" type="number" :min="field.min" :max="field.max" step="1" :disabled="busy" :aria-label="field.label"></label></div></section>
      <p v-if="error || data.meta?.error" class="post-help-error post-settings-error" role="alert">{{ error || data.meta.error }}</p>
      <p v-if="settingsFeedback" class="post-settings-feedback" role="status">{{ settingsFeedback }}</p><template #footer><button class="secondary" :disabled="busy || loading || !data.config?.ownerId || manualBlockedUntil > clockNow" title="一次请求最近90天，最多1000条；日常检测保持分批" @click="executeSettings(true)">补齐90天</button><button class="secondary" :disabled="busy || loading || manualBlockedUntil > clockNow" :title="manualBlockedUntil > clockNow ? '请求冷却至 '+date(manualBlockedUntil) : settingsDirty ? '保存当前配置并检测一批' : '立即检测一批'" @click="executeSettings(false)">{{ scanning ? '执行中…' : '立即执行' }}</button><button :disabled="busy || !settingsDirty" @click="saveSettings">{{ busy && !scanning ? '保存中…' : '保存配置' }}</button></template>
    </ActionSettingsDrawer>
    <ActionSettingsDrawer ref="helpDialog" title="使用指南">
      <section v-for="item in postHelpSections" :key="item.id" class="post-help-section"><h3>{{ item.title }}</h3><p v-for="paragraph in item.paragraphs" :key="paragraph">{{ paragraph }}</p></section>
      <section class="post-help-section"><h3>检测详情</h3><dl class="post-help-details"><div><dt>状态</dt><dd>{{ taskLabel }}<template v-if="data.config?.enabled && data.config?.ownerId"> · {{ countdown }}</template></dd></div><div><dt>最近检测</dt><dd>{{ date(data.meta?.updatedAt) }}</dd></div><div><dt>下次检测</dt><dd>{{ data.config?.enabled ? date(nextAt) : '已暂停' }}</dd></div><div><dt>本批数据</dt><dd>{{ data.meta?.coverage?.received || 0 }} 条 · {{ data.meta?.scanner?.batches || 0 }} 批</dd></div><div v-if="data.meta?.scanner?.last"><dt>任务</dt><dd>{{ laneName(data.meta.scanner.last.lane) }}</dd></div><div v-if="data.meta?.scanner?.last"><dt>窗口</dt><dd>{{ date(data.meta.scanner.last.from) }} — {{ date(data.meta.scanner.last.to) }}</dd></div><div v-if="data.meta?.coverage?.split"><dt>进度</dt><dd>本批已达上限，后续拆分窗口继续。</dd></div><div v-if="error || data.meta?.error"><dt>异常</dt><dd class="post-help-error">{{ error || data.meta.error }}</dd></div></dl></section>
    </ActionSettingsDrawer>
    <ActionSettingsDrawer ref="detailDrawer" title="帖子详情" @close="selected=null">
      <template v-if="selected">
        <section class="post-detail-section"><h3>帖子内容</h3><p class="post-fulltext">{{ selected.text }}</p><a :href="selected.url" target="_blank" rel="noopener noreferrer">在 X 打开原文</a><p v-if="selected.source?.originalPostUrl"><a :href="selected.source.originalPostUrl" target="_blank" rel="noopener noreferrer">查看被引用的原帖</a></p></section>
        <section class="post-detail-section"><h3>数据表现</h3><div class="post-detail-metrics"><span>曝光 {{ metric(selected,'impressions') }}</span><span>点赞 {{ metric(selected,'likes') }}</span><span>评论 {{ metric(selected,'replies') }}</span><span>转帖 {{ metric(selected,'reposts') }}</span></div><p class="post-muted">更新 {{ date(selected.capturedAt) }}</p><p class="post-muted">{{ selected.evaluation.reason }} · 同龄样本 {{ selected.evaluation.sampleSize }} 条</p></section>
        <section class="post-detail-section"><div class="post-detail-section-head"><h3>Grok二审</h3><button class="secondary" :disabled="busy || learningRunning || (selected.deletion && selected.deletion.status!=='failed')" @click="analyzePost(selected)">{{ selectedAnalyzing?'分析中…':selected.grokReview?'重新分析':'分析' }}</button></div><template v-if="selected.grokReview?.keep"><span class="post-badge positive">建议保留 · {{ selected.grokReview.score }}/10</span><p class="post-grok-advice">{{ selected.grokReview.reason }}</p></template><p v-else class="post-muted">{{ selected.grokReview?'已分析，暂无保留建议':'尚未分析' }}</p><p v-if="selected.grokReview" class="post-muted">{{ date(selected.grokReview.analyzedAt) }}</p></section>
        <section class="post-detail-section"><h3>监控快照</h3><p v-if="selected.snapshots.length<2" class="post-muted">尚无足够历史，不能判断长期停滞。</p><ul class="post-snapshots"><li v-for="snapshot in selected.snapshots.slice(-8).reverse()" :key="snapshot.at">{{ date(snapshot.at) }} · 曝光 {{ snapshot.metrics.impressions ?? '待更新' }} · 点赞 {{ snapshot.metrics.likes ?? '待更新' }} · 评论 {{ snapshot.metrics.replies ?? '待更新' }}</li></ul></section>
        <p v-if="error" class="post-error" role="alert">{{ error }}</p><p v-if="notice" class="post-muted" role="status">{{ notice }}</p>
      </template>
      <template v-if="selected" #footer><span class="post-review-state">{{ selected.protected?'已保护':selected.retained?'已保留':'' }}</span><button class="secondary" :disabled="busy || (selected.deletion && selected.deletion.status!=='failed')" @click="retain(selected)">{{ selected.retained?'取消保留':'保留' }}</button><button class="secondary" :disabled="busy || (selected.deletion && selected.deletion.status!=='failed')" @click="protect(selected)">{{ selected.protected?'解除保护':'保护保留' }}</button><button class="secondary post-batch-delete" :disabled="busy || selected.protected || (selected.deletion && selected.deletion.status!=='failed')" @click="prepareFromDetail(selected)">删除…</button></template>
    </ActionSettingsDrawer>
    <div v-if="batchApproval" class="post-overlay"><section class="post-dialog" role="dialog" aria-modal="true" aria-labelledby="post-batch-delete-title"><h2 id="post-batch-delete-title">永久删除所选 {{ batchApproval.items.length }} 条帖子？</h2><p>账号 @{{ batchApproval.owner.handle }}</p><ol class="post-batch-delete-list"><li v-for="item in batchApproval.items" :key="item.postId"><a :href="item.url" target="_blank" rel="noopener noreferrer">{{ item.postId }}</a><p class="post-fulltext">{{ item.text }}</p></li></ol><p class="post-error">帖子和互动无法恢复。逐条核验并删除；遇到失败或结果待核验时停止，其余帖子不继续删除。</p><div class="post-actions"><button class="secondary" :disabled="busy" @click="batchApproval=null">取消</button><button class="post-delete" :disabled="busy" @click="confirmBatchDeletion">{{ busy?'正在逐条删除…':'确认批量删除' }}</button></div><p v-if="error" class="post-error" role="alert">{{ error }}</p></section></div>
    <div v-if="batchResult" class="post-overlay"><section class="post-dialog" role="dialog" aria-modal="true" aria-labelledby="post-batch-result-title"><h2 id="post-batch-result-title">{{ batchResult.status==='completed'?'批量删除完成':'批量删除已停止' }}</h2><p>已核验删除 {{ batchResult.results.filter(r=>r.status==='verified').length }} 条 · 未继续执行 {{ batchResult.remaining }} 条</p><ul class="post-batch-delete-list"><li v-for="item in batchResult.results" :key="item.postId">{{ item.postId }} · {{ item.status==='verified'?'已核验删除':item.status==='not-sent'||item.status==='failed'?'未发出删除':'待核验' }}<p v-if="item.error" class="post-error">{{ item.error }}</p></li></ul><div class="post-actions"><button class="secondary" @click="batchResult=null">关闭</button></div></section></div>
    <div v-if="approval" class="post-overlay"><section class="post-dialog" role="dialog" aria-modal="true" aria-labelledby="post-delete-title"><h2 id="post-delete-title">确认永久删除这条帖子？</h2><p>账号 @{{ approval.owner.handle }} · {{ approval.postId }}</p><p class="post-fulltext">{{ approval.text }}</p><p class="post-error">原帖链接和互动无法恢复。仅删除上面这条自己的帖子，不删除引用的原帖。</p><div class="post-actions"><button class="secondary" :disabled="busy" @click="approval=null">取消</button><button class="post-delete" :disabled="busy" @click="confirmDeletion">{{ busy?'正在核验…':'确认永久删除' }}</button></div></section></div>
  </section>
</template>

<script setup>
import {ref, reactive, computed, watch, nextTick, onMounted, onUnmounted} from 'vue';
import ActionSettingsDrawer from '../components/ActionSettingsDrawer.vue';
import {LOW_RULE_FIELDS,normalizeLowRules,validateLowRules} from '../../../features/post-tracking/post-rules.js';
import {postHelpSections} from '../../../features/post-tracking/post-help.js';
import {panelNavigationController} from '../composables/usePanelNavigation.js';
const {activeTab}=panelNavigationController;
const data=ref({rows:[],counts:{},config:{},page:1,pages:1});
const options=reactive({view:'latest',search:'',sort:'date',direction:'desc',type:'all',page:1,pageSize:20,days:14,onlyMonitored:false});
const metricColumns=[{key:'impressions',label:'曝光'},{key:'likes',label:'点赞'},{key:'replies',label:'评论'},{key:'reposts',label:'转帖'}];
const views=[{key:'latest',label:'最新帖子'},{key:'low',label:'低价值'},{key:'high',label:'高价值'}];
const busy=ref(false),loading=ref(false),error=ref(''),notice=ref(''),selected=ref(null),approval=ref(null);
const detailDrawer=ref(null);
const jumpPage=ref(1),helpDialog=ref(null),clockNow=ref(Date.now()),scanning=ref(false);
const batchApproval=ref(null),batchResult=ref(null);
const selectedIds=ref([]),memoryDrawer=ref(null),memoryDraft=ref({ownerId:'',revision:0,rules:[]});
const learningRunning=computed(()=>data.value.learning?.job?.status==='running');
const selectedAnalyzing=computed(()=>learningRunning.value&&data.value.learning?.job?.samples?.some(p=>p.postId===selected.value?.postId));
const canSelect=post=>!!post.text&&!post.protected&&(!post.deletion||post.deletion.status==='failed');
const selectableRows=computed(()=>data.value.rows.filter(canSelect));
const pageAllSelected=computed(()=>selectableRows.value.length>0&&selectableRows.value.every(p=>selectedIds.value.includes(p.postId)));
const pageSomeSelected=computed(()=>selectableRows.value.some(p=>selectedIds.value.includes(p.postId)));
function selectOne(id,checked,event){if(checked&&!selectedIds.value.includes(id)){if(selectedIds.value.length>=20){notice.value='最多选择20条';if(event)event.target.checked=false;return;}selectedIds.value=[...selectedIds.value,id];}else if(!checked)selectedIds.value=selectedIds.value.filter(x=>x!==id);}
function selectPage(checked,event){if(!checked){const ids=new Set(selectableRows.value.map(p=>p.postId));selectedIds.value=selectedIds.value.filter(id=>!ids.has(id));return;}const ids=[...new Set([...selectedIds.value,...selectableRows.value.map(p=>p.postId)])];if(ids.length>20){notice.value='最多选择20条，请逐条选择';if(event)event.target.checked=false;return;}selectedIds.value=ids;}
async function analyzeSelection(kind){await work(async()=>{await request('learn',{ownerId:data.value.config.ownerId,kind,postIds:[...selectedIds.value]});selectedIds.value=[];await load();notice.value='已提交 Grok';});}
function openMemory(){memoryDraft.value=structuredClone(data.value.learning?.memory?JSON.parse(JSON.stringify(data.value.learning.memory)):{ownerId:data.value.config?.ownerId,revision:0,rules:[]});memoryDrawer.value.open();}
async function reloadMemory(){await load();openMemory();}
async function saveMemory(){await work(async()=>{await request('saveMemory',{ownerId:memoryDraft.value.ownerId,revision:memoryDraft.value.revision,rules:memoryDraft.value.rules.map(r=>({id:r.id,text:r.text,enabled:r.enabled}))});await load();memoryDrawer.value.close();notice.value='记忆已保存';});}
const settingsFeedback=ref('');
const settingsDrawer=ref(null),settingsDraft=reactive({enabled:false,intervalMinutes:15,batchLimit:100,reviewIntervalHours:24,lowRules:normalizeLowRules()});
const settingsDirty=computed(()=>JSON.stringify(settingsDraft.lowRules)!==JSON.stringify(normalizeLowRules(data.value.config?.lowRules))||settingsDraft.enabled!==(data.value.config?.enabled===true)||settingsDraft.intervalMinutes!==(data.value.config?.intervalMinutes||15)||settingsDraft.batchLimit!==(data.value.config?.batchLimit||100)||settingsDraft.reviewIntervalHours!==(data.value.config?.reviewIntervalHours||24));
function openSettings(){settingsFeedback.value='';settingsDraft.lowRules=normalizeLowRules(data.value.config?.lowRules);settingsDraft.enabled=data.value.config?.enabled===true;settingsDraft.intervalMinutes=data.value.config?.intervalMinutes||15;settingsDraft.batchLimit=data.value.config?.batchLimit||100;settingsDraft.reviewIntervalHours=data.value.config?.reviewIntervalHours||24;settingsDrawer.value.open();}
function checkedSettings(){validateLowRules(settingsDraft.lowRules);if(!Number.isInteger(settingsDraft.batchLimit)||settingsDraft.batchLimit<10||settingsDraft.batchLimit>1000)throw new Error('每批上限需为10–1000的整数');return {enabled:settingsDraft.enabled,intervalMinutes:settingsDraft.intervalMinutes,batchLimit:settingsDraft.batchLimit,reviewIntervalHours:settingsDraft.reviewIntervalHours,lowRules:{...settingsDraft.lowRules}};}
async function saveSettings(){await work(async()=>{await request('settings',checkedSettings());await load();settingsDrawer.value.close();notice.value='配置已保存';});}
async function executeSettings(history=false){await work(async()=>{settingsFeedback.value='';const values=checkedSettings();if(settingsDirty.value)await request('settings',values);scanning.value=true;try{const result=await request('sync',{days:options.days,history});if(history&&!result.accountUpdated){options.days=90;options.page=1;}await load();settingsFeedback.value=result.accountUpdated?'当前账号已更新，请再次执行':history?(result.historyComplete?'90天已更新 '+result.received+' 条'+(result.coverage?.unavailable?' · 数据不可用 '+result.coverage.unavailable+' 条':''):'已导入 '+result.received+' 条，达到上限，历史尚未补齐'):result.split?'本批已达上限，窗口已拆分':'已更新 '+result.received+' 条 · 低价值 '+(data.value.counts?.low||0)+' 条';notice.value=settingsFeedback.value;}finally{scanning.value=false;await load();}});}
const nextAt=computed(()=>Math.max(data.value.config?.nextBatchAt||0,data.value.config?.retryAfter||0));
const manualBlockedUntil=computed(()=>Math.max(data.value.config?.retryAfter||0,data.value.config?.lastAttemptAt?data.value.config.lastAttemptAt+120000:0));
const cooling=computed(()=>(data.value.config?.retryAfter||0)>clockNow.value);
const taskLabel=computed(()=>scanning.value?'检测中':!data.value.config?.ownerId?(data.value.meta?.error?'同步失败':'待同步'):!data.value.config?.enabled?'已暂停':cooling.value?'冷却':'下次');
const countdown=computed(()=>{const seconds=Math.max(0,Math.ceil((nextAt.value-clockNow.value)/1000));const minutes=Math.floor(seconds/60);return String(minutes).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');});
const statusTitle=computed(()=>data.value.config?.enabled?'下次检测 '+date(nextAt.value):taskLabel.value);
function openHelp(){helpDialog.value?.open();}

const pending=computed(()=>busy.value||loading.value);
const pageNumbers=computed(()=>{
  const current=data.value.page||1,total=data.value.pages||1;
  const numbers=[...new Set([1,total,current-1,current,current+1].filter(n=>n>=1&&n<=total))].sort((a,b)=>a-b);
  const result=[];for(const n of numbers){const last=result.at(-1);if(typeof last==='number'&&n-last>1){if(n-last===2)result.push(last+1);else result.push('…');}result.push(n);}return result;
});
let generation=0,searchTimer,timer,clockTimer,noticeTimer,initialAttempted=false,rangeInitialized=false;
const date=v=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'尚未同步';
function metric(p,key){return p.availability === 'unavailable' || p.metrics[key] == null ? '待更新' : p.metrics[key].toLocaleString('zh-CN');}
async function request(op,args={}){const result=await chrome.runtime.sendMessage({cmd:'ownPostTracking',op,...args});if(!result?.ok)throw new Error(result?.error||'请求没有返回结果');return result;}
async function load(){const token=++generation,requestedSelectedIds=[...selectedIds.value];loading.value=true;try{let result=await request('page',{options:{...options,selectedPostIds:requestedSelectedIds}});if(!rangeInitialized&&token===generation){rangeInitialized=true;const savedDays=Number(result.config?.days);if([7,14,28,90].includes(savedDays)&&savedDays!==options.days){options.days=savedDays;result=await request('page',{options:{...options,selectedPostIds:requestedSelectedIds}});}}if(token===generation){if(data.value.config?.ownerId!==result.config?.ownerId){approval.value=null;batchApproval.value=null;batchResult.value=null;selected.value=null;selectedIds.value=[];memoryDrawer.value?.close();detailDrawer.value?.close();}else if(requestedSelectedIds.length){const valid=new Set(result.selectedPostIds||[]),requested=new Set(requestedSelectedIds),before=selectedIds.value.length;selectedIds.value=selectedIds.value.filter(id=>!requested.has(id)||valid.has(id));if(before>selectedIds.value.length)notice.value=`已移除 ${before-selectedIds.value.length} 条不可删除的勾选`;}data.value=result;if(selected.value){const current=result.rows?.find(p=>p.postId===selected.value.postId);if(current)selected.value=current;}options.page=result.page;jumpPage.value=result.page;}}catch(e){if(token===generation)error.value=e.message;}finally{if(token===generation)loading.value=false;}}
async function work(fn){if(busy.value)return;busy.value=true;error.value='';try{await fn();}catch(e){error.value=e.message;}finally{busy.value=false;}}
async function refresh(sync=false){await work(async()=>{try{if(sync){scanning.value=true;error.value='';notice.value='';const r=await request('sync',{days:options.days});notice.value=r.accountUpdated?'当前账号已更新':r.split?'窗口已拆分':`已更新 ${r.received} 条`;}await load();}finally{scanning.value=false;await load();}});}
function changeView(v){selectedIds.value=[];options.view=v;options.sort=v==='latest'?'date':'impressions';options.direction=v==='low'?'asc':'desc';loadFirst();}
function loadFirst(){clearTimeout(searchTimer);options.page=1;load();}
function search(){clearTimeout(searchTimer);searchTimer=setTimeout(loadFirst,200);}
function goToPage(value){if(pending.value)return;const page=Number(value);if(!Number.isInteger(page)||page<1||page>data.value.pages){jumpPage.value=data.value.page;notice.value=`页码范围：1–${data.value.pages}`;return;}if(page===data.value.page)return;clearTimeout(searchTimer);options.page=page;load();}
function sortByMetric(key){if(pending.value)return;options.direction=options.sort===key && options.direction==='desc'?'asc':'desc';options.sort=key;loadFirst();}
function toggleDirection(){options.direction=options.direction==='desc'?'asc':'desc';loadFirst();}
async function rangeChanged(){options.page=1;await work(async()=>{await request('settings',{days:options.days});await load();notice.value='范围已更新';});}
const laneName=lane=>({head:'新帖快速检测',recent:'最近30条优先',review:'待二审复查',history:'历史轮巡'}[lane] || lane);
async function open(post){error.value='';notice.value='';selected.value=post;await nextTick();detailDrawer.value.open();}
async function decide(post,key,value,message){await work(async()=>{await request('mark',{postId:post.postId,expectedText:post.text,[key]:value});if(selected.value?.postId===post.postId)selected.value={...selected.value,[key]:value};await load();notice.value=message;});}
async function protect(post){return decide(post,'protected',!post.protected,post.protected?'已解除保护':'已保护保留');}
async function retain(post){return decide(post,'retained',!post.retained,post.retained?'已取消保留':'已保留');}
async function analyzePost(post){await work(async()=>{await request('learn',{ownerId:data.value.config.ownerId,kind:'low',postIds:[post.postId]});await load();notice.value='已提交 Grok二审';});}
async function prepareFromDetail(post){detailDrawer.value.close();selected.value=null;await prepare(post);}
async function prepareBatch(){await work(async()=>{const before=[...selectedIds.value];await load();if(before.length!==selectedIds.value.length){notice.value='勾选中有帖子已不可删除，请重新核对';return;}if(!selectedIds.value.length)return;batchApproval.value=await request('prepareBatchDelete',{postIds:[...selectedIds.value]});batchResult.value=null;});}
async function confirmBatchDeletion(){if(!batchApproval.value)return;const id=batchApproval.value.batchApprovalId;await work(async()=>{const result=await request('confirmBatchDelete',{batchApprovalId:id,confirmed:true});batchResult.value=result;batchApproval.value=null;selectedIds.value=[];await load();});}
async function prepare(post){await work(async()=>{approval.value=await request('prepareDelete',{postId:post.postId});});}
async function confirmDeletion(){if(!approval.value)return;const id=approval.value.approvalId;await work(async()=>{const result=await request('confirmDelete',{approvalId:id,confirmed:true});approval.value=null;notice.value=result.deletion.status==='verified'?'已核验删除完成':result.deletion.status==='failed'?'删除未发出':'删除待核验';await load();});}
async function verify(post){await work(async()=>{await request('verify',{postId:post.postId});await load();notice.value='核验已更新';});}
async function enterTracking(){await load();if(activeTab.value==='postTracking'&&!initialAttempted&&!data.value.config?.ownerId&&!data.value.meta?.error&&manualBlockedUntil.value<=Date.now()){initialAttempted=true;await refresh(true);}}
watch(activeTab,tab=>{if(tab==='postTracking')enterTracking();else {helpDialog.value?.close();settingsDrawer.value?.close();memoryDrawer.value?.close();detailDrawer.value?.close();}},{immediate:true});
watch(()=>data.value.learning?.job?.status,(status,previous)=>{if(previous==='running'&&status!=='running')notice.value=status==='completed'?'Grok结果已更新':'分析未完成，查看写作记忆';});
watch(notice,()=>{clearTimeout(noticeTimer);if(notice.value)noticeTimer=setTimeout(()=>{notice.value='';},5000);});
onMounted(()=>{clockTimer=setInterval(()=>{clockNow.value=Date.now();},1000);let ticks=0;timer=setInterval(()=>{ticks++;if(activeTab.value==='postTracking'&&!document.hidden&&!busy.value&&!loading.value&&(learningRunning.value||ticks%15===0))load();},2000);});
onUnmounted(()=>{clearInterval(timer);clearInterval(clockTimer);clearTimeout(noticeTimer);clearTimeout(searchTimer);generation++;});
</script>

<style scoped>
.own-posts {
  --post-space: 10px;
  --post-control-height: 30px;
  --post-border: #dce7df;
  padding: var(--post-space);
  color: #18302e;
  background: #fff;
  border: 1px solid var(--post-border);
  border-radius: 10px;
}
#postTrackingSection { grid-column: 2; grid-row: 2; display: flex; flex-direction: column; height: 100%; min-height: 0; max-height: 100%; min-width: 0; box-sizing: border-box; overflow: hidden; }
#postTrackingSection[hidden] { display: none; }
.own-posts button, .own-posts select, .own-posts input:not([type="checkbox"]) { display: inline-block; height: var(--post-control-height); min-height: var(--post-control-height); max-height: var(--post-control-height); box-sizing: border-box; font-size: 12px; line-height: var(--post-control-height); padding: 0 10px; border-radius: 6px; }
.own-posts button { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.own-posts select { appearance: none; -webkit-appearance: none; padding-right: 26px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='m3 4.5 3 3 3-3' fill='none' stroke='%2352675d' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 7px center; background-size: 12px 12px; }
.own-posts input[type="checkbox"] { width: 16px; height: 16px; min-width: 16px; min-height: 16px; margin: 0 8px 0 0; flex-shrink: 0; accent-color: #245b45; }
.own-posts label { display: inline-flex; flex-direction: row; align-items: center; white-space: nowrap; line-height: var(--post-control-height); font-size: 12px; }
.own-posts label > input, .own-posts label > select, .own-posts label > textarea { margin-top: 0; margin-bottom: 0; }
.own-posts label > :not(:last-child) { margin-bottom: 0; }
.post-head, .post-actions, .post-filters, .post-pagination, .post-page-controls, .post-page-buttons, .post-page-jump { display: flex; align-items: center; }
.post-head, .post-filters, .follower-tabs, .post-pagination { flex-shrink: 0; }
.post-head { justify-content: space-between; flex-wrap: wrap; margin-bottom: 10px; }
.post-title-row, .post-subtitle, .post-task-state, .post-head-icons { display: flex; align-items: center; }
.post-title-row > :not(:last-child), .post-subtitle > :not(:last-child), .post-head-icons > :not(:last-child) { margin-right: 10px; }
.post-subtitle { flex-wrap: wrap; color: #63766a; font-size: 11px; line-height: 20px; }
.post-task-state { white-space: nowrap; }
.post-task-state > :not(:last-child) { margin-right: 5px; }
.post-task-state svg, .post-help-trigger svg, .post-settings-trigger svg, .post-memory-trigger svg, .post-refresh-trigger svg { display: block; width: 16px; height: 16px; min-width: 16px; max-width: 16px; min-height: 16px; max-height: 16px; flex: 0 0 16px; aspect-ratio: 1; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.post-task-state svg { width: 14px; height: 14px; min-width: 14px; max-width: 14px; min-height: 14px; max-height: 14px; flex-basis: 14px; }
.post-head-icons { margin-left: auto; }
.own-posts .post-refresh-trigger { width: 30px; min-width: 30px; padding: 0; }
.own-posts .post-memory-trigger { min-width: 30px; padding: 0 6px; }
.post-memory-trigger svg { margin-right: 5px; }
.post-task-state time { min-width: 5ch; font-variant-numeric: tabular-nums; }
.post-task-state.is-cooling { color: #976417; }
.own-posts .post-help-trigger { width: 30px; min-width: 30px; padding: 0; border: 0; background: transparent; color: #63766a; }
.post-help-trigger:hover { background: #eef4ef; color: #245b45; }
.post-help-trigger:focus-visible, .post-settings-trigger:focus-visible { outline: 2px solid #245b45; }
.own-posts .post-settings-trigger { width: 30px; min-width: 30px; padding: 0; color: #63766a; }
.post-setting-section { margin-bottom: 10px; }
.post-setting-section h3 { display: flex; align-items: center; justify-content: space-between; margin: 0 0 10px; font-size: 12px; color: #1d5c3a; }
.post-setting-card { padding: 10px; border: 1px solid #e5ede7; border-radius: 8px; background: #f9fbf9; }
.own-posts .post-setting-switch, .own-posts .post-setting-field { display: flex; align-items: center; justify-content: flex-start; flex-direction: row; flex-wrap: nowrap; width: 100%; height: auto; min-height: var(--post-control-height); box-sizing: border-box; font-size: 12px; line-height: var(--post-control-height); }
.own-posts .post-setting-field > span, .own-posts .post-setting-switch > span { min-width: 9em; max-width: calc(100% - 126px); line-height: 20px; text-align: start; overflow-wrap: anywhere; }
.post-setting-card > :not(:last-child) { margin-bottom: 10px; }
.own-posts .post-setting-switch input { margin: 0 0 0 10px; }
.post-setting-field > :not(:first-child) { margin-left: 10px; }
.post-setting-field select, .post-setting-field input[type="number"] { width: 116px; }
.post-settings-status { margin: 0; font-size: 12px; }
.post-settings-status > div { display: flex; align-items: baseline; margin-bottom: 10px; }
.post-settings-status dt { flex: 0 0 6em; color: #63766a; }
.post-settings-status dd { margin: 0 0 0 10px; overflow-wrap: anywhere; }
.post-settings-feedback { margin: 10px 0 0; font-size: 12px; line-height: 1.6; color: #245b45; }
.post-settings-error { font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.post-head h2 { font-size: 14px; line-height: 22px; margin: 0; }
.post-head .post-muted { margin: 4px 0 0; }
.post-actions { flex-wrap: wrap; }
.post-actions > :not(:last-child) { margin-right: 10px; }
.post-actions > label { height: var(--post-control-height); }
.post-actions > label > select { margin-left: 10px; }
.follower-tabs { margin: 0 0 10px; }
.follower-tabs > :not(:last-child) { margin-right: 10px; }
.post-filters { flex-wrap: wrap; margin: 0 -10px 0 0; }
.post-filters > * { margin: 0 10px 10px 0; }
.post-filters > label { height: var(--post-control-height); }
.post-filters > label > select { margin-left: 10px; }
.post-filters .post-search { flex: 1 1 220px; min-width: 180px; max-width: 300px; margin: 0 10px 10px 0; }
.post-muted, .post-table small { color: #63766a; font-size: 11px; line-height: 18px; }
.post-muted { margin: 0 0 10px; flex-shrink: 0; }
.post-error, .post-notice { margin: 0 0 10px; font-size: 12px; line-height: 18px; flex-shrink: 0; }
.post-notice { color: #315f4b; }
.post-error { color: #a52e3c; background: #fff2f2; padding: 10px; border-radius: 6px; }
.post-error button { margin-left: 10px; }
.post-table-wrap { flex: 1; min-height: 0; overflow: auto; background: #fff; border: 1px solid var(--post-border); border-radius: 8px; }
.post-table { width: 100%; min-width: 900px; border-collapse: collapse; text-align: left; font-size: 12px; }
.post-table th, .post-table td { padding: 8px 10px; border-bottom: 1px solid #e7eee8; vertical-align: middle; }
.post-table th { position: sticky; top: 0; z-index: 1; height: var(--post-control-height); box-sizing: border-box; padding-top: 0; padding-bottom: 0; border-bottom: 0; box-shadow: inset 0 -1px 0 #e7eee8; background: #f0f5ef; color: #4e6558; font-size: 12px; font-weight: 600; }
.own-posts .post-sort-header { width: 100%; justify-content: flex-end; padding: 0; border: 0; border-radius: 4px; background: transparent; color: inherit; font-family: inherit; font-size: inherit; font-weight: inherit; cursor: pointer; }
.post-sort-header.is-sorted { color: #245b45; }
.post-sort-header:focus-visible { outline: 2px solid #245b45; outline-offset: 2px; }
.post-sort-icon { width: 10px; height: 14px; margin-left: 5px; flex-shrink: 0; fill: currentColor; }
.post-sort-icon path { opacity: .3; }
.post-sort-icon path.is-active { opacity: 1; }
.post-table tbody tr:last-child td { border-bottom: 0; }
.post-table tbody tr:hover { background: #f8fbf8; }
.post-table th:nth-child(2), .post-table td:nth-child(2) { width: 40%; min-width: 270px; max-width: none; }
.post-table th:nth-child(n+3):nth-child(-n+6), .post-table td:nth-child(n+3):nth-child(-n+6) { width: 64px; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.post-table th:nth-child(7), .post-table td:nth-child(7) { min-width: 160px; }
.post-table th:last-child, .post-table td:last-child { width: 190px; min-width: 190px; }
.post-excerpt { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; color: #254c3b; font-weight: 500; text-decoration: none; line-height: 18px; }
.post-excerpt:hover { text-decoration: underline; }
.post-table small { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-top: 5px; }
.post-select-col { width: 30px; min-width: 30px; text-align: center; }
.own-posts .post-select-col input { margin: 0; }
.post-list-summary { display: flex; flex-wrap: wrap; align-items: center; min-width: 0; max-width: 100%; min-height: var(--post-control-height); }
.post-learning-toolbar { display: flex; flex-wrap: nowrap; align-items: center; height: var(--post-control-height); max-width: 100%; overflow-x: auto; }
.post-learning-toolbar.is-inactive { visibility: hidden; pointer-events: none; }
.post-learning-toolbar > * { flex-shrink: 0; white-space: nowrap; }
.post-learning-toolbar .post-selection-count { width: 65px; font-variant-numeric: tabular-nums; }
.post-learning-result { display: inline-flex; align-items: center; width: 70px; height: var(--post-control-height); }
.post-batch-delete { color: #b42336; }
.post-batch-delete-list { max-height: 40vh; overflow-y: auto; padding-left: 20px; }
.post-batch-delete-list li { margin-bottom: 10px; overflow-wrap: anywhere; }
.post-learning-toolbar > :not(:last-child) { margin-right: 10px; }
.post-selection-count, .post-learning-status, .post-memory-status { font-size: 12px; color: #63766a; }
.post-memory-status { margin: 0 0 10px; overflow-wrap: anywhere; }
.post-memory-card { padding: 10px; margin-bottom: 10px; border: 1px solid #e5ede7; border-radius: 8px; }
.post-memory-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.post-memory-card textarea { display: block; box-sizing: border-box; width: 100%; min-height: 80px; padding: 10px; font-size: 12px; line-height: 20px; resize: vertical; }
.post-memory-reason { color: #63766a; font-size: 11px; line-height: 18px; margin: 10px 0; }
.post-memory-sources { display: flex; flex-wrap: wrap; }
.post-memory-sources a { font-size: 11px; margin: 0 10px 5px 0; }
.post-row-actions { display: flex; align-items: center; }
.post-row-actions > :not(:last-child) { margin-right: 10px; }
.post-row-actions button { white-space: nowrap; }
.post-row-actions .post-action-icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 30px; width: 30px; min-width: 30px; height: 30px; min-height: 30px; max-height: 30px; padding: 0; line-height: 30px; box-sizing: border-box; }
.post-action-icon svg { display: block; flex: 0 0 16px; width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.post-badge { display: inline-flex; align-items: center; height: 24px; padding: 0 6px; margin: 0 5px 5px 0; border-radius: 5px; background: #eef4ef; color: #476655; font-size: 12px; white-space: nowrap; }
.positive { color: #14744c; background: #e7f5eb; }
.danger { color: #a52e3c; background: #fff0f1; }
.post-pagination { justify-content: space-between; flex-wrap: wrap; padding-bottom: 10px; }
.post-page-summary { color: #63766a; font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; margin: 0 10px 0 0; }
.post-page-controls { justify-content: flex-end; flex-wrap: wrap; margin-left: auto; }
.post-page-controls > :not(:last-child) { margin-right: 10px; }
.post-page-size, .post-page-jump { height: var(--post-control-height); }
.post-page-size select { width: 64px; margin: 0 10px; }
.post-page-buttons button { min-width: 30px; padding: 0 6px; }
.post-page-buttons > :not(:last-child) { margin-right: 5px; }
.post-page-buttons .is-current { color: #fff; background: #245b45; }
.post-page-ellipsis { display: inline-flex; width: 20px; height: var(--post-control-height); align-items: center; justify-content: center; color: #63766a; }
.post-page-jump label { margin-right: 10px; }
.post-page-jump input { width: 58px; margin: 0 10px; }
.post-empty { text-align: center; padding: 20px 10px; margin: 0; font-size: 12px; color: #63766a; }
.post-overlay { position: fixed; inset: 0; background: #18293d66; display: flex; align-items: center; justify-content: center; z-index: 1300; padding: 10px; }
.post-dialog { width: 740px; max-width: 100%; max-height: 85vh; overflow: auto; background: #fff; border-radius: 10px; padding: 10px; box-shadow: 0 15px 50px #18293d33; }
.post-help-dialog { box-sizing: border-box; border: 1px solid var(--post-border); color: #18302e; }
.post-help-dialog::backdrop { background: #18293d66; }
.post-help-dialog .post-head { position: sticky; top: -10px; background: #fff; padding: 0 0 10px; border-bottom: 1px solid #e7eee8; }
.post-help-section { margin-top: 10px; }
.post-help-section p { margin: 0 0 10px; font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.post-help-details { margin: 0; font-size: 12px; }
.post-help-details > div { display: flex; align-items: baseline; margin-bottom: 10px; }
.post-help-details dt { flex: 0 0 6em; color: #63766a; }
.post-help-details dd { margin: 0 0 0 10px; min-width: 0; overflow-wrap: anywhere; }
.post-help-error { color: #a52e3c; }
.post-compact-error { display: flex; align-items: center; }
.post-dialog > p { margin: 10px 0; line-height: 1.6; }
.post-dialog h3 { font-size: 14px; margin: 10px 0; }
.post-fulltext { white-space: pre-wrap; line-height: 1.7; padding: 10px; background: #f4f7f3; border-radius: 6px; overflow-wrap: anywhere; }
.post-detail-section { margin-bottom: 10px; font-size: 12px; }
.post-detail-section h3 { margin: 0 0 10px; font-size: 12px; color: #1d5c3a; }
.post-detail-section p { margin: 10px 0; overflow-wrap: anywhere; }
.post-detail-metrics { display: flex; flex-wrap: wrap; }
.post-detail-metrics span { margin: 0 10px 10px 0; }
.post-detail-section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.post-detail-section-head h3 { margin: 0; }
.post-grok-advice { white-space: pre-wrap; line-height: 1.6; }
.post-review-state { margin-right: auto; font-size: 12px; color: #63766a; }
.post-form-row { display: flex; align-items: center; margin: 10px 0; }
.post-form-row input[type="number"] { width: 70px; margin: 0 10px; }
.post-form-row textarea { flex: 1; min-width: 0; min-height: 80px; margin-left: 10px; padding: 10px; font: inherit; border: 1px solid var(--post-border); border-radius: 6px; }
.post-delete { background: #b42336; color: #fff; border: 0; }
.post-delete:disabled { opacity: .4; }
.post-snapshots { padding-left: 20px; color: #63766a; font-size: 12px; }
.post-snapshots li { margin: 10px 0; }
@media (max-width: 1100px) {
  .post-pagination { flex-direction: column; align-items: flex-end; }
  .post-page-controls { justify-content: flex-end; margin: 10px 0 0 auto; flex-wrap: wrap; }
}
@media (max-width: 700px) {
  .post-head > :first-child { width: 100%; margin-bottom: 10px; }
  .post-page-controls { flex-direction: column; align-items: flex-end; }
  .post-page-controls > :not(:last-child) { margin: 0 0 10px; }
}
@media (max-width: 600px) {
  #postTrackingSection { height: calc(100dvh - 130px); min-height: 500px; }
  .post-filters .post-search { max-width: none; flex-basis: 100%; }
  .post-page-summary { width: 100%; }
}</style>
