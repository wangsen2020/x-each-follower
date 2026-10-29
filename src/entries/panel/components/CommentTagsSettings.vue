<template>
  <div class="comment-tags-settings">
    <label class="tag-switch"><input type="checkbox" :checked="settings.quoteTagsEnabled" @change="update({quoteTagsEnabled:$event.target.checked})">追加随机标签<InfoTip text="与关注队列一致：最多选择10个候选，每条按评论语言随机追加最多2个。空间不足时减少标签，不截断正文；同一条评论恢复时保留原标签。" /></label>
    <template v-if="settings.quoteTagsEnabled"><div class="tag-options"><label v-for="tag in available" :key="tag" class="tag-option"><input type="checkbox" :checked="settings.quoteSelectedTags?.includes(tag)" @change="choose(tag,$event)"><span>#{{ tag }}</span><button v-if="settings.quoteCustomTags?.includes(tag)" type="button" :aria-label="'删除标签 '+tag" @click.prevent="remove(tag)">×</button></label></div>
    <div class="tag-add"><input v-model="custom" aria-label="自定义评论标签" placeholder="例如 #互关 或 #LetsConnect" @keydown.enter.prevent="add"><button type="button" @click="add">添加标签</button></div><p v-if="error" role="alert" class="tag-error">{{ error }}</p><p class="tag-preview">候选 {{ settings.quoteSelectedTags?.length||0 }}/10 · 随机示例：{{ preview||'无可用标签' }}</p></template>
  </div>
</template>
<script setup>
import {ref,computed} from 'vue';
import InfoTip from './InfoTip.vue';
import {RECOMMENDED_QUOTE_TAGS,cleanQuoteTag,quoteTagSuffix} from '../../../features/grok/quote-tags.js';
const props=defineProps({settings:{type:Object,required:true}}),emit=defineEmits(['update']);
const custom=ref(''),error=ref('');
const available=computed(()=>[...RECOMMENDED_QUOTE_TAGS,...props.settings.quoteCustomTags||[]]);
const preview=computed(()=>quoteTagSuffix(props.settings));
function update(change){error.value='';emit('update',change);}
function choose(tag,event){const checked=event.target.checked;const selected=props.settings.quoteSelectedTags||[];if(checked&&selected.length>=10){event.target.checked=false;error.value='最多选择10个标签，请先取消其他标签。';return;}update({quoteSelectedTags:checked?[...selected,tag]:selected.filter(t=>t!==tag)});}
function add(){const tag=cleanQuoteTag(custom.value);if(!tag){error.value='请输入单个标签，不含空格或标点。';return;}if(available.value.some(t=>t.toLowerCase()===tag.toLowerCase())){error.value='这个标签已存在。';return;}if((props.settings.quoteCustomTags||[]).length>=50){error.value='最多保存50个自定义标签。';return;}update({quoteCustomTags:[...props.settings.quoteCustomTags||[],tag]});custom.value='';}
function remove(tag){update({quoteCustomTags:props.settings.quoteCustomTags.filter(t=>t!==tag),quoteSelectedTags:props.settings.quoteSelectedTags.filter(t=>t!==tag)});}
</script>
<style scoped>
.comment-tags-settings{display:grid;gap:10px;min-width:0}.tag-switch{display:flex;align-items:center;gap:10px;margin:0}.tag-options{display:flex;flex-wrap:wrap;gap:10px}.tag-options .tag-option{display:inline-flex;flex-direction:row;align-items:center;gap:6px;min-height:28px;padding:4px 8px;border:1px solid #dce7df;border-radius:6px;font-size:12px;font-weight:400;max-width:100%;overflow-wrap:anywhere}.tag-option input,.tag-switch input{width:14px;height:14px;margin:0}.tag-option button{background:transparent;color:#69766c;padding:0 2px;min-width:16px}.tag-add{display:flex;gap:10px}.tag-add input{flex:1;min-width:0;width:0;height:30px;padding:0 10px}.tag-add button{padding:0 10px;height:30px;font-size:12px;flex:none}.tag-preview,.tag-error{margin:0;font-size:12px;line-height:1.6;overflow-wrap:anywhere}.tag-preview{color:#69766c}.tag-error{color:#a52f2f}
</style>
