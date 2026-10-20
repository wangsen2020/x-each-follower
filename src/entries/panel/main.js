import { createApp } from 'vue';
import ExecutionLogsModal from './components/ExecutionLogsModal.vue';
import { logsModalController } from './composables/useExecutionLogs.js';

/**
 * Panel Vue 3 Entrypoint.
 * Mounts the ExecutionLogsModal Vue SFC into #logs-modal-app,
 * establishes single DOM ownership, and registers controller bridge for panel.js callers.
 */
function initLogsModalApp() {
  let container = document.getElementById('logs-modal-app');
  if (!container) {
    container = document.createElement('div');
    container.id = 'logs-modal-app';
    document.body.appendChild(container);
  }

  const app = createApp(ExecutionLogsModal);
  app.mount(container);

  // Expose controller for legacy panel.js and external callers
  window.__executionLogsModalController = logsModalController;

  // Listen to open-execution-logs custom event from follow queue panel or other components
  document.addEventListener('open-execution-logs', (evt) => {
    const scope = evt?.detail?.scope || 'autoFollow';
    logsModalController.open(scope);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initLogsModalApp, { once: true });
} else {
  initLogsModalApp();
}

export { logsModalController };
