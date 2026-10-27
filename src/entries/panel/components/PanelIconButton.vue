<template>
  <button type="button" class="icon-button secondary panel-icon-button" :aria-label="label" :data-panel-tip="tip || label">
    <svg v-bind="PANEL_ICON_ATTRIBUTES"><component :is="tag" v-for="([tag, attrs], index) in icon" :key="index" v-bind="attrs" /></svg>
  </button>
</template>
<script setup>
import {PANEL_ICON_ATTRIBUTES} from '../panel-icon-button.js';
defineProps({icon:{type:Array,required:true}, label:{type:String,required:true}, tip:{type:String,default:''}});
</script>
