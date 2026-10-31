<template>
  <div :id="id" class="monitor-pagination" :hidden="initiallyHidden">
    <label class="page-size-label">
      <span>{{ t("每页") }}</span>
      <PanelSelect :id="selectId" :value="defaultSize" :aria-label="t(&quot;每页条数&quot;)">
        <option v-for="size in [20, 50, 100]" :key="size" :value="size">{{ t(size) }}</option>
      </PanelSelect>
    </label>
    <span :id="summaryId" class="page-summary">{{ t(initialSummary) }}</span>
    <div class="page-actions">
      <button :id="prevId" type="button" :class="['secondary', { 'icon-button': iconButtons }]" :title="t(&quot;上一页&quot;)" :aria-label="t(&quot;上一页&quot;)">‹</button>
      <button :id="nextId" type="button" :class="['secondary', { 'icon-button': iconButtons }]" :title="t(&quot;下一页&quot;)" :aria-label="t(&quot;下一页&quot;)">›</button>
    </div>
  </div>
</template>

<script setup>
import {t} from '../../../shared/i18n.js';

import PanelSelect from "./PanelSelect.vue";
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
