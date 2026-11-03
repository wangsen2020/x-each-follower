<template>
  <header class="vue-panel-header">
    <div id="recordMigration" hidden></div>
    <AutomationAlerts />
    <div id="fanInspectionProgress" class="fan-inspection-progress" hidden>
      <span id="fanInspectionStatus" role="status" aria-live="polite"></span>
      <PanelIconButton id="stopFanInspection" :icon="CircleStop" :label="t('停止核验')" :tip="t('完成当前账号后暂停，不再核验后续账号；已保存的结果保留。')" hidden />
      <PanelIconButton id="resumeFanInspection" :icon="Play" :label="t('继续核验')" hidden />
      <PanelIconButton id="showFanInspectionResults" :icon="ClipboardList" :label="t('查看结果')" hidden />
    </div>
  </header>
</template>
<script setup>
import AutomationAlerts from './AutomationAlerts.vue';
import PanelIconButton from './PanelIconButton.vue';
import {CircleStop,Play,ClipboardList} from 'lucide';
import {t} from '../../../shared/i18n.js';
</script>
<style scoped>
.fan-inspection-progress{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-height:30px;padding:4px 0;font-size:12px;color:#456456}.fan-inspection-progress[hidden]{display:none}#fanInspectionStatus{min-width:0;overflow-wrap:anywhere;flex:1}
</style>
