'use strict';

/**
 * Marco 9, M9-D701 — porta do BI para as permissões efetivas de um usuário numa empresa (papéis ativos de agora). A exportação a usa para reaplicar a permissão do
 * solicitante no momento da geração. Fora de src/features porque o BI não importa serviço de outro módulo (lint BI-001).
 */
const { getEffectiveAccess } = require('../../features/memberships/effectivePermissions.service');

module.exports = { getEffectiveAccess };
