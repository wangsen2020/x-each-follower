<template>
  <dialog ref="dialog" class="panel-modal" :aria-labelledby="titleId" @close="$emit('close')" @click="backdrop">
    <header><strong :id="titleId">{{ title }}</strong><div class="modal-actions"><slot name="actions" /><PanelCloseButton label="关闭弹窗" @click="close" /></div></header>
    <div class="modal-body"><slot /></div>
    <footer v-if="$slots.footer"><slot name="footer" /></footer>
  </dialog>
</template>
<script setup>
import {ref,useId} from 'vue';
import PanelCloseButton from './PanelCloseButton.vue';
defineProps({title:{type:String,required:true}});defineEmits(['close']);
const dialog=ref(null),titleId=useId();
function open(){if(!dialog.value.open)dialog.value.showModal();}
function close(){dialog.value?.close();}
function backdrop(e){if(e.target!==dialog.value)return;const r=dialog.value.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();}
defineExpose({open,close});
</script>
<style scoped>
.panel-modal{width:min(840px,94vw);max-height:85dvh;padding:0;border:1px solid #c8dccb;border-radius:12px;background:#fff;color:#183c2f;box-shadow:0 16px 40px #122e2438;overflow:hidden;box-sizing:border-box}.panel-modal[open]{display:flex;flex-direction:column}.panel-modal::backdrop{background:#0e1c1666}.panel-modal header,.panel-modal footer{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px;flex-shrink:0}.panel-modal header{background:#f8faf8;border-bottom:1px solid #e4ece6}.panel-modal footer{border-top:1px solid #e4ece6;justify-content:flex-end}.modal-actions{display:flex;align-items:center;gap:10px}.modal-body{padding:10px;overflow:auto;min-height:0;display:flex;flex-direction:column;gap:10px}.modal-body :slotted(p){margin:0;overflow-wrap:anywhere}header strong{font-size:14px}
</style>
