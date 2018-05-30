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
*   zabbixMaxDiscoveryBatchSize: 
*                         defines maximum discovery package size. As metrics discovery is 
*                         a heavy operation, value for this setting should be choosen carefully.
*   zabbixReportPublishStats: 
*                         the parameter defines whether this publisher should publish 
*                         metric sending statistics to zabbix as a separate metric.
*                         [default: false]
*
* This filter is a simple version of metrics filtering and tranformation script. It can be used
* as a basis to build custom metric transformation logic required for a particular scenario
* without customizizing original zabbix backend. One of the use cases where it can be helpful
* is the genaration of autodiscovery items for zabbix. The provided version does this generation
* with hardcoded discovery keys, data format and for all metrics when they appear for the first
* time.
*
*/

/**
 * 
 * @param {Array} items Metric in form of {host, key, value} object.
 * @param {object} state Fiter instance state, here the function can store state that lives throug
 * function calls.
 */
function prependPublishStats(items, state){
  if (state.reportPublishStats) {
    // determine zabbix target host name
    const localState = zabbixTargetHostname;
    let host = localState.zabbixTargetHostname;
    if (!host && items.length > 0) {
      host = items[0].host;
      localState.zabbixTargetHostname = host;
    }
    // if host was not determined, simply skip sending for now
    if (host) {
      items.unshift({
        host,
        key: `${localState.prefixStats}.metrics_zabbix_processed`,
        value: localState.publishStats.processed,
      });
      items.unshift({
        host,
        key: `${localState.prefixStats}.metrics_zabbix_failed`,
        value: localState.publishStats.failed,
      });
      items.unshift({
        host,
        key: `${localState.prefixStats}.metrics_zabbix_total`,
        value: localState.publishStats.total,
      });
      items.unshift({
        host,
        key: `${localState.prefixStats}.metrics_zabbix_seconds`,
        value: localState.publishStats.secondsSpent,
      });
    }
  }
}

/**
 * Determines whether a metric needs to be send to zabbix. Being corrected,
 * this function allows to filter metrics sent to zabbix easily. This in turn
 * allows to decrease load on zabbix.
 * @param {Object} item Metric item in form of {host, key, value} object.
 * @returns {boolean} true if the metric needs to be send to zabbix
 */
function shouldSendMetric(item) {
  return true;
}

/**
 * Helper function that is used to build a metric discovery entry from metric instance.
 * @param {string} itemType Metric type.
 * @param {object} item Metric in form of {host, key, value} object.
 * @returns {object} An object containing auto discovery data for Zabbix. The format depends
 * of the zabbix configuration.
 */
function buildLldEntry(item) {
  const parts = item.key.split('.');
  const unknown = 'unknown';
  const descoveryItem = {
    '{#ITEMNAME}': item.key,
    '{#APPLICATION}': parts.length > 0 ? parts[0] : unknown,
    '{#ENVIRONMENT}': parts.length > 1 ? parts[1] : unknown,
    '{#LAYER}': parts.length > 2 ? parts[2] : unknown,
    '{#COMPONENT}': parts.length > 3 ? parts[3] : unknown,
  };

  return descoveryItem;
}

/**
 * Helper function that is used to wrap or modify a metric item if needed.
 * @param {string} itemType Metric type.
 * @param {object} item Metric in form of {host, key, value} object.
 * @returns {object} An object containing modified metric for Zabbix. The format depends
 * of the zabbix configuration.
 */
function wrapMetricItem(item) {
  return {
    host: item.host,
    key: `statd.["${item.key}"]`,
    value: item.value,
  };
}

/**
 * Main function that implements metrics filtering logic.
 * @param {object} state Fiter instance state, here the function can store state that lives throug
 * function calls.
 * @param {array} items Array of {host, key, value} objects (metrics).
 * @param {object} batchSender Zabbix batch sender.
 * @returns {array} of {host, key, value} objects. Technically, function can return original items
 * array or generate a new one.
 */
//TODO: fix comments above
function publishItems(state, items, batchSender) {
  const localState = state;
  let discoveryItemsCount = 0;
  const discovery = {};
  const dataItems = [];
  prependPublishStats(items, localState);
  items.forEach((item) => {
    if (shouldSendMetric(item)) {
      // check whether the metric is being sent for the first time
      // if so, generate autodiscovery entry for it
      if (!localState.discovered[item.key]) {
        const discoveryItem = buildLldEntry(item);
        const discoveryArray = discovery[item.host] || (discovery[item.host] = []);
        discoveryArray.push(discoveryItem);
        // in case collected list of autodicovery items reached batch limit, format and publish it
        if (discoveryArray.length >= state.maxDiscoveryBatchSize){
          const discoveryItem = {
            host: item.host,
            key: localState.discoveryKey,
            value: JSON.stringify({ data: discoveryArray }),
          };
          batchSender.publishBatch([discoveryItem]);
          delete discovery[item.host];
          if (localState.debug){
            localState.logger.log(`[DEBUG] ${module.name}: Publishing zabbix autodiscovery item: ${JSON.stringify(discoveryItem)}`);
          }
        }
        localState.discovered[item.key] = true;
        discoveryItemsCount += 1;
      }
    }
    const wrappedItem = wrapMetricItem(item);
    dataItems.push(wrappedItem);
  });

  // check if there were autodiscovery items, publish them first
  if (discoveryItemsCount > 0) {
    Object.keys(discovery).forEach((discoveryHost) => {
      const discoveryArray = discovery[discoveryHost];
      const discoveryItem = {
        host: discoveryHost,
        key: localState.discoveryKey,
        value: JSON.stringify({ data: discoveryArray }),
      };
      //TODO: add callback to publishBatch for discovery items and do all the logging there
      batchSender.publishBatch([discoveryItem]);
      if (localState.debug){
        localState.logger.log(`[DEBUG] ${module.name}: Publishing zabbix autodiscovery item: ${JSON.stringify(discoveryItem)}`);
      }
    });
    localState.logger.log(`[DEBUG] Discovered ${discovery.length} new metrics`);
  }

  // publish real metrics
  if (dataItems.length > 0) {
    batchSender.publishBatch(dataItems);
  }

  // report metrics publishing completed
  batchSender.complete((stats) => {
    state.publishStats = stats;
    if (localState.debug){
      localState.logger.log(`[DEBUG] ${module.name}: Zabbix status: ${stats.statusMessage}`);
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
    prefixStats: config.prefixStats || "statsd",
    discoveryKey: config.zabbixDiscoveryKey,
    maxDiscoveryBatchSize: config.zabbixMaxDiscoveryBatchSize || Number.MAX_VALUE,
    reportPublishStats: config.zabbixReportPublishStats,
    logger,
    discovered: {},
    publishStats: {},
  };

  return publishItems.bind(undefined, state);
}

module.exports = filterFactory;