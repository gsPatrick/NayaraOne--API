'use strict';

const { defineMapper } = require('../defineMapper');

/**
 * Seguradoras (M9-D238, sobre a M9-D219): cotação e proposta levam a referência interna da apólice, os valores e, quando a seguradora exige, os dados do segurado (PERSONAL).
 * `providerRequest` é o corpo específico da seguradora (campos que só o adapter dela entende, como a Yelum): sai como um valor só, no teto PERSONAL da família, e o
 * administrador pode abaixar esse teto. Nome e documento do segurado passam a ser opcionais: o fluxo de Compras cota pelo valor segurado e o fornecedor que pede
 * a pessoa recebe pelo corpo próprio dele.
 */
module.exports = {
  quote: defineMapper({
    purpose: 'INSURANCE_QUOTE',
    fields: [
      { name: 'policyRef', classification: 'INTERNAL' },
      { name: 'insuredName', classification: 'PERSONAL' },
      { name: 'insuredDocument', classification: 'PERSONAL' },
      { name: 'insuredAmount', classification: 'INTERNAL' },
      { name: 'propertyType', classification: 'INTERNAL' },
      { name: 'purposeKind', classification: 'INTERNAL' },
      { name: 'providerRequest', classification: 'PERSONAL' },
    ],
  }),
  propose: defineMapper({
    purpose: 'INSURANCE_PROPOSAL',
    fields: [
      { name: 'policyRef', classification: 'INTERNAL', required: true },
      { name: 'quoteRef', classification: 'INTERNAL' },
      { name: 'premiumAmount', classification: 'INTERNAL' },
      { name: 'effectiveDate', classification: 'INTERNAL' },
      { name: 'expiryDate', classification: 'INTERNAL' },
      { name: 'installmentsCount', classification: 'INTERNAL' },
      { name: 'providerRequest', classification: 'PERSONAL' },
    ],
  }),
  submitClaim: defineMapper({
    purpose: 'INSURANCE_CLAIM',
    fields: [
      { name: 'claimRef', classification: 'INTERNAL', required: true },
      { name: 'externalPolicyNumber', classification: 'INTERNAL' },
      { name: 'description', classification: 'INTERNAL', freeText: true },
      { name: 'claimAmount', classification: 'INTERNAL' },
    ],
  }),
};
