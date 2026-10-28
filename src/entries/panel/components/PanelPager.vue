<template>
  <nav class="panel-pager" :aria-label="label"><span>{{ page }} / {{ pages }} · {{ total }} 条</span><label>每页<select :value="pageSize" :aria-label="label+'每页条数'" @change="$emit('size',Number($event.target.value))"><option v-for="n in [10,20,50]" :key="n" :value="n">{{ n }}</option></select></label><button type="button" class="secondary" :aria-label="label+'上一页'" :disabled="busy || page<=1" @click="$emit('page',page-1)">‹</button><button type="button" class="secondary" :aria-label="label+'下一页'" :disabled="busy || page>=pages" @click="$emit('page',page+1)">›</button></nav>
</template>
<script setup>
import {computed} from 'vue';
const props=defineProps({page:{type:Number,default:1},pageSize:{type:Number,default:10},total:{type:Number,default:0},busy:Boolean,label:{type:String,default:'记录分页'}});defineEmits(['page','size']);
const pages=computed(()=>Math.max(1,Math.ceil(props.total/props.pageSize)));
</script>
<style scoped>
.panel-pager,.panel-pager label{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px}.panel-pager{justify-content:flex-end}.panel-pager select{height:30px;padding:0 10px}.panel-pager button{min-width:30px;height:30px;padding:0 10px;margin:0}
.panel-pager>span,.panel-pager label{min-height:30px;line-height:30px}.panel-pager>span{display:inline-flex;align-items:center}
</style>
