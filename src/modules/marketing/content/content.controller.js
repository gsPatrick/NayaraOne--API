'use strict';

const service = require('./content.service');

// Corpos das rotas: M9-D406 (criar), M9-D408 (aprovar), M9-D410 (agendar).
const create = async () => service.pendingOwner('M9-D406');
const approve = async () => service.pendingOwner('M9-D408');
const schedule = async () => service.pendingOwner('M9-D410');

module.exports = { create, approve, schedule };
