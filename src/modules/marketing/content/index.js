'use strict';

const router = require('./content.routes');
const service = require('./content.service');
require('./registerConsumers'); // M9-D405: consumidores property.updated / property.price.changed

module.exports = { router, service };
