// Extension pages ask the background worker to write. The message is data only.

export async function requestStorageWrite(op, payload) {
  const response = await chrome.runtime.sendMessage({cmd: 'storageWrite', op, payload});
  if (!response?.ok) throw new Error(response?.error || '本地写入失败');
  return response;
}
