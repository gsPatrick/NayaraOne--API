'use strict';

const { uuid, obj } = require('./_schema');

module.exports = {
  name: 'legal.draftContract',
  version: 1,
  description: 'Cria a minuta (rascunho) de um contrato. Sempre proposta: a minuta só nasce após aprovação humana.',
  permissionCode: 'legal:create',
  riskLevel: 'HIGH',
  category: 'WRITE',
  domain: 'LEGAL',
  requiresHumanApproval: true,
  idempotent: false,
  entityRefs: [{ arg: 'opportunityId', entity: 'crmOpportunity' }, { arg: 'propertyId', entity: 'property' }],
  inputSchema: obj({
    contractType: { type: 'string', enum: ['SALE', 'SALE_CASH', 'SALE_FINANCED', 'SALE_TRADE', 'SALE_INSTALLMENTS', 'LEASE', 'LEASE_RESIDENTIAL', 'LEASE_COMMERCIAL', 'LEASE_SEASONAL', 'PROPERTY_ADMIN', 'SERVICE'], description: 'Tipo do contrato.' },
    opportunityId: uuid('Oportunidade de origem.'), propertyId: uuid('Imóvel do contrato.'),
  }, ['contractType']),
  outputSchema: { type: 'object', properties: { id: { type: 'string' }, contractNumber: { type: ['string', 'null'] }, status: { type: 'string' } }, required: ['id', 'status'] },
  execute: (ctx, input) => ctx.services.legalDrafts.createDraft(input),
};
