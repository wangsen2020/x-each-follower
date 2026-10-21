<template>
  <header class="vue-panel-header">
    <span class="eyebrow">XFollower · v{{ version }}</span>
    <h1>{{ currentTitle }}</h1>
    <div id="recordMigration" hidden></div>
  </header>
</template>

<script setup>
import { panelNavigationController } from '../composables/usePanelNavigation.js';

const { version, currentTitle } = panelNavigationController;
</script>
