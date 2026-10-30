import './styles/table-scroll.css';
import './styles/select-control.css';
import { createApp } from 'vue';
import App from './App.vue';
import { logsModalController } from './composables/useExecutionLogs.js';
import { profileDrawerController } from './composables/useProfileDrawer.js';
import { settingsDrawerController } from './composables/useSettingsDrawer.js';
import { unreciprocatedSettingsController } from './composables/useUnreciprocatedSettings.js';
import { panelNavigationController } from './composables/usePanelNavigation.js';

/**
 * Panel Vue 3 Entrypoint.
 * Mounts the App root containing ExecutionLogsModal, ProfileDrawer,
 * SettingsDrawer and UnreciprocatedSettingsDrawer.
 * Establishes single DOM ownership and registers controller bridges for panel.js callers.
 */
async function initPanelVueApp() {
  let container = document.getElementById('panel-vue-root') || document.getElementById('logs-modal-app');
  if (!container) {
    container = document.createElement('div');
    container.id = 'panel-vue-root';
    document.body.appendChild(container);
  }

  const app = createApp(App);
  app.mount(container);

  // Expose controllers for legacy panel.js and external callers
  window.__executionLogsModalController = logsModalController;
  window.__profileDrawerController = profileDrawerController;
  window.__settingsDrawerController = settingsDrawerController;
  window.__unreciprocatedSettingsController = unreciprocatedSettingsController;
  window.__panelNavigationController = panelNavigationController;
  document.dispatchEvent(new CustomEvent('panel-vue-ready'));

  // Listen to open-execution-logs custom event from follow queue panel or other components
  document.addEventListener('open-execution-logs', (evt) => {
    const scope = evt?.detail?.scope || 'autoFollow';
    logsModalController.open(scope);
  });

  // Listen to open-profile-drawer custom event
  document.addEventListener('open-profile-drawer', (evt) => {
    const user = evt?.detail?.user;
    const mode = evt?.detail?.mode || 'profile';
    if (user) {
      profileDrawerController.open(user, mode);
    }
  });

  // Listen to open-settings-drawer custom event
  document.addEventListener('open-settings-drawer', (evt) => {
    const config = evt?.detail?.config;
    settingsDrawerController.open(config);
  });

  // Listen to open-unreciprocated-settings custom event
  document.addEventListener('open-unreciprocated-settings', (evt) => {
    const config = evt?.detail?.config;
    unreciprocatedSettingsController.open(config);
  });

  // The business controller binds listeners to page roots at module evaluation
  // time. Mount Vue and register bridges before loading that controller.
  await import("./panel.js");
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPanelVueApp, { once: true });
} else {
  initPanelVueApp();
}

export {
  logsModalController,
  profileDrawerController,
  settingsDrawerController,
  unreciprocatedSettingsController,
  panelNavigationController
};
