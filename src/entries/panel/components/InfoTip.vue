<template>
  <span class="info-tip" tabindex="0" role="note" :data-tip="text" :aria-label="label || text">?</span>
</template>

<script setup>
defineProps({ text: { type: String, required: true }, label: { type: String, default: '' } });
</script>

<style scoped>
.info-tip{display:inline-grid;place-items:center;flex:0 0 14px;box-sizing:border-box;width:14px;height:14px;margin:0;border:0;border-radius:50%;background:#769287;color:#fff;font:700 10px/1 Arial,sans-serif;cursor:help;vertical-align:middle}
.info-tip:focus-visible{outline:2px solid #14744c;outline-offset:3px}
</style>
