'use strict';

const { MaterialRequest } = require('../../../../../models');
const { createMaterialRequest } = require('../../../../construction/materialRequests.service');
const { resolveRef } = require('../refs');
const { commandRejected } = require('../../bcp.errors');
const normalize = require('../normalize');

const keyOf = (tenant, reference) => `bcp:${tenant.companyId}:${reference}`;
const MARK = ' [BCP ';
/** O material fica no INÍCIO da descrição; urgência, solicitante e o número do formulário vêm depois da marca (a conferência lê o que foi gravado). */
const describe = (operation, payload) => `${payload.material}${MARK}${operation.manualReference}; urgência ${payload.urgencia}; solicitante ${payload.solicitante}]`;
const materialOf = (description) => String(description || '').split(MARK)[0];

/**
 * MATERIAL_REQUEST: a requisição do papel vira requisição de material da obra pelo serviço normal (status REQUESTED, aguardando o fluxo normal de recebimento).
 * Confere obra, material e quantidade. O serviço normal não cancela requisição, então a divergência desta ação só pode ser aceita (reverse recusa).
 */
async function execute({ tenant, actorUserId, operation, payload, transaction }) {
  const project = await resolveRef('project', payload.obra, tenant, transaction);
  const request = await createMaterialRequest(project.id, {
    groupId: tenant.groupId, companyId: tenant.companyId, description: describe(operation, payload), quantity: payload.quantidade, unit: payload.unidade, idempotencyKey: keyOf(tenant, operation.manualReference),
  }, actorUserId, transaction);
  const saved = await MaterialRequest.findByPk(request.id, { transaction });
  return {
    commandRef: `MaterialRequest:${saved.id}`,
    undo: { materialRequestId: saved.id },
    comparisons: [
      { field: 'obra', label: 'Obra', paper: normalize.id(project.id), command: normalize.id(saved.projectId), kind: 'ref' },
      { field: 'material', label: 'Material', paper: normalize.text(payload.material), command: normalize.text(materialOf(saved.description)), kind: 'text' },
      { field: 'quantidade', label: 'Quantidade', paper: Number(payload.quantidade), command: Number(saved.quantity), kind: 'number' },
    ],
  };
}

async function reverse() {
  throw commandRejected('a requisição de material não tem cancelamento no serviço de Obras; aceite a divergência ou trate a requisição pelo próprio módulo de Obras');
}

module.exports = { action: 'MATERIAL_REQUEST', execute, reverse };
