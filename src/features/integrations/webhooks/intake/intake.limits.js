'use strict';

const { PADROES } = require('./intake.params');

/**
 * Limite de leitura do corpo da conexão (M9-D213 3.2): o parâmetro integration.webhook.max_body_bytes da empresa só aperta o teto da plataforma; o fornecedor
 * que precisa de mais declara `policy_json.webhook.max_body_bytes` na connection, e o valor nunca passa do teto absoluto de 10 MiB (policy acima disso é ignorada).
 */
function bodyLimitFor(paramMaxBytes, policy, platformCeiling) {
  const doFornecedor = policy && policy.webhook && Number.isInteger(policy.webhook.max_body_bytes) ? policy.webhook.max_body_bytes : null;
  if (doFornecedor !== null && doFornecedor >= 1024) return Math.min(doFornecedor, PADROES.providerBodyCeilingBytes);
  return Math.min(paramMaxBytes, platformCeiling);
}

module.exports = { bodyLimitFor };
