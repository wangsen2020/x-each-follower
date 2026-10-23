<template>
  <span class="inline-help"><button type="button" :aria-label="label" :aria-describedby="id">?</button><span :id="id" role="tooltip">{{ text }}</span></span>
</template>
<script setup>
import { useId } from 'vue';
defineProps({ text: { type: String, required: true }, label: { type: String, default: '说明' } });
const id = useId();
</script>
<style scoped>
.inline-help { position: relative; display: inline-flex; align-items: center; flex: none; }
.inline-help button { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; width: 14px; height: 14px; min-height: 14px; padding: 0; margin: 0; border: 0; border-radius: 50%; background: #769287; color: #fff; font-size: 10px; line-height: 1; cursor: help;  font-weight: 700; font-family: Arial, sans-serif;}
.inline-help [role=tooltip] { display: none; position: absolute; top: 28px; left: 0; z-index: 60; width: 280px; max-width: 70vw; padding: 10px; box-sizing: border-box; border-radius: 6px; background: #18302e; color: #fff; font-size: 12px; font-weight: 400; line-height: 1.6; white-space: normal; overflow-wrap: anywhere; box-shadow: 0 2px 8px #18302e33; }
.inline-help:hover [role=tooltip], .inline-help:focus-within [role=tooltip] { display: block; }
</style>
