<template>
  <button type="button" class="icon-button secondary panel-icon-button" :aria-label="t(label)" :data-panel-tip="(t(tip) || t(label))">
    <svg v-bind="PANEL_ICON_ATTRIBUTES"><component :is="tag" v-for="([tag, attrs], index) in icon" :key="index" v-bind="attrs" /></svg>
  </button>
</template>
<script setup>
import {t} from '../../../shared/i18n.js';

import {PANEL_ICON_ATTRIBUTES} from '../panel-icon-button.js';
defineProps({icon:{type:Array,required:true}, label:{type:String,required:true}, tip:{type:String,default:''}});
</script>
