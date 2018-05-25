
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

// TODO: rename response string
function parseZabbixStatus(responseString, error){
	console.log(JSON.stringify(responseString));
  const parts = (responseString ? responseString.info : '').split(';');
  const values = [];
  parts.forEach((pair) => {
    const kv = pair.split(':');
    values.push(kv.length > 1 ? kv[1].trim() : '#');
  });

  return {
    processed: parseInt(values.length > 0 ? values[0] : '#') || 0,
    failed: parseInt(values.length > 1 ? values[1] : '#') || 0,
    total: parseInt(values.length > 2 ? values[2] : '#') || 0,
    secondsSpent: parseFloat(values.length > 3 ? values[3] : '#') || 0.0,
    statusMessage: responseString,
    errors: error ? [error] : [],
  };
}

function partitionBatch(batch, maxBatchSize) {
  let itemsPool = batch.slice();
  const partitions = [];
  while (itemsPool.length > 0) {
    const partitionSize = itemsPool.length > maxBatchSize ? maxBatchSize : itemsPool.length;
    const partition = itemsPool.splice(0, partitionSize);
    partitions.push(partition);
  }
  return partitions;
}

const ZabbixBatchSender = function(opts, sender, callback) {
  const validOpts = opts || {};
  const maxBatchSize = validOpts.maxBatchSize || Number.MAX_VALUE;
  // TODO: rename below
  const maxConcurrentBatches = validOpts.maxPublishConcurrency || Number.MAX_VALUE;

  let runningCount = 0;
  const pendingWorkitems = [];
  let completed = false;
  let completedCalled = false;
  const whenAllCompletedCallbacks = callback ? [callback] : [];


  let aggregatedStatus = {};

  const checkCompleted = function(){
    if (runningCount == 0 && pendingWorkitems.length == 0 && completed && !completedCalled){
      whenAllCompletedCallbacks.forEach((cb) => {
        var status = mergeZabbixStatuses(aggregatedStatus);
        cb(status);
      });
      completedCalled = true;
    }
    return completedCalled;
  };

  const scheduleSend = function(items, callback){
    if (runningCount < maxConcurrentBatches){
      runningCount++;
      sender.clearItems();
      items.forEach((item)=>{
        sender.addItem(item.host, item.key, item.value);
      });
      sender.send(function(err, zabbixStatusString, sentItems){
        var receivedStatus = parseZabbixStatus(zabbixStatusString, err);
        aggregatedStatus = mergeZabbixStatuses(aggregatedStatus, receivedStatus);
        runningCount--;        
        callback(err, receivedStatus, items);
        if (pendingWorkitems.length > 0) {
          var nextSend = pendingWorkitems.splice(0,1)[0];
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
  };

  this.publishBatch = function(batch, callback){
    //TODO: fix
    callback = callback || function(){};
    if (!batch || batch.length == 0) {
      const emptyStatus = mergeZabbixStatuses();
      callback(emptyStatus, batch);
      return;
    }

    const chunks = partitionBatch(batch, maxBatchSize);
    const completedChunks = [];
    let fullStatus = mergeZabbixStatuses();

    chunks.forEach((chunk) => {
      const stash = chunk;
      scheduleSend(stash, (err, status)=>{
        completedChunks.push(stash);
        fullStatus = mergeZabbixStatuses(fullStatus, status);
        if (completedChunks.length == chunk.length){
          callback(fullStatus);
        }
      });
    });
  }.bind(this);

  this.complete = function(callback){
	callback = callback || function(){};
    completed = true;
    var triggered = checkCompleted();
    if (triggered){
      const status = mergeZabbixStatuses(aggregatedStatus);
      callback(status);
    }
    whenAllCompletedCallbacks.push(callback);
  }
}

module.exports = {
  ZabbixBatchSender,
  Utils : {
    partitionBatch,
    parseZabbixStatus,
    mergeZabbixStatuses,
  },
};