'use strict';

// Apoio dos testes da M9-D016/D017: definições de tool de teste e a lista fechada de permissões que o registro aceita.

const PERMISSION_CODES = new Set(['ai:use', 'ai:read', 'ai:admin', 'crm:opportunities:read', 'crm:tasks:create', 'finance:read', 'finance:create', 'legal:read', 'legal:create']);

/** Definição válida de tool de leitura; `extra` sobrescreve campos para montar o caso inválido. */
function defValida(extra = {}) {
  return {
    name: 'teste.lerAlgo',
    version: 1,
    description: 'Lê um registro de teste.',
    permissionCode: 'ai:use',
    riskLevel: 'LOW',
    category: 'READ',
    domain: 'OTHER',
    inputSchema: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { id: { type: 'string' }, nome: { type: 'string' } }, required: ['id'], additionalProperties: false },
    requiresHumanApproval: false,
    idempotent: true,
    execute: async () => ({ id: 'x', nome: 'y' }),
    ...extra,
  };
}

/** Definição de escrita; os parâmetros mudam domínio, risco e aprovação. */
const defEscrita = (domain, riskLevel, requiresHumanApproval, extra = {}) => defValida({
  name: `teste.escrever${domain}${riskLevel}`, category: 'WRITE', domain, riskLevel, requiresHumanApproval, idempotent: false, ...extra,
});

const ID = '5b1c2e0a-3f4d-4a6b-9c7d-1a2b3c4d5e6f';
const LIMITES = Object.freeze({ stringMax: 500, arrayMax: 50 });

module.exports = { PERMISSION_CODES, ID, LIMITES, defValida, defEscrita };
