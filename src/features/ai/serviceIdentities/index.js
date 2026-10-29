'use strict';

const service = require('./serviceIdentities.service');
const { isReadOnlyPermission, READ_ACTIONS } = require('./serviceIdentities.constants');
const { registerServiceIdentityRoutes } = require('./serviceIdentities.routes');

/** Identidade de serviço da NAY (M9-D017): só leitura, uma por empresa e agente, usada por jobs sem usuário. */
module.exports = { ...service, isReadOnlyPermission, READ_ACTIONS, registerServiceIdentityRoutes };
