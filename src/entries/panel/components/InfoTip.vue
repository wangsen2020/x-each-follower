<template>
  <span class="info-tip" tabindex="0" role="note" :data-tip="text" :aria-label="label || text">?</span>
</template>

<script setup>
defineProps({ text: { type: String, required: true }, label: { type: String, default: '' } });
</script>
