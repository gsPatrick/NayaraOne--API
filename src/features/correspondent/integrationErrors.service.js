'use strict';

const { IntegrationError } = require('../../models');

/**
 * Grava correspondent.integration_errors quando a integração falha.
 * A mensagem é de negócio. Corpo do provider, stack e segredo não entram.
 */
async function recordIntegrationError(
  { groupId, companyId, financingCaseId, providerCode, operation, errorCode, message },
  transaction
) {
  return IntegrationError.create(
    {
      groupId,
      companyId,
      financingCaseId: financingCaseId || null,
      providerCode,
      operation,
      errorCode,
      message: String(message || '').slice(0, 500),
    },
    { transaction }
  );
}

module.exports = { recordIntegrationError };
