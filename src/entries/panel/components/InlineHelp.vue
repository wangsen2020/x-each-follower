<template>
  <InfoTip :text="t(text)" :label="t(label)" />
</template>
<script setup>
import {t} from '../../../shared/i18n.js';

import InfoTip from './InfoTip.vue';
defineProps({ text: { type: String, required: true }, label: { type: String, default: '说明' } });
</script>
