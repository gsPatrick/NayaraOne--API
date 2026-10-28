'use strict';

const { registerEventConsumer } = require('../../../engines/events/consumers');
const { onPropertyUpdated, onPropertyPriceChanged } = require('./sourceWatcher');

/** M9-D405: o conteúdo consome os eventos do imóvel (property.updated e property.price.changed) pelo registro de consumidores do outbox. */
const SOURCE_WATCHER = 'marketing.content.source_watcher';

registerEventConsumer('property.updated', SOURCE_WATCHER, onPropertyUpdated);
registerEventConsumer('property.price.changed', SOURCE_WATCHER, onPropertyPriceChanged);

module.exports = { SOURCE_WATCHER };
