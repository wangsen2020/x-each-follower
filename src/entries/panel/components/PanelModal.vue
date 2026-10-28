<template>
  <dialog ref="dialog" class="panel-modal" :aria-labelledby="titleId" @close="$emit('close')" @click="backdrop">
    <header><strong :id="titleId">{{ title }}</strong><div v-if="$slots.actions" class="modal-actions"><slot name="actions" /></div><PanelCloseButton class="modal-close" label="关闭弹窗" @click="close" /></header>
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
.panel-modal{width:min(840px,calc(100vw - 20px));max-width:calc(100vw - 20px);max-height:85dvh;margin:auto;padding:0;border:1px solid #c8dccb;border-radius:12px;background:#fff;color:#183c2f;font-size:12px;line-height:1.5;box-shadow:0 16px 40px #122e2438;overflow:hidden;box-sizing:border-box}.panel-modal[open]{display:flex;flex-direction:column}.panel-modal::backdrop{background:#0e1c1666}
.panel-modal header{display:grid;grid-template-columns:minmax(0,1fr) auto 30px;align-items:center;gap:10px;padding:10px;flex-shrink:0;background:#f8faf8;border-bottom:1px solid #e4ece6}.panel-modal header:not(:has(.modal-actions)){grid-template-columns:minmax(0,1fr) 30px}
.panel-modal footer{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;flex-shrink:0;margin:0;padding:10px;border-top:1px solid #e4ece6;font-size:12px}
.modal-actions{display:flex;flex-direction:row;align-items:center;justify-content:flex-end;gap:10px;min-width:0;flex-wrap:wrap}.modal-close{grid-column:-2;grid-row:1}.modal-body{padding:10px;overflow:auto;min-height:0;display:flex;flex-direction:column;gap:10px}.modal-body :slotted(p){margin:0;overflow-wrap:anywhere}header strong{min-width:0;font-size:14px;overflow-wrap:anywhere}
@media(max-width:600px){.panel-modal header{grid-template-columns:minmax(0,1fr) 30px}.modal-actions{grid-row:2;grid-column:1 / -1}}
</style>
