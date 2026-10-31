<template>
  <button type="button" class="panel-close-button" :title="t(label)" :aria-label="t(label)" @click="$emit('click', $event)"></button>
</template>

<script setup>
import {t} from '../../../shared/i18n.js';

defineProps({ label: { type: String, default: '关闭' } });
defineEmits(['click']);
</script>
