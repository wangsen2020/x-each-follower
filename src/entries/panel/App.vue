<template>
  <div id="panel-vue-container">
    <PanelSidebar />
    <PanelHeader />
    <FollowQueueSection />
    <MonitorSection />
    <CandidatesSection />
    <CommentsSection />
    <MutualCommentsSection />
    <PostTrackingSection />
    <LeaderboardSection />
    <UnreciprocatedSection />
    <KnowledgeSection />
    <ProfileDrawer />
    <SettingsDrawer />
    <FollowReviewSettingsDialog />
    <UnreciprocatedSettingsDrawer />
    <ExecutionLogsModal />
    <InfoTipLayer />
    <CloudflareImageSettings />
    <PanelResultToaster />
  </div>
</template>

<script setup>
import ExecutionLogsModal from './components/ExecutionLogsModal.vue';
import PanelResultToaster from './components/PanelResultToaster.vue';
import InfoTipLayer from './components/InfoTipLayer.vue';
import CloudflareImageSettings from './components/CloudflareImageSettings.vue';
import ProfileDrawer from './components/ProfileDrawer.vue';
import SettingsDrawer from './components/SettingsDrawer.vue';
import FollowReviewSettingsDialog from './components/FollowReviewSettingsDialog.vue';
import UnreciprocatedSettingsDrawer from './components/UnreciprocatedSettingsDrawer.vue';
import PanelSidebar from './components/PanelSidebar.vue';
import PanelHeader from './components/PanelHeader.vue';
import FollowQueueSection from './pages/FollowQueueSection.vue';
import MonitorSection from './pages/MonitorSection.vue';
import CandidatesSection from './pages/CandidatesSection.vue';
import CommentsSection from './pages/CommentsSection.vue';
import MutualCommentsSection from './pages/MutualCommentsSection.vue';
import PostTrackingSection from './pages/PostTrackingSection.vue';
import LeaderboardSection from './pages/LeaderboardSection.vue';
import UnreciprocatedSection from './pages/UnreciprocatedSection.vue';
import KnowledgeSection from './pages/KnowledgeSection.vue';
</script>
