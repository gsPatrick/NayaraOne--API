'use strict';

const service = require('./publications.service');

// Corpo da rota: M9-D410.
const list = async () => service.pendingOwner('M9-D410');

module.exports = { list };
