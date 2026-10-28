'use strict';

const service = require('./campaigns.service');

// Corpo da rota: M9-D412.
const create = async () => service.pendingOwner('M9-D412');

module.exports = { create };
