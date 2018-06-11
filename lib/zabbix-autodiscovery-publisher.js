/*
* Transforms stats before sending to Zabbix (http://www.zabbix.com/)
* to make possible metrics auto discovery.
*
* To enable this publisher, include 'simple-discovery-filter'
* in the zabbix backend filters configuration array:
*
*   zabbixPublisher:      './zabbix-discovery-publisher'
*   zabbixDiscoveryKey:   defines zabbix discovery key. This value is used as target metric name
*                         to send discovery packages to.
*   zabbixItemKeyPrefix:  prefix to original metric name. This might be necessary for autodiscovery
*                         to work properly
*   zabbixItemKeySuffix:  postfix to original metric name. This might be necessary
*                         for autodiscovery to work properly
*   zabbixMaxDiscoveryBatchSize:
*                         defines maximum discovery package size. As metrics discovery is
*                         a heavy operation, value for this setting should be choosen carefully.
*   zabbixReportPublishStats:
*                         the parameter defines whether this publisher should publish
*                         metric sending statistics to zabbix as a separate metric.
*                         [default: false]
*
* This filter is a simple version of metrics filtering and transformation script. It can be used
* as a basis to build custom metric transformation logic required for a particular scenario
* without customizing original zabbix backend. One of the use cases where it can be helpful
* is the generation of autodiscovery items for zabbix. The provided version does this generation
* with hardcoded discovery keys, data format and for all metrics when they appear for the first
* time.
*
*/

/**
 * Function generates list of metrics for specified stats object skipping those
 * that do not have values or have zero
 * @param {object} stats publishing statistics {processed, failed, total, secondsSpent}
 * @param {string} host zabbix target host name
 * @param {string} prefix metric prefix
 * @param {string} name statistics name
 * @returns {array} array of special stats metrics { host, key, value }
 */
function itemsForStats(stats, host, prefix, name) {
  const items = [];
  if (stats.processed) {
    items.push({
      host,
      key: `${prefix}.${name}_zabbix_processed`,
      value: stats.processed || 0,
    });
  }
  if (stats.failed) {
    items.push({
      host,
      key: `${prefix}.${name}_zabbix_failed`,
      value: stats.failed || 0,
    });
  }
  if (stats.total) {
    items.push({
      host,
      key: `${prefix}.${name}_zabbix_total`,
      value: stats.total || 0,
    });
  }
  if (stats.secondsSpent) {
    items.push({
      host,
      key: `${prefix}.${name}_zabbix_timespent`,
      value: stats.secondsSpent || 0,
    });
  }
  return items;
}

/**
 * Adds publish stats at the beginning of the metrics array
 * @param {Array} items Metric in form of {host, key, value} object.
 * @param {object} state Publisher instance state, here the function can store state that lives
 * through function calls.
 * @returns {void}
 */
function prependPublishStats(items, state) {
  if (state.reportPublishStats && state.publishStats) {
    // determine zabbix target host name
    const localState = state;
    let host = localState.zabbixTargetHostname;
    if (!host && items.length > 0) {
      ([{ host }] = items);
      localState.zabbixTargetHostname = host;
    }
    // if host was not determined, simply skip sending for now
    if (host) {
      const publishStatsItems = itemsForStats(localState.publishStats.metrics, host, localState.prefixStats, 'metric');
      publishStatsItems.forEach((it) => {
        items.unshift(it);
      });
      const discoveryStatsItems = itemsForStats(localState.publishStats.discovery, host, localState.prefixStats, 'discovery');
      discoveryStatsItems.forEach((it) => {
        items.unshift(it);
      });
    }
  }
}

/**
 * Function adds zabbix publish statistics to existing statistics object
 * @param {object} stats aggregated publish statistics {processed, failed, total, secondsSpent}
 * @param {object} zabbixState zabbis status response object
 * @returns {void}
 */
function updatePublishStats(stats, zabbixState) {
  const mutableStats = stats;
  mutableStats.processed = (mutableStats.processed || 0) + (zabbixState.processed || 0);
  mutableStats.failed = (mutableStats.failed || 0) + (zabbixState.failed || 0);
  mutableStats.total = (mutableStats.total || 0) + (zabbixState.total || 0);
  mutableStats.secondsSpent = (mutableStats.secondsSpent || 0.0)
    + (zabbixState.secondsSpent || 0.0);
}


/**
 * Determines whether a metric needs to be send to zabbix. Being corrected,
 * this function allows to filter metrics sent to zabbix easily. This in turn
 * allows to decrease load on zabbix.
 * @param {object} item Metric item in form of {host, key, value} object.
 * @returns {boolean} true if the metric needs to be send to zabbix
 */
function shouldSendMetric(item) { // eslint-disable-line no-unused-vars
  return true;
}

/**
 * Helper function that is used to build a metric discovery entry from metric instance.
 * @param {object} item Metric in form of {host, key, value} object.
 * @returns {object} An object containing auto discovery data for Zabbix. The format depends
 * of the zabbix configuration.
 */
function buildLldEntry(item) {
  const unknown = 'unknown';
  const splitter = '.';
  const parts = item.key.split(splitter);
  const discoveryItem = {
    '{#ITEMNAME}': item.key,
    '{#APPLICATION}': parts.length > 0 ? parts[0] : unknown,
    '{#ENVIRONMENT}': parts.length > 1 ? parts[1] : unknown,
    '{#LAYER}': parts.length > 2 ? parts[2] : unknown,
    '{#COMPONENT}': parts.length > 3 ? parts[3] : unknown,
    '{#METRIC}': parts.length > 4 ? parts.slice(4).join(splitter) : unknown,
  };

  return discoveryItem;
}

