<template>
  <div id="panel-vue-container">
    <PanelSidebar />
    <PanelHeader />
    <FollowQueueSection />
    <MonitorSection />
    <CandidatesSection />
    <CommentsSection />
    <PostTrackingSection />
    <UnreciprocatedSection />
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
import FollowQueueSection from './pages/FollowQueueSection.vue';
import MonitorSection from './pages/MonitorSection.vue';
import CandidatesSection from './pages/CandidatesSection.vue';
import CommentsSection from './pages/CommentsSection.vue';
import PostTrackingSection from './pages/PostTrackingSection.vue';
import UnreciprocatedSection from './pages/UnreciprocatedSection.vue';
</script>
