import { createApp } from 'vue';
import App from './App.vue';
import { logsModalController } from './composables/useExecutionLogs.js';
import { profileDrawerController } from './composables/useProfileDrawer.js';

/**
 * Panel Vue 3 Entrypoint.
 * Mounts the App root containing ExecutionLogsModal and ProfileDrawer,
 * establishes single DOM ownership, and registers controller bridges for panel.js callers.
 */
function initPanelVueApp() {
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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPanelVueApp, { once: true });
} else {
  initPanelVueApp();
}

export { logsModalController, profileDrawerController };
