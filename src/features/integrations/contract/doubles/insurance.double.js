'use strict';

/**
 * Objeto antigo duplo das seguradoras reais (Porto Seguro e Yelum) para a suíte de contrato (M9-D238 + M9-D222): a mesma interface dos adapters antigos (quote, issuePolicy,
 * getPolicyStatus, submitClaim), determinístico e sem rede ou credencial. A proposta é idempotente pela chave, como a seguradora real faz com o cabeçalho de idempotência.
 */
function makeInsuranceDouble() {
  const propostas = new Map();
  return {
    async quote(req) {
      return { externalId: `cotacao-contrato-${Number(req.estimatedValue || 0)}`, premiumAmount: 100, coverageSummary: 'Cobertura de laboratório', raw: { sandbox: true } };
    },
    async issuePolicy(req) {
      const chave = req.idempotencyKey || `sem-chave-${propostas.size}`;
      if (!propostas.has(chave)) propostas.set(chave, `apolice-contrato-${propostas.size + 1}`);
      return { externalId: propostas.get(chave), policyNumber: 'APL-0001', status: 'ISSUED', raw: { sandbox: true } };
    },
    async getPolicyStatus(externalId) {
      return { externalId, status: 'ACTIVE', raw: { sandbox: true } };
    },
    async submitClaim(req) {
      return { externalId: `sinistro-contrato-${String(req.idempotencyKey || 'x').slice(-6)}`, status: 'UNDER_REVIEW', raw: { sandbox: true } };
    },
  };
}

module.exports = { makeInsuranceDouble };
