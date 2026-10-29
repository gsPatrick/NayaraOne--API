'use strict';

const { defineMapper } = require('../defineMapper');

/**
 * Banco, financiamento, seguro, fiscal e assinatura (M9-D219): só o favorecido/signatário/proponente (PERSONAL) e os dados da
 * operação. Financiamento aceita SENSITIVE apenas dos campos exigidos pela promotora e consentidos (consentedFields).
 */
module.exports = {
  bank: {
    submitPayment: defineMapper({
      purpose: 'PAYMENT',
      fields: [
        { name: 'amount', classification: 'INTERNAL', required: true },
        { name: 'currency', classification: 'PUBLIC' },
        {
          name: 'payee',
          from: 'beneficiary',
          classification: 'PERSONAL',
          required: true,
          shape: [{ name: 'name', classification: 'PERSONAL' }, { name: 'document', classification: 'PERSONAL' }, { name: 'account', classification: 'PERSONAL' }],
        },
        { name: 'dueDate', classification: 'INTERNAL' },
        { name: 'description', classification: 'INTERNAL', freeText: true },
      ],
    }),
  },
  signature: {
    createEnvelope: defineMapper({
      purpose: 'DOCUMENT_SIGNATURE',
      fields: [
        { name: 'documentRef', classification: 'CONFIDENTIAL', required: true },
        { name: 'signers', classification: 'PERSONAL', required: true, items: [{ name: 'personId', classification: 'INTERNAL' }, { name: 'name', classification: 'PERSONAL' }, { name: 'email', classification: 'PERSONAL' }, { name: 'role', classification: 'INTERNAL' }] },
      ],
    }),
  },
  financing: {
    submitCase: defineMapper({
      purpose: 'FINANCING_PROPOSAL',
      fields: [
        { name: 'caseRef', classification: 'INTERNAL', required: true },
        { name: 'proponentName', classification: 'PERSONAL', required: true },
        { name: 'proponentDocument', classification: 'PERSONAL', required: true },
        { name: 'propertyValue', classification: 'INTERNAL' },
        { name: 'incomeDeclared', classification: 'SENSITIVE' },
        { name: 'healthDeclaration', classification: 'SENSITIVE' },
      ],
    }),
    simulate: defineMapper({
      purpose: 'FINANCING_PROPOSAL',
      fields: [{ name: 'propertyValue', classification: 'INTERNAL', required: true }, { name: 'downPayment', classification: 'INTERNAL' }, { name: 'termMonths', classification: 'INTERNAL' }],
    }),
  },
  insurance: {
    quote: defineMapper({
      purpose: 'INSURANCE_QUOTE',
      fields: [
        { name: 'insuredName', classification: 'PERSONAL', required: true },
        { name: 'insuredDocument', classification: 'PERSONAL', required: true },
        { name: 'insuredAmount', classification: 'INTERNAL' },
        { name: 'propertyType', classification: 'INTERNAL' },
      ],
    }),
  },
  fiscal: {
    issueNfse: defineMapper({
      purpose: 'FISCAL_ISSUANCE',
      fields: [
        { name: 'takerName', classification: 'PERSONAL', required: true },
        { name: 'takerDocument', classification: 'PERSONAL', required: true },
        { name: 'serviceDescription', classification: 'INTERNAL', freeText: true },
        { name: 'amount', classification: 'INTERNAL', required: true },
      ],
    }),
  },
};
