import pRetry from 'p-retry';
import {reportSystemException} from '../shared/system-exceptions.js';

export const noMessageReceiver = error => /Could not establish connection\. Receiving end does not exist\.?$/i.test(String(error?.message || error));

// Retry only proven non-delivery. A closed response channel can hide a completed
// write, so it must never trigger automatic replay of that write.
export async function requestBackground(message, {api = globalThis.chrome, report = reportSystemException, minTimeout = 200} = {}) {
  try {
    return await pRetry(() => api.runtime.sendMessage(message), {
      retries: 2, minTimeout, maxTimeout: 500, factor: 1,
      shouldRetry: ({error}) => noMessageReceiver(error)
    });
  } catch (error) {
    await report({source: 'panel', kind: 'messaging', message: `${message?.cmd || message?.action || 'request'}：${error?.message || error}`, error, context: globalThis.location?.href}).catch(() => {});
    throw error;
  }
}
