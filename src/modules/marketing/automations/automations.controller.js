'use strict';

const service = require('./automations.service');

// Corpos das rotas: M9-D413.
const create = async () => service.pendingOwner('M9-D413');
const publish = async () => service.pendingOwner('M9-D413');
const pause = async () => service.pendingOwner('M9-D413');

module.exports = { create, publish, pause };
