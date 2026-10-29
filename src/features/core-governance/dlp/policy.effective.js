'use strict';

const { resolveClassification } = require('./classification.resolver');
const policyService = require('./policy.service');

/**
 * Política EFETIVA de um pedido (M9-D820 critério 6): a classe vem do resolvedor de classificação (registro de M9-D910; a classe padrão sem registro é de lá)
 * e a política é a linha da empresa para (classe, ação). Devolve { classification, policy }.
 */
async function effectivePolicy(tenant, { resources, action }, transaction) {
  const classification = await resolveClassification(tenant, resources, transaction);
  return { classification, policy: await policyService.getPolicy(tenant, classification, action, transaction) };
}

module.exports = { effectivePolicy };
