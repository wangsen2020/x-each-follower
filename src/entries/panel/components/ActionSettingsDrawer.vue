<template>
  <dialog ref="dialog" class="action-settings-drawer" :aria-labelledby="titleId" @click="backdrop" @close="$emit('close')">
    <header class="action-drawer-header"><h2 :id="titleId">{{ title }}</h2><button type="button" class="secondary action-drawer-close" :aria-label="closeLabel" @click="close">×</button></header>
    <div class="action-drawer-body"><slot /></div>
    <footer v-if="$slots.footer" class="action-drawer-footer"><slot name="footer" /></footer>
  </dialog>
</template>

<script setup>
import {ref,useId} from 'vue';
defineProps({title:{type:String,required:true},closeLabel:{type:String,default:'关闭'}});
defineEmits(['close']);
const dialog=ref(null),titleId=useId();
function open(){if(!dialog.value.open)dialog.value.showModal();}
function close(){dialog.value?.close();}
function backdrop(event){if(event.target!==dialog.value)return;const r=dialog.value.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();}
defineExpose({open,close});
</script>

<style scoped>
.action-settings-drawer { position: fixed; inset: 0 0 0 auto; margin: 0 0 0 auto; width: 480px; max-width: 95vw; height: 100dvh; max-height: 100dvh; padding: 0; box-sizing: border-box; border: 0; border-left: 1px solid #e7ece5; background: #fff; color: #18302e; box-shadow: -4px 0 24px #0e1c1633; }
.action-settings-drawer[open] { display: flex; flex-direction: column; }
.action-settings-drawer::backdrop { background: #0e1c1673; backdrop-filter: blur(1.5px); }
.action-drawer-header, .action-drawer-footer { display: flex; align-items: center; flex-shrink: 0; padding: 10px; background: #f9fbf9; }
.action-drawer-header { justify-content: space-between; border-bottom: 1px solid #e7ece5; }
.action-drawer-header h2 { margin: 0 10px 0 0; font-size: 14px; font-weight: 700; overflow-wrap: anywhere; }
.action-drawer-close { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; width: 30px; height: 30px; min-height: 30px; max-height: 30px; line-height: 30px; flex-shrink: 0; padding: 0; border: 0; border-radius: 6px; background: transparent; color: #69766c; font-size: 20px; cursor: pointer; }
.action-drawer-close:hover { color: #18302e; background: #eef4ef; }
.action-drawer-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; }
.action-drawer-footer { justify-content: flex-end; flex-wrap: wrap; border-top: 1px solid #e7ece5; }
.action-drawer-footer :slotted(:not(:last-child)) { margin-right: 10px; }
@media(max-width:600px) { .action-settings-drawer { width: 100vw; max-width: 100vw; } }
</style>
