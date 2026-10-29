'use strict';

const { uuid, nullable, obj } = require('../../../tools/definitions/_schema');

const version = (description) => ({ type: 'integer', minimum: 1, maximum: 100000, description });
const sourceItem = { type: 'object', properties: { title: { type: 'string' }, version: nullable('string'), clause: nullable('string'), excerpt: nullable('string'), values: { type: 'array', items: { type: 'string' } } } };
const clauseRef = { type: 'object', properties: { id: { type: 'string' }, code: { type: 'string' }, title: { type: 'string' }, version: { type: 'integer' } } };
const versionRef = { type: 'object', properties: { number: { type: 'integer' }, id: { type: 'string' }, contentHash: nullable('string') } };

module.exports = {
  name: 'legal.compareVersions',
  version: 1,
  description: 'Compara duas versões de um contrato: cláusulas incluídas e excluídas e os trechos alterados, cada um com a versão e o trecho.',
  permissionCode: 'legal:read',
  riskLevel: 'LOW',
  category: 'READ',
  domain: 'OTHER',
  requiresHumanApproval: false,
  idempotent: true,
  entityRefs: [{ arg: 'contractId', entity: 'legalContract' }],
  inputSchema: obj({ contractId: uuid('Identificador do contrato.'), fromVersion: version('Número da versão de origem.'), toVersion: version('Número da versão de destino.') }, ['contractId', 'fromVersion', 'toVersion']),
  outputSchema: {
    type: 'object',
    properties: {
      contractId: { type: 'string' }, contractNumber: nullable('string'), from: versionRef, to: versionRef, identical: { type: 'boolean' },
      clausesAdded: { type: 'array', items: clauseRef }, clausesRemoved: { type: 'array', items: clauseRef },
      changes: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, versionNumber: { type: 'integer' }, excerpt: nullable('string') } } },
      totalChanges: { type: 'integer' }, groundingSources: { type: 'array', items: sourceItem }, asOf: { type: 'string' },
    },
    required: ['contractId', 'from', 'to', 'identical', 'clausesAdded', 'clausesRemoved', 'changes', 'totalChanges', 'asOf'],
  },
  execute: (ctx, input) => ctx.services.legalNay.compareVersions(input.contractId, input.fromVersion, input.toVersion),
};
