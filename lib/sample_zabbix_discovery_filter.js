/*
* Transforms stats before sending to Zabbix (http://www.zabbix.com/).
*
* To enable this filter, include 'simple-discovery-filter'
* in the zabbix backend filters configuration array:
*
*   zabbixPublisher: './zabbix-discovery-publisher'
*   zabbixMaxDiscoveryBatchSize: 
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
 * Helper function that is used to build a metric discovery entry from metric instance.
 * @param {string} itemType Metric type.
 * @param {object} item Metric in form of {host, key, value} object.
 * @returns {object} An object containing auto discovery data for Zabbix. The format depends
 * of the zabbix configuration.
 */
function buildLldEntry(itemType, item) {
  return {
    '#ITEMKEY#': item.key,
    '#ITEMTYPE#': itemType,
  };
}

/**
 * Helper function that is used to wrap or modify a metric item if needed.
 * @param {string} itemType Metric type.
 * @param {object} item Metric in form of {host, key, value} object.
 * @returns {object} An object containing modified metric for Zabbix. The format depends
 * of the zabbix configuration.
 */
function wrapMetricItem(itemType, item) {
  return {
    host: item.host,
    key: `statsd.[${item.key}]`,
    value: item.value,
  };
}

/**
 * Main function that implements metrics filtering logic.
 * @param {object} state Fiter instance state, here the function can store state that lives throug
 * function calls.
 * @param {string} itemType Type of items stored in items array.
 * @param {array} items Array of {host, key, value} objects (metrics).
 * @returns {array} of {host, key, value} objects. Technically, function can return original items
 * array or generate a new one.
 */
function prependDiscoveryItems(state, itemType, items) {
  const localState = state;
  let discoveryItemsCount = 0;
  const discovery = {};
  const result = [];
  items.forEach((item) => {
    if (!localState.discovered[item.key]) {
      const discoveryItem = buildLldEntry(itemType, item);
      const discoveryArray = discovery[item.host] || (discovery[item.host] = []);
      discoveryArray.push(discoveryItem);
      localState.discovered[item.key] = true;
      discoveryItemsCount += 1;
    }
    const wrappedItem = wrapMetricItem(itemType, item);
    result.push(wrappedItem);
  });
  if (discoveryItemsCount > 0) {
    Object.keys(discovery).forEach((discoveryHost) => {
      const discoveryArray = discovery[discoveryHost];
      result.unshift({
        host: discoveryHost,
        key: localState.discoveryKey,
        value: { data: discoveryArray },
      });
    });
    localState.logger.log(`[DEBUG] Discovered ${discovery.length} new metrics`);
  }
  return result;
}

/**
 * Filter instance factory function.
 * @param {object} config Zabbix configuration object.
 * @param {object} logger Zabbix system logger.
 * @returns {function} Initialized instance of the filter.
 */
function filterFactory(config, logger) {
  const state = {
    discoveryKey: config.zabbixDiscoveryKey,
    logger,
    discovered: {},
  };

  return prependDiscoveryItems.bind(undefined, state);
}

module.exports = filterFactory;