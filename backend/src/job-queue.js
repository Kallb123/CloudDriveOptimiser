'use strict';

/**
 * Small in-process FIFO queue that runs at most `limit` tasks at a time.
 *
 * `run(entry)` is called for each entry once a slot is free. It may return a
 * promise; whether it resolves or rejects, the slot is released and the next
 * pending entry is started. `run` is responsible for its own error handling —
 * anything it throws is passed to `onError` (if provided) and otherwise ignored.
 */
function createJobQueue({ limit = 1, run, onError } = {}) {
  const maxConcurrent = Math.max(1, Number.parseInt(limit, 10) || 1);
  const pending = [];
  let running = 0;

  function drain() {
    while (running < maxConcurrent && pending.length > 0) {
      const entry = pending.shift();
      running += 1;
      Promise.resolve()
        .then(() => run(entry))
        .catch((err) => {
          if (typeof onError === 'function') onError(err, entry);
        })
        .finally(() => {
          running -= 1;
          drain();
        });
    }
  }

  return {
    /** Add entries to the back of the queue and start whatever fits. */
    enqueue(...entries) {
      pending.push(...entries);
      drain();
    },
    /** Remove (and return) pending entries matching the predicate. Running entries are untouched. */
    removePending(predicate) {
      const removed = [];
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        if (predicate(pending[i])) removed.unshift(...pending.splice(i, 1));
      }
      return removed;
    },
    get pendingCount() {
      return pending.length;
    },
    get runningCount() {
      return running;
    },
  };
}

module.exports = { createJobQueue };
