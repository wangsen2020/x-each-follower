<template>
  <Toaster class="panel-result-toaster" position="bottom-right" :duration="Infinity" :visible-toasts="10000" :swipe-directions="[]" expand :offset="16" :mobile-offset="12" :container-aria-label="t('操作结果')" />
</template>
<script setup>
import {computed,markRaw,onMounted,onUnmounted,provide} from 'vue';
import {Toaster,toast,useVueSonner} from 'vue-sonner';
import 'vue-sonner/style.css';
import {t} from '../../../shared/i18n.js';
import {PANEL_RESULT_EVENT} from '../result-notices.js';
import ResultNoticeCard from './ResultNoticeCard.vue';
const {activeToasts}=useVueSonner();
const latestId=computed(()=>activeToasts.value.find(item=>item.componentProps?.notice)?.id);
provide('panel-result-context',{latestId,dismiss:id=>toast.dismiss(id)});
function receive(event){const notice=event.detail;if(!notice?.id||typeof notice.title!=='string')return;
  toast.custom(markRaw(ResultNoticeCard),{id:notice.id,duration:Infinity,componentProps:{notice:structuredClone({...notice,createdAt:notice.createdAt||Date.now()})}});
}
onMounted(()=>document.addEventListener(PANEL_RESULT_EVENT,receive));
onUnmounted(()=>document.removeEventListener(PANEL_RESULT_EVENT,receive));
</script>
<style>
[data-sonner-toaster].panel-result-toaster{--width:min(400px,calc(100vw - 24px))!important;width:var(--width)!important;left:auto!important;right:16px!important;display:flex;flex-direction:column;gap:4px;height:auto!important;max-height:calc(100vh - 32px);overflow:auto;overscroll-behavior:contain;z-index:1800;pointer-events:none;font-family:inherit}
.panel-result-toaster [data-sonner-toast]{position:relative!important;top:auto!important;bottom:auto!important;left:auto!important;right:auto!important;transform:none!important;width:100%;height:auto!important;padding:0;opacity:1;pointer-events:auto;box-shadow:none!important;flex-shrink:0}
.panel-result-toaster [data-sonner-toast][data-removed="true"]{display:none!important}
@media(max-width:600px){[data-sonner-toaster].panel-result-toaster{right:12px!important}}
@media(prefers-reduced-motion:reduce){.panel-result-toaster [data-sonner-toast]{transition:none!important;animation:none!important}}
</style>
