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
  zabbixItemKeyPrefix: 'stats.["',
  zabbixItemKeySuffix: '"]',
};

const pubStatsConfig = Object.assign({}, config, {
  zabbixPublishItems: {
    discoveryStats: { enabled: true },
    metricsStats: { enabled: true },
  },
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

describe('zabbix sender utils - metric key split', () => {
  const state = {
    discoverySegmentsSeparator: '.',
    discoverySegmentsCount: 5,
  };

  it('splitMetricKey works for short keys', () => {
    const key = 'root.short_key';
    const result = publisherFactory.splitMetricKey(key, state);
    assert.ok(result);
    assert.equal(Object.keys(result).length, 5);
    assert.equal(result['{#COMPONENT1}'], 'root');
    assert.equal(result['{#COMPONENT2}'], 'short_key');
    assert.equal(result['{#COMPONENT3}'], '');
    assert.equal(result['{#COMPONENT4}'], '');
    assert.equal(result['{#COMPONENT5}'], '');
  });

  it('splitMetricKey works for keys with configured number of segments', () => {
    const key = 'seg1.seg2.seg3.seg4.seg5';
    const result = publisherFactory.splitMetricKey(key, state);
    assert.ok(result);
    assert.equal(Object.keys(result).length, 5);
    assert.equal(result['{#COMPONENT1}'], 'seg1');
    assert.equal(result['{#COMPONENT2}'], 'seg2');
    assert.equal(result['{#COMPONENT3}'], 'seg3');
    assert.equal(result['{#COMPONENT4}'], 'seg4');
    assert.equal(result['{#COMPONENT5}'], 'seg5');
  });

  it('splitMetricKey works for long keys', () => {
    const key = 'root.seg1.seg2-comp.seg3.seg4.seg6.tail_key';
    const result = publisherFactory.splitMetricKey(key, state);
    assert.ok(result);
    assert.equal(Object.keys(result).length, 5);
    assert.equal(result['{#COMPONENT1}'], 'root');
    assert.equal(result['{#COMPONENT2}'], 'seg1');
    assert.equal(result['{#COMPONENT3}'], 'seg2-comp');
    assert.equal(result['{#COMPONENT4}'], 'seg3');
    assert.equal(result['{#COMPONENT5}'], 'seg4.seg6.tail_key');
  });
});

describe('zabbix sender utils - zabbix key quote', () => {
  it('quoteZabbixKey does nothing for empty key', () => {
    const key = '';
    const quotedKey = publisherFactory.quoteZabbixKey(key);
    assert.equal(quotedKey, '');
  });

  it('quoteZabbixKey does nothing for simple key', () => {
    const key = 'root.short_key';
    const quotedKey = publisherFactory.quoteZabbixKey(key);
    assert.equal(quotedKey, 'root.short_key');
  });

  it('quoteZabbixKey quotes if first item is opening square bracket', () => {
    const key = '[root.short_key';
    const quotedKey = publisherFactory.quoteZabbixKey(key);
    assert.equal(quotedKey, '"[root.short_key"');
  });

  it('quoteZabbixKey does quotes if opening square bracket is in the middle', () => {
    const key = 'ro[ot.short_key';
    const quotedKey = publisherFactory.quoteZabbixKey(key);
    assert.equal(quotedKey, 'ro[ot.short_key');
  });

  it('quoteZabbixKey quotes if last item is closing square bracket', () => {
    const key = 'root.short_key]';
    const quotedKey = publisherFactory.quoteZabbixKey(key);
    assert.equal(quotedKey, '"root.short_key]"');
  });

  it('quoteZabbixKey quotes if exist closing square bracket char in the key', () => {
    const key = 'root.sho]rt_key';
    const quotedKey = publisherFactory.quoteZabbixKey(key);
    assert.equal(quotedKey, '"root.sho]rt_key"');
  });

  it('quoteZabbixKey quotes if exist comma char', () => {
    const key = 'root.sho,rt_key';
    const quotedKey = publisherFactory.quoteZabbixKey(key);
    assert.equal(quotedKey, '"root.sho,rt_key"');
  });
});

describe('zabbix sender utils - wrap metric', () => {
  const baseState = {
    keyPrefix: 'statsd.[',
    keySuffix: ']',
    discoveryMode: 'none',
    discoverySegmentsSeparator: '.',
    discoverySegmentsCount: 5,
  };

  const metric = {
    host: 'my-host-01',
    key: 'root.user_app.business-layer.repository_component.load-time[avg]',
    value: 1.5,
  };

  it('quoteZabbixKey does nothing for wrap mode none', () => {
    const state = Object.assign({}, baseState, { discoveryMode: 'none' });
    const result = publisherFactory.wrapMetric(metric, state);
    assert.ok(result);
    assert.equal(result.host, 'my-host-01');
    assert.equal(result.key, 'statsd.[root.user_app.business-layer.repository_component.load-time[avg]]');
    assert.equal(result.value, 1.5);
  });

  it('quoteZabbixKey escapes key for wrap mode simple', () => {
    const state = Object.assign({}, baseState, { discoveryMode: 'simple' });
    const result = publisherFactory.wrapMetric(metric, state);
    assert.ok(result);
    assert.equal(result.host, 'my-host-01');
    assert.equal(result.key, 'statsd.["root.user_app.business-layer.repository_component.load-time[avg]"]');
    assert.equal(result.value, 1.5);
  });

  it('quoteZabbixKey escapes key parts for wrap mode simple', () => {
    const state = Object.assign({}, baseState, { discoveryMode: 'detailed' });
    const result = publisherFactory.wrapMetric(metric, state);
    assert.ok(result);
    assert.equal(result.host, 'my-host-01');
    assert.equal(result.key, 'statsd.[root,user_app,business-layer,repository_component,"load-time[avg]"]');
    assert.equal(result.value, 1.5);
  });
});

describe('zabbix sender utils - build lld items', () => {
  const baseState = {
    discoveryMode: 'none',
    discoverySegmentsSeparator: '.',
    discoverySegmentsCount: 5,
  };

  const metric = {
    host: 'my-host-01',
    key: 'root.user_app.business-layer.repository_component.load-time[avg]',
    value: 1.5,
  };

  it('buildLldEntry returns null for discovery mode none', () => {
    const state = Object.assign({}, baseState, { discoveryMode: 'none' });
    const result = publisherFactory.buildLldEntry(metric, state);
    assert.equal(result, null);
  });

  it('buildLldEntry returns simple LLD item for discovery mode simple', () => {
    const state = Object.assign({}, baseState, { discoveryMode: 'simple' });
    const result = publisherFactory.buildLldEntry(metric, state);
    assert.ok(result);
    assert.equal(result['{#ITEMNAME}'], 'root.user_app.business-layer.repository_component.load-time[avg]');
  });

  it('buildLldEntry returns simple LLD item for discovery mode simple', () => {
    const state = Object.assign({}, baseState, { discoveryMode: 'detailed' });
    const result = publisherFactory.buildLldEntry(metric, state);
    assert.ok(result);
    assert.equal(result['{#COMPONENT1}'], 'root');
    assert.equal(result['{#COMPONENT2}'], 'user_app');
    assert.equal(result['{#COMPONENT3}'], 'business-layer');
    assert.equal(result['{#COMPONENT4}'], 'repository_component');
    assert.equal(result['{#COMPONENT5}'], 'load-time[avg]');
  });
});

describe('zabbix sender utils - prepend publish stats', () => {
  const baseState = {
    reportPublishStats: true,
    publishItems: {
      metricsStats: { enabled: true },
      discoveryStats: { enabled: true },
    },
    publishStats: [{
      metrics: {
        processed: 10,
        failed: 1,
        total: 11,
        secondsSpent: 0.18,
      },
      discovery: {
        processed: 4,
        failed: 1,
        total: 5,
        secondsSpent: 1.3,
      },
    }],

    discoverySegmentsSeparator: '.',
    discoverySegmentsCount: 5,
  };

  const baseItems = [{
    host: 'my-host-01',
    key: 'root.user_app.business-layer.repository_component.load-time[avg]',
    value: 1.5,
  }];

  it('prependPublishStats generates 8 stats items', () => {
    const state = JSON.parse(JSON.stringify(baseState));
    const items = baseItems.slice();
    publisherFactory.prependPublishStats(items, state);
    assert.equal(items.length, 9);
  });

  it('prependPublishStats does not generate items for zero values when no nonzero values before', () => {
    const state = JSON.parse(JSON.stringify(baseState));
    state.publishStats[0].metrics.failed = 0;
    const items = baseItems.slice();
    publisherFactory.prependPublishStats(items, state);
    assert.equal(items.length, 8);
  });

  it('prependPublishStats generates items for zero values when prev values was not zero', () => {
    const state = JSON.parse(JSON.stringify(baseState));
    state.publishStats[0].metrics.failed = 0;
    state.publishStatsPrev = {
      metrics: {
        failed: 1,
      },
    };
    const items = baseItems.slice();
    publisherFactory.prependPublishStats(items, state);
    assert.equal(items.length, 9);
  });
});
