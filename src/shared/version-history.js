export const VERSION_HISTORY_KEY = 'xfollowerVersionHistory';
const MAX_UPGRADE_LOGS = 200;

function normalized(value) {
  return {
    versions: Array.isArray(value?.versions) ? value.versions : [],
    logs: Array.isArray(value?.logs) ? value.logs : []
  };
}

export function createVersionHistory({storage, version, now = () => new Date().toISOString()} = {}) {
  if (!storage?.get || !storage?.set || !version) throw new Error('版本记录存储不可用');
  let pending = Promise.resolve();
  const read = async () => normalized((await storage.get(VERSION_HISTORY_KEY))[VERSION_HISTORY_KEY]);
  const update = work => {
    const result = pending.then(async () => {
      const history = await read();
      const changed = work(history);
      if (changed) await storage.set({[VERSION_HISTORY_KEY]: history});
      return history;
    });
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
  return {
    async read() { await pending; return read(); },
    recordInstalled(details = {}) {
      if (details.reason !== 'install' && details.reason !== 'update') return pending.then(() => read());
      if (details.reason === 'update' && details.previousVersion === version) return pending.then(() => read());
      return update(history => {
        const previousVersion = typeof details.previousVersion === 'string' ? details.previousVersion : null;
        const kind = details.reason === 'update' ? 'update' : 'install';
        const id = `${kind}:${previousVersion || ''}:${version}`;
        if (history.versions.some(entry => entry.id === id)) return false;
        const at = now();
        history.versions.unshift({id, version, previousVersion, kind, at});
        history.logs.unshift({id:`event:${id}`, version, at, kind:'version', stage:kind, previousVersion, result:'recorded'});
        history.logs.length = Math.min(history.logs.length, MAX_UPGRADE_LOGS);
        return true;
      });
    },
    recordMigration(stage, status = {}) {
      return update(history => {
        history.logs.unshift({
          id:crypto.randomUUID(), version, at:now(), kind:'migration', stage,
          migrationId:status.migrationId || null,
          completed:Number.isFinite(status.completed) ? status.completed : null,
          total:Number.isFinite(status.total) ? status.total : null,
          cutover:status.cutover === true,
          error:status.error ? String(status.error) : null
        });
        history.logs.length = Math.min(history.logs.length, MAX_UPGRADE_LOGS);
        return true;
      });
    }
  };
}
