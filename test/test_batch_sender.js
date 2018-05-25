const assert = require('assert');
const logger = require('util');
const sinon = require('sinon');
const {ZabbixBatchSender, Utils} = require('../lib/zabbix_batch_sender');

const config = {
  flushInterval: 1,
  zabbixDiscoveryKey: '#AUTO_DISCOVERY_METRIC#',
  zabbixFilters: ['../lib/sample_zabbix_discovery_filter'],
};

describe('zabbix sender utils - partitioning', () => {
  it('partition small batch', () => {
    const batch = [1,2,3,4,5];
    const chunks = Utils.partitionBatch(batch, 10);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 5);
  });

  it('partition big batch', () => {
    const batch = [1,2,3,4,5];
    const chunks = Utils.partitionBatch(batch, 3);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, 3);
    assert.equal(chunks[1].length, 2);
  });

  it('partition huge batch', () => {
    const batch = [1,2,3,4,5];
    const chunks = Utils.partitionBatch(batch, 2);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].length, 2);
    assert.equal(chunks[1].length, 2);
    assert.equal(chunks[2].length, 1);
  });
});

describe('zabbix sender utils - zabbix status manuipulation', () => {
  it('parses zabbix status', () => {
    const statusString =  "processed: 56; failed: 35; total: 91; seconds spent: 0.005022";
    const status = Utils.parseZabbixStatus(statusString);
    assert.ok(status);
    assert.equal(status.processed, 56);
    assert.equal(status.failed, 35);
    assert.equal(status.total, 91);
    assert.equal(status.secondsSpent, 0.005022);
    assert.equal(status.statusMessage, statusString);
    assert.ok(status.errors);
    assert.equal(status.errors.length, 0);
  });

  it('creates empty zabbix status', () => {
    const status = Utils.mergeZabbixStatuses();
    assert.ok(status);
    assert.equal(status.processed, 0);
    assert.equal(status.failed, 0);
    assert.equal(status.total, 0);
    assert.equal(status.secondsSpent, 0.0);
    assert.equal(status.statusMessage, 'processed: 0; failed: 0; total: 0; seconds spent: 0.000000');
    assert.ok(status.errors);
    assert.equal(status.errors.length, 0);
  });

  it('merges zabbix statuses', () => {
    const statusString1 =  "processed: 56; failed: 35; total: 91; seconds spent: 0.005022";
    const statusString2 =  "processed: 22; failed: 12; total: 7; seconds spent: 0.003425";
    const status1 = Utils.parseZabbixStatus(statusString1, "Error1");
    const status2 = Utils.parseZabbixStatus(statusString2, "Error2");
    const status = Utils.mergeZabbixStatuses(status1, status2);
    assert.ok(status);
    assert.equal(status.processed, 78);
    assert.equal(status.failed, 47);
    assert.equal(status.total, 98);
    assert.equal(status.secondsSpent, 0.008447);
    assert.equal(status.statusMessage, 'processed: 78; failed: 47; total: 98; seconds spent: 0.008447; Other Errors: 2');
    assert.ok(status.errors);
    assert.equal(status.errors.length, 2);
  });
});


describe('zabbix batch sender', () => {
  const senderFactory = function(opts){
    var zabbixSender = Object.assign({
      failedCount: 0,
      itemsCount: 0,
      sendCount: 0,
      timeSpent: 0.0
    }, opts || {});
    zabbixSender.addItem = function(){
      zabbixSender.itemsCount++;
    };
    zabbixSender.clearItems = function(){
      zabbixSender.itemsCount = 0;
    };
    zabbixSender.send = function(callback) {
      zabbixSender.sendCount++;
      callback(null, `processed: ${zabbixSender.itemsCount - zabbixSender.failedCount}; failed: ${zabbixSender.failedCount}; total: ${zabbixSender.itemsCount}; seconds spent: ${zabbixSender.timeSpent.toFixed(6)}`);
    }
    return zabbixSender;
  };

  const createBatch = function(len){
    const batch = [];
    for (i=0; i < len; i++){
      batch.push({
        host: 'host',
        key: `key${i+1}`,
        value: i + 1
      });
    }
    return batch;
  }

  it('send in one chunk', () => {
    const zabbixSender = senderFactory();
    const sender = new ZabbixBatchSender({maxBatchSize: 100}, zabbixSender);
    const batch = createBatch(50);
    sender.publishBatch(batch, function(status){
      assert.ok(status);
      assert.equal(status.processed, 50);
      assert.equal(zabbixSender.sendCount, 1);
    });
    sender.complete((status)=>{
      assert.ok(status);
      assert.equal(status.processed, 50);
      assert.equal(zabbixSender.sendCount, 1);
    });
  });

  it('send in two chunks', () => {
    const zabbixSender = senderFactory();
    const sender = new ZabbixBatchSender({maxBatchSize: 50}, zabbixSender);
    const batch = createBatch(100);
    sender.publishBatch(batch, function(status){
      assert.ok(status);
      assert.equal(status.processed, 100);
      assert.equal(zabbixSender.sendCount, 2);
    });
    sender.complete((status)=>{
      assert.ok(status);
      assert.equal(status.processed, 100);
      assert.equal(zabbixSender.sendCount, 2);
    });
  });
  it('send two batches', () => {
    const zabbixSender = senderFactory();
    const sender = new ZabbixBatchSender({maxBatchSize: 100}, zabbixSender);
    const batch = createBatch(50);
    sender.publishBatch(batch, function(status){
      assert.ok(status);
      assert.equal(status.processed, 50);
      assert.equal(zabbixSender.sendCount, 1);
    });
    sender.publishBatch(batch, function(status){
      assert.ok(status);
      assert.equal(status.processed, 50);
      assert.equal(zabbixSender.sendCount, 2);
    });
    sender.complete((status)=>{
      assert.ok(status);
      assert.equal(status.processed, 100);
      assert.equal(zabbixSender.sendCount, 2);
    });
  });
});
