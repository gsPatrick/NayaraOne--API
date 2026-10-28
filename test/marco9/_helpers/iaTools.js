'use strict';

// Apoio dos testes da NAY (M9-D018, M9-D021): contexto, gravador de tool calls e fábrica de tool com schema.
const UUID_A = '5b1c2e0a-3f4d-4a6b-9c7d-1a2b3c4d5e6f';
const UUID_B = '7d8e9f00-1122-4344-8566-778899aabbcc';

const auth = { userId: 'u-1', permissions: ['crm:read'] };

function partes(over = {}) {
  return {
    auth, companyId: 'c-1', groupId: 'g-1', services: {}, readModels: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} }, correlationId: 'corr-1', ...over,
  };
}

function gravador() {
  const linhas = [];
  const eventos = [];
  return { linhas, eventos, record: async (l) => { linhas.push(l); }, emit: async (e) => { eventos.push(e); } };
}

const LIMITES = Object.freeze({ stringMax: 500, arrayMax: 50 });

/** Tool de leitura com o schema informado; `chamadas` conta quantas vezes a execução aconteceu. */
function toolComSchema(inputSchema, over = {}) {
  const chamadas = [];
  const tool = {
    name: 'crm.getOpportunity', version: 1, riskLevel: 'LOW', category: 'READ', domain: 'OTHER', requiresHumanApproval: false,
    inputSchema, execute: async (_ctx, input) => { chamadas.push(input); return { ok: true }; }, ...over,
  };
  return { tool, chamadas };
}

const schemaOportunidade = () => ({
  type: 'object',
  properties: { opportunityId: { type: 'string', format: 'uuid' }, limite: { type: 'integer', minimum: 1, maximum: 100, default: 10 } },
  required: ['opportunityId'],
});

module.exports = { UUID_A, UUID_B, auth, partes, gravador, LIMITES, toolComSchema, schemaOportunidade };
