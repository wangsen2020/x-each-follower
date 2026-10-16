import ClientTransaction from './transaction.js';

let transactionPromise = null;
let initializedAt = 0;
const CACHE_DURATION = 5 * 60 * 1000;

async function initializeTransaction(force = false) {
  if (!force && transactionPromise && Date.now() - initializedAt < CACHE_DURATION) return transactionPromise;
  transactionPromise = (async () => {
    const response = await fetch('https://x.com/i/jf/', {
      credentials: 'include',
      cache: 'no-store',
      headers: {accept:'text/html,application/xhtml+xml'}
    });
    if (!response.ok) throw new Error(`X 签名材料请求失败（${response.status}）`);
    const html = await response.text();
    const document = new DOMParser().parseFromString(html, 'text/html');
    const client = await ClientTransaction.create(document);
    initializedAt = Date.now();
    return client;
  })().catch(error => {
    transactionPromise = null;
    throw error;
  });
  return transactionPromise;
}

async function generateTransactionId(method, path, forceRefresh = false) {
  const client = await initializeTransaction(forceRefresh);
  return client.generateTransactionId(method, path);
}

Object.defineProperty(window, '__XEF_GENERATE_TRANSACTION_ID', {
  configurable: true,
  value: generateTransactionId
});
