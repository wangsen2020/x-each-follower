<template>
  <nav class="panel-pager" :aria-label="t(label)"><span>{{ t("\u007b\u007bv0\u007d\u007d / \u007b\u007bv1\u007d\u007d · \u007b\u007bv2\u007d\u007d 条",{v0:page,v1:pages,v2:total}) }}</span><label class="panel-pager-size"><span>{{ t("每页") }}</span><PanelSelect :value="pageSize" :aria-label="t(&quot;\u007b\u007bv0\u007d\u007d每页条数&quot;,{v0:t(label)})" @change="$emit('size',Number($event.target.value))"><option v-for="n in [10,20,50]" :key="n" :value="n">{{ t(n) }}</option></PanelSelect></label><button type="button" class="secondary" :aria-label="t(&quot;\u007b\u007bv0\u007d\u007d上一页&quot;,{v0:t(label)})" :disabled="busy || page<=1" @click="$emit('page',page-1)">‹</button><button type="button" class="secondary" :aria-label="t(&quot;\u007b\u007bv0\u007d\u007d下一页&quot;,{v0:t(label)})" :disabled="busy || page>=pages" @click="$emit('page',page+1)">›</button></nav>
</template>
<script setup>
import {t} from '../../../shared/i18n.js';

import PanelSelect from "./PanelSelect.vue";
import {computed} from 'vue';
const props=defineProps({page:{type:Number,default:1},pageSize:{type:Number,default:10},total:{type:Number,default:0},busy:Boolean,label:{type:String,default:'记录分页'}});defineEmits(['page','size']);
const pages=computed(()=>Math.max(1,Math.ceil(props.total/props.pageSize)));
</script>
<style scoped>
.panel-pager{display:flex;flex-direction:row;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;min-width:0;margin:0;font-size:12px;line-height:1.5}
.panel-pager .panel-pager-size{display:inline-flex;flex-direction:row;align-items:center;gap:10px;flex-wrap:nowrap;flex:none;min-height:30px;margin:0;font-size:12px;font-weight:400;white-space:nowrap}
.panel-pager>span,.panel-pager-size>span{display:inline-flex;align-items:center;min-height:30px;margin:0;white-space:nowrap}
.panel-pager select{flex:none;width:64px;height:30px;margin:0;padding:0 10px}
.panel-pager button{flex:none;width:30px;min-width:30px;height:30px;padding:0;margin:0}
</style>
