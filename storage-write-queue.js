// One in-process queue for the background service worker.
// A rejected task rejects only its own caller. The chain keeps accepting later tasks.

export function createStorageWriteQueue({onError} = {}) {
  let chain = Promise.resolve();

  function enqueue(task) {
    const run = chain.then(() => task());
    chain = run.then(() => {}, error => {
      try { onError?.(error); } catch { /* logging must not stop the queue */ }
    });
    return run;
  }

  return {enqueue};
}
