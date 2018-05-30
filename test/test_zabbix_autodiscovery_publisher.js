const assert = require('assert');
const events = require('events');
const logger = require('util');
const sinon = require('sinon');
const zabbix = require('../lib/zabbix');

const config = {
  flushInterval: 1,
  zabbixDiscoveryKey: '#AUTO_DISCOVERY_METRIC#',
  zabbixFilters: ['../lib/zabbix-autodiscovery-publisher'],
};

describe('filtering works', () => {
  it('zabbix backend can load filters', () => {
    const emitter = new events.EventEmitter();
    zabbix.init(0, config, emitter, logger);
    assert.equal(zabbix.allFilters().length, 1);
  });

  it('filter emits discovery items', () => {
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
    assert.equal(zabbix.stats.flush_length, 6);
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
