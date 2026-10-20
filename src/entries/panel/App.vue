<template>
  <div id="panel-vue-container">
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
</script>
