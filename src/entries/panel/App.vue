<template>
  <div id="panel-vue-container">
    <PanelSidebar />
    <PanelHeader />
    <ProfileDrawer />
    <SettingsDrawer />
    <UnreciprocatedSettingsDrawer />
    <ExecutionLogsModal />
  </div>
</template>

<script setup>
import ExecutionLogsModal from './components/ExecutionLogsModal.vue';
import ProfileDrawer from './components/ProfileDrawer.vue';
import SettingsDrawer from './components/SettingsDrawer.vue';
import UnreciprocatedSettingsDrawer from './components/UnreciprocatedSettingsDrawer.vue';
import PanelSidebar from './components/PanelSidebar.vue';
import PanelHeader from './components/PanelHeader.vue';
</script>
