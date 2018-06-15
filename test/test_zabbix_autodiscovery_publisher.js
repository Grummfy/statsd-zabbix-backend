const assert = require('assert');
const events = require('events');
const logger = require('util');
const sinon = require('sinon');
const zabbix = require('../lib/zabbix');
const publisherFactory = require('../lib/zabbix-autodiscovery-publisher');

const config = {
  debug: true,
  flushInterval: 1,
  zabbixDiscoveryKey: '#AUTO_DISCOVERY_METRIC#',
  zabbixDiscoveryMode: 'simple',
  zabbixPublisher: '../lib/zabbix-autodiscovery-publisher',
  zabbixMaxDiscoveryBatchSize: 4,
  zabbixReportPublishStats: false,
  zabbixItemKeyPrefix: 'stats.["',
  zabbixItemKeySuffix: '"]',
};

const pubStatsConfig = Object.assign({}, config, {
  zabbixReportPublishStats: true,
});

describe('zabbix backend works', () => {
  it('zabbix backend can load publisher', () => {
    const emitter = new events.EventEmitter();
    zabbix.init(0, config, emitter, logger);
  });

  it('publisher emits discovery items', () => {
    logger.log = sinon.spy();
    const emitter = new events.EventEmitter();
    zabbix.init(0, config, emitter, logger);
    emitter.emit('flush', 0, {
      counters: {
        host_key: 5,
        host_second_key: 7,
      },
      timers: {},
      gauges: {},
      pctThreshold: [],
    });
    sinon.assert.called(logger.log);
  });

  it('filter does not emit discovery item second time', () => {
    logger.log = sinon.spy();
    const emitter = new events.EventEmitter();
    const metrics = {
      counters: {
        host_key: 5,
        host_second_key: 7,
      },
      timers: {},
      gauges: {},
      pctThreshold: [],
    };
    zabbix.init(0, config, emitter, logger);
    emitter.emit('flush', 0, metrics);
    emitter.emit('flush', 0, metrics);
    sinon.assert.called(logger.log);
    assert.equal(zabbix.stats.flush_length, 4);
  });
});

describe('zabbix autodiscovery publisher works', () => {
  const createBatch = (len) => {
    const batch = [];
    for (let i = 0; i < len; i += 1) {
      batch.push({
        host: 'host',
        key: `key${i + 1}`,
        value: i + 1,
      });
    }
    return batch;
  };

  const createBatchSender = () => {
    const instance = {
      items: [],
      addFailed: 0,
      publishCount: 0,
    };
    instance.publishBatch = (batch, callback) => {
      let count = 0;
      if (batch) {
        batch.forEach((item) => {
          instance.items.push(item);
          count += 1;
        });
      }
      callback({
        processed: count - instance.addFailed,
        failed: instance.addFailed,
        total: count,
        secondsSpend: 0.1,
      });
      instance.publishCount += 1;
    };

    instance.complete = (callback) => {
      if (callback) {
        callback({
          processed: instance.items.length - instance.addFailed,
          failed: instance.addFailed,
          total: instance.items.length,
          secondsSpend: 0.1,
        });
      }
    };
    return instance;
  };

  it('publisher can init', () => {
    logger.log = sinon.spy();
    const publisher = publisherFactory(config, logger);
    assert.notEqual(publisher, null);
  });

  it('publisher emits discovery item for short batch', () => {
    logger.log = sinon.spy();
    const items = createBatch(2);
    const batchSender = createBatchSender();
    const publisher = publisherFactory(config, logger);
    publisher(items, batchSender);
    assert.equal(batchSender.items.length, 3);
  });

  it('publisher emits discovery items for long batch', () => {
    logger.log = sinon.spy();
    const items = createBatch(6);
    const batchSender = createBatchSender();
    const publisher = publisherFactory(config, logger);
    publisher(items, batchSender);
    assert.equal(batchSender.items.length, 8);
  });

  it('publisher emits discovery item for each item in case of discovery failure', () => {
    logger.log = sinon.spy();
    const items1 = createBatch(4);
    const items2 = items1.slice();
    const batchSender1 = createBatchSender();
    const batchSender2 = createBatchSender();
    const publisher = publisherFactory(config, logger);
    batchSender1.addFailed = 1;
    publisher(items1, batchSender1);
    publisher(items2, batchSender2);
    assert.equal(batchSender2.publishCount, 5);
  });

  it('publisher emits publish stats items', () => {
    logger.log = sinon.spy();
    const items1 = createBatch(2);
    const items2 = items1.slice();
    const items3 = items1.slice();
    const batchSender1 = createBatchSender();
    const batchSender2 = createBatchSender();
    const batchSender3 = createBatchSender();
    const publisher = publisherFactory(pubStatsConfig, logger);
    publisher(items1, batchSender1);
    publisher(items2, batchSender2);
    publisher(items3, batchSender3);
    assert.equal(batchSender1.items.length, 3, 'first time only items + discovery');
    assert.equal(batchSender2.items.length, 7, 'second time items, discovery and publish stats');
    assert.equal(batchSender3.items.length, 6, 'third time items and publish stats');
  });
});