/**
 * Helper function that is used to wrap or modify a metric item if needed.
 * @param {object} item Metric in form of {host, key, value} object.
 * @param {object} state Filter instance state, here the function can store state that lives throug
 * function calls.
 * @returns {object} An object containing modified metric for Zabbix. The format depends
 * of the zabbix configuration.
 */
function wrapMetric(item, state) {
  return {
    host: item.host,
    key: `${state.keyPrefix}${item.key}${state.keySuffix}`,
    value: item.value,
  };
}

/**
 * Main function that implements metrics filtering logic.
 * @param {object} state Filter instance state, here the function can store state that lives throug
 * function calls.
 * @param {array} items Array of {host, key, value} objects (metrics).
 * @param {object} batchSender Zabbix batch sender.
 * @returns {array} of {host, key, value} objects. Technically, function can return original items
 * array or generate a new one.
 */
function publishItems(state, items, batchSender) {
  // declare variables
  const localState = state;
  let discoveryItemsCount = 0;
  const discovery = {};
  const dataItems = [];
  const publishStats = {
    metrics: {},
    discovery: {},
  };

  // process and clean publish stats
  prependPublishStats(items, localState);
  localState.publishStats = publishStats;

  items.forEach((item) => {
    if (shouldSendMetric(item)) {
      // check whether the metric is being sent for the first time
      // if so, generate autodiscovery entry for it
      if (localState.discovered[item.key] !== 1) {
        const isBroken = localState.discovered[item.key] === -1;
        const discoveryItem = buildLldEntry(item);
        const hostDiscovery = discovery[item.host] || (discovery[item.host] = { items: [], keys: [] }); // eslint-disable-line max-len
        const discoveryArray = isBroken ? [] : hostDiscovery.items;
        const discoveryKeys = isBroken ? [] : hostDiscovery.keys;
        discoveryArray.push(discoveryItem);
        discoveryKeys.push(item.key);
        // in case collected list of autodicovery items reached batch limit, format and publish it
        if (discoveryArray.length >= state.maxDiscoveryBatchSize || isBroken) {
          const discoveryEntry = {
            host: item.host,
            key: localState.discoveryKey,
            value: JSON.stringify({ data: discoveryArray }),
          };
          batchSender.publishBatch([discoveryEntry], (response) => {
            updatePublishStats(publishStats.discovery, response, localState.debug);
            const success = (response.failed === 0);
            const discoveryStatus = success ? 1 : -1;
            discoveryKeys.forEach((key) => {
              localState.discovered[key] = discoveryStatus;
            });
            if (localState.debug) {
              localState.logger.log(`[DEBUG] ${module.name}: Publishing zabbix autodiscovery item: ${JSON.stringify(discoveryEntry)}`);
            }
            if (isBroken && !success) {
              localState.logger.log(`[ERROR] ${module.name}: Autodiscovery does not work for ${item.key}`);
            }
          });
          // cleanup per-host discovery if this block was executed not for broken item
          if (!isBroken) {
            delete discovery[item.host];
          }
        }
        if (!isBroken) {
          discoveryItemsCount += discoveryKeys.length;
        }
      }
    }
    const wrappedItem = wrapMetric(item, state);
    dataItems.push(wrappedItem);
  });

  // check if there are unsent autodiscovery items, publish them first
  if (discoveryItemsCount > 0) {
    Object.keys(discovery).forEach((discoveryHost) => {
      const discoveryArray = discovery[discoveryHost].items;
      const discoveryKeys = discovery[discoveryHost].keys;
      const discoveryEntry = {
        host: discoveryHost,
        key: localState.discoveryKey,
        value: JSON.stringify({ data: discoveryArray }),
      };
      batchSender.publishBatch([discoveryEntry], (response) => {
        updatePublishStats(publishStats.discovery, response, localState.debug);
        const success = (response.failed === 0);
        const discoveryStatus = success ? 1 : -1;
        discoveryKeys.forEach((key) => {
          localState.discovered[key] = discoveryStatus;
        });
        if (success) {
          discoveryItemsCount += discoveryKeys.length;
        }
        if (localState.debug) {
          localState.logger.log(`[DEBUG] ${module.name}: Publishing zabbix autodiscovery item: ${JSON.stringify(discoveryEntry)}`);
        }
        if (!success) {
          const ks = discoveryKeys.join(', ');
          localState.logger.log(`[ERROR] ${module.name}: Autodiscovery does not work for one of the following keys: ${ks}`);
        }
      });
    });
  }

  // publish real metrics
  if (dataItems.length > 0) {
    batchSender.publishBatch(dataItems, (response) => {
      updatePublishStats(publishStats.metrics, response, localState.debug);
    });
  }

  // report metrics publishing completed
  batchSender.complete((stats) => {
    if (localState.debug) {
      localState.logger.log(`[DEBUG] ${module.name}: Zabbix status for all item types: ${stats.statusMessage}`);
    }
  });
}

/**
 * Filter instance factory function.
 * @param {object} config Zabbix configuration object.
 * @param {object} logger Zabbix system logger.
 * @returns {function} Initialized instance of the filter.
 */
function filterFactory(config, logger) {
  const state = {
    debug: config.debug || false,
    zabbixTargetHostname: config.zabbixTargetHostname,
    prefixStats: config.prefixStats || 'statsd',
    discoveryKey: config.zabbixDiscoveryKey,
    maxDiscoveryBatchSize: config.zabbixMaxDiscoveryBatchSize || Number.MAX_VALUE,
    reportPublishStats: config.zabbixReportPublishStats,
    keyPrefix: config.zabbixItemKeyPrefix || '',
    keySuffix: config.zabbixItemKeySuffix || '',
    logger,
    discovered: {},
  };

  return publishItems.bind(undefined, state);
}

module.exports = filterFactory;