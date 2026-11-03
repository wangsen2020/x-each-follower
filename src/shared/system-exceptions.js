import Dexie from 'dexie';
import {APP_VERSION} from './version.js';

export const EXCEPTION_DB = 'xfollower-system-exceptions';
export const EXCEPTION_PENDING = 'xfSystemException:';
export const EXCEPTION_LIMIT = 1000;
export const EXCEPTION_DAYS = 7;

// Store diagnostics only, never arbitrary message payloads or console objects.
export function redactExceptionText(value, limit = 6000) {
  return String(value ?? '').slice(0, 16000)
    .replace(/Bearer\s+[^\s,"';]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:token|password|authorization|api[_-]?key|secret|cookie|signature)["']?\s*[:=]\s*)["']?[^\s,"';]+/gi, '$1[已隐藏]')
    .replace(/\b(?:sk-[\w-]{12,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[已隐藏]')
    .replace(/https?:\/\/[^\s<>"')]+/g, raw => {
      try { const url = new URL(raw); return url.origin + (/webhook|automation/i.test(url.pathname) ? '/[已隐藏]' : url.pathname); }
      catch { return '[链接已隐藏]'; }
    })
    .replace(/(chrome-extension:\/\/[^\s?#)]+)[?#][^\s)]*/g, '$1')
    .slice(0, limit);
}

export function normalizeSystemException(input = {}, now = Date.now()) {
  const error = input.error;
  const text = input.message ?? error?.message ?? (typeof error === 'string' ? error : '未知异常');
  return {
    id: typeof input.id === 'string' ? input.id.slice(0, 100) : crypto.randomUUID(),
    at: Number.isFinite(input.at) && input.at > 0 && input.at <= now + 60000 ? input.at : now,
    level: input.level === 'warning' ? 'warning' : 'error',
    source: ['background', 'panel', 'content'].includes(input.source) ? input.source : 'panel',
    kind: redactExceptionText(input.kind || 'runtime', 100),
    message: redactExceptionText(text, 2000),
    stack: redactExceptionText(input.stack ?? error?.stack ?? '', 6000),
    context: redactExceptionText(input.context || '', 400),
    version: /^\d+\.\d+\.\d+$/.test(input.version) ? input.version : APP_VERSION
  };
}

export function createSystemExceptionStore({name = EXCEPTION_DB, indexedDB, IDBKeyRange, now = Date.now, limit = EXCEPTION_LIMIT} = {}) {
  const db = new Dexie(name, indexedDB ? {indexedDB, IDBKeyRange} : undefined);
  db.version(1).stores({entries: 'id,at,source,level'});
  async function prune() {
    await db.entries.where('at').below(now() - EXCEPTION_DAYS * 86400000).delete();
    const excess = await db.entries.count() - limit;
    if (excess > 0) await db.entries.bulkDelete(await db.entries.orderBy('at').limit(excess).primaryKeys());
  }
  return {
    async append(input) {
      const entry = normalizeSystemException(input, now());
      await db.transaction('rw', db.entries, async () => { await db.entries.put(entry); await prune(); });
      return entry;
    },
    async list() {
      await db.transaction('rw', db.entries, prune);
      return db.entries.orderBy('at').reverse().toArray();
    },
    clear: () => db.entries.clear(),
    close: () => db.close()
  };
}

let defaultStore;
export const systemExceptionStore = () => defaultStore ||= createSystemExceptionStore();

// Unique keys avoid overwriting another context's pending diagnostics.
export async function reportSystemException(input, {store = systemExceptionStore(), storage = globalThis.chrome?.storage?.local} = {}) {
  const entry = normalizeSystemException(input);
  try { await store.append(entry); return true; }
  catch {
    try {
      if (!storage) return false;
      await storage.set({[EXCEPTION_PENDING + entry.id]: entry});
      const saved = await storage.get(null);
      const pending = Object.entries(saved).filter(([key]) => key.startsWith(EXCEPTION_PENDING)).sort((a,b) => b[1].at - a[1].at);
      const expired = pending.filter(([, row], index) => index >= 100 || row.at < Date.now() - EXCEPTION_DAYS * 86400000).map(([key]) => key);
      if (expired.length) await storage.remove(expired);
      return true;
    }
    catch { return false; } // Logging must never produce another unhandled rejection.
  }
}

export async function flushPendingExceptions({store = systemExceptionStore(), storage = globalThis.chrome?.storage?.local} = {}) {
  if (!storage) return;
  const saved = await storage.get(null);
  for (const [key, entry] of Object.entries(saved)) {
    if (!key.startsWith(EXCEPTION_PENDING)) continue;
    if (entry?.at >= Date.now() - EXCEPTION_DAYS * 86400000) await store.append(entry);
    await storage.remove(key);
  }
}

export function installExceptionCapture({source, target = globalThis, report = reportSystemException} = {}) {
  const symbol = Symbol.for('xf.system-exception-capture');
  if (target[symbol]) return target[symbol];
  const context = () => target.location?.href || '';
  const record = input => { try { Promise.resolve(report({source, context: context(), ...input})).catch(() => {}); } catch {} };
  const onError = event => record({kind: 'uncaught', error: event.error, message: event.message, stack: event.error?.stack || `${event.filename || ''}:${event.lineno || ''}:${event.colno || ''}`});
  const onRejection = event => record({kind: 'unhandledrejection', error: event.reason});
  target.addEventListener?.('error', onError);
  target.addEventListener?.('unhandledrejection', onRejection);
  const originals = {};
  for (const method of ['warn', 'error']) {
    if (!target.console?.[method]) continue;
    originals[method] = target.console[method];
    target.console[method] = function (...args) {
      originals[method].apply(this, args);
      const scalar = args.filter(value => ['string', 'number', 'boolean'].includes(typeof value));
      const error = args.find(value => value instanceof Error);
      record({kind: `console.${method}`, level: method === 'warn' ? 'warning' : 'error', message: [...scalar, error?.message].filter(Boolean).join(' ') || '控制台异常', error});
    };
  }
  const dispose = () => {
    target.removeEventListener?.('error', onError);
    target.removeEventListener?.('unhandledrejection', onRejection);
    for (const [method, original] of Object.entries(originals)) target.console[method] = original;
    delete target[symbol];
  };
  target[symbol] = dispose;
  return dispose;
}
