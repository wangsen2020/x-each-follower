<template>
  <InfoTip :text="text" :label="label" />
</template>
<script setup>
import InfoTip from './InfoTip.vue';
defineProps({ text: { type: String, required: true }, label: { type: String, default: '说明' } });
</script>
