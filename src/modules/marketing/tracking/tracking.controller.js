'use strict';

const service = require('./tracking.service');

// Corpo da rota: M9-D431.
const attribution = async () => service.pendingOwner('M9-D431');

module.exports = { attribution };
