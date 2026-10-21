// Serializable chrome.storage writes only. Callers pass data, never functions.

const OPS = new Set(['localSet', 'localRemove', 'syncSet']);

function plainData(value) {
  if (value == null || typeof value !== 'object') throw new Error('storage write payload must be data');
  return JSON.parse(JSON.stringify(value));
}

export function createStorageWriteAdapter({chromeApi, queue}) {
  async function apply(message) {
    if (!OPS.has(message?.op)) throw new Error('unsupported storage write');
    const payload = plainData(message.payload);
    if (message.op === 'localSet') await chromeApi.storage.local.set(payload);
    else if (message.op === 'syncSet') await chromeApi.storage.sync.set(payload);
    else await chromeApi.storage.local.remove(payload.keys);
    return {ok: true};
  }

  function perform(message) {
    return queue.enqueue(() => apply(message));
  }

  return {perform};
}
