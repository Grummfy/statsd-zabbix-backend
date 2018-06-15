
function mergeZabbixStatuses(left, right) {
  const template = {
    processed: 0,
    failed: 0,
    total: 0,
    secondsSpent: 0,
    statusMessage: '',
    errors: [],
  };
  const s1 = Object.assign({}, template, left || {});
  const s2 = Object.assign({}, template, right || {});
  const result = {
    processed: s1.processed + s2.processed,
    failed: s1.failed + s2.failed,
    total: s1.total + s2.total,
    secondsSpent: s1.secondsSpent + s2.secondsSpent,
    errors: s1.errors.concat(s2.errors),
  };
  result.statusMessage = `processed: ${result.processed}; failed: ${result.failed}; total: ${result.total}; seconds spent: ${result.secondsSpent.toFixed(6)}`;
  if (result.errors.length > 0) {
    result.statusMessage += `; Other Errors: ${result.errors.length}`;
  }
  return result;
}

function parseZabbixStatus(statusResponse, error) {
  const parts = (statusResponse && statusResponse.info ? statusResponse.info : '').split(';');
  const values = [];
  const radix = 10;
  parts.forEach((pair) => {
    const kv = pair.split(':');
    values.push(kv.length > 1 ? kv[1].trim() : '#');
  });

  return {
    processed: parseInt(values.length > 0 ? values[0] : '#', radix) || 0,
    failed: parseInt(values.length > 1 ? values[1] : '#', radix) || 0,
    total: parseInt(values.length > 2 ? values[2] : '#', radix) || 0,
    secondsSpent: parseFloat(values.length > 3 ? values[3] : '#', radix) || 0.0,
    statusMessage: statusResponse,
    errors: error ? [error] : [],
  };
}

function partitionBatch(batch, maxBatchSize) {
  const itemsPool = batch.slice();
  const partitions = [];
  while (itemsPool.length > 0) {
    const partitionSize = itemsPool.length > maxBatchSize ? maxBatchSize : itemsPool.length;
    const partition = itemsPool.splice(0, partitionSize);
    partitions.push(partition);
  }
  return partitions;
}

function ZabbixBatchSender(opts, sender, completeCallback) {
  const validOpts = opts || {};
  const maxBatchSize = validOpts.maxBatchSize || Number.MAX_VALUE;
  const maxPublishConcurrency = validOpts.maxPublishConcurrency || Number.MAX_VALUE;

  let runningCount = 0;
  const pendingWorkitems = [];
  let completed = false;
  let completedCalled = false;
  const whenAllCompletedCallbacks = completeCallback ? [completeCallback] : [];


  let aggregatedStatus = {};

  function checkCompleted() {
    if (runningCount === 0 && pendingWorkitems.length === 0 && completed && !completedCalled) {
      whenAllCompletedCallbacks.forEach((cb) => {
        const status = mergeZabbixStatuses(aggregatedStatus);
        cb(status);
      });
      completedCalled = true;
    }
    return completedCalled;
  }

  function scheduleSend(items, callback) {
    if (runningCount < maxPublishConcurrency) {
      runningCount += 1;
      sender.clearItems();
      items.forEach((item) => {
        sender.addItem(item.host, item.key, item.value);
      });
      sender.send((err, zabbixStatusString) => {
        const receivedStatus = parseZabbixStatus(zabbixStatusString, err);
        aggregatedStatus = mergeZabbixStatuses(aggregatedStatus, receivedStatus);
        runningCount -= 1;
        callback(err, receivedStatus, items);
        if (pendingWorkitems.length > 0) {
          const nextSend = pendingWorkitems.splice(0, 1)[0];
          scheduleSend(nextSend.items, callback);
        } else {
          checkCompleted();
        }
      });
    } else {
      pendingWorkitems.push({
        items,
        callback,
      });
    }
  }

  this.publishBatch = (batch, callback) => {
    const cb = callback || (() => {});
    if (!batch || batch.length === 0) {
      const emptyStatus = mergeZabbixStatuses();
      cb(emptyStatus, batch);
      return;
    }

    const allChunks = partitionBatch(batch, maxBatchSize);
    const completedChunks = [];
    let fullStatus = mergeZabbixStatuses();

    allChunks.forEach((chunk) => {
      const stash = chunk;
      scheduleSend(stash, (err, status) => {
        completedChunks.push(stash);
        fullStatus = mergeZabbixStatuses(fullStatus, status);
        if (completedChunks.length === allChunks.length) {
          cb(fullStatus);
        }
      });
    });
  };

  this.complete = (callback) => {
    const cb = callback || (() => {});
    completed = true;
    const triggered = checkCompleted();
    if (triggered) {
      const status = mergeZabbixStatuses(aggregatedStatus);
      cb(status);
    }
    whenAllCompletedCallbacks.push(cb);
  };
}

module.exports = {
  ZabbixBatchSender,
  Utils: {
    partitionBatch,
    parseZabbixStatus,
    mergeZabbixStatuses,
  },
};