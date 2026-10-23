<template>
  <header class="vue-panel-header">
    <div class="panel-title-line"><h1>{{ currentTitle }}</h1><span id="panel-title-help"></span></div>
    <div id="recordMigration" hidden></div>
  </header>
</template>

<script setup>
import { panelNavigationController } from '../composables/usePanelNavigation.js';

const { currentTitle } = panelNavigationController;
</script>

<style scoped>
.panel-title-line { display: flex; align-items: center; }
.panel-title-line h1 { margin: 0; }
#panel-title-help:not(:empty) { display: inline-flex; align-items: center; margin-left: 10px; }
</style>
