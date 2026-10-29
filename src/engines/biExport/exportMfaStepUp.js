'use strict';

/**
 * Marco 9, M9-D701 — porta do BI para o MFA recente (step-up) do usuário. A exportação de alto risco a usa para exigir `assertRecentMfa` do solicitante sem forçar o
 * fluxo de MFA por HTTP. Fora de src/features porque o BI não importa serviço de outro módulo (lint BI-001).
 */
const { assertRecentMfa } = require('../../features/users/mfa.service');

module.exports = { assertRecentMfa };
