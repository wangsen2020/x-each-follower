<template>
  <div :id="id" class="monitor-pagination" :hidden="initiallyHidden">
    <label class="page-size-label">
      <span>每页</span>
      <select :id="selectId" :value="defaultSize" aria-label="每页条数">
        <option v-for="size in [20, 50, 100]" :key="size" :value="size">{{ size }}</option>
      </select>
    </label>
    <span :id="summaryId" class="page-summary">{{ initialSummary }}</span>
    <div class="page-actions">
      <button :id="prevId" type="button" :class="['secondary', { 'icon-button': iconButtons }]" title="上一页" aria-label="上一页">‹</button>
      <button :id="nextId" type="button" :class="['secondary', { 'icon-button': iconButtons }]" title="下一页" aria-label="下一页">›</button>
    </div>
  </div>
</template>

<script setup>
defineProps({
  id: { type: String, required: true },
  selectId: { type: String, required: true },
  summaryId: { type: String, required: true },
  prevId: { type: String, required: true },
  nextId: { type: String, required: true },
  defaultSize: { type: Number, default: 20 },
  initialSummary: { type: String, default: '' },
  initiallyHidden: { type: Boolean, default: false },
  iconButtons: { type: Boolean, default: false }
});
</script>
