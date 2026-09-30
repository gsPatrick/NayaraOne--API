'use strict';

const { StageDependency } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

/**
 * M6-03/M6-19/M6-56 — dependência entre etapas de obra, sem permitir ciclo.
 *
 * Uma dependência "stageId depende de dependsOnStageId" só pode ser criada se, hoje, não
 * existir NENHUM caminho no grafo de dependências que já ligue `dependsOnStageId` de volta a
 * `stageId` — ou seja, se `dependsOnStageId` (direta ou indiretamente) já depende de `stageId`,
 * criar essa aresta fecharia um ciclo (A depende de B, B depende de A, ou uma cadeia mais longa
 * A->B->C->A). A checagem é feita com uma busca em profundidade (DFS) a partir de
 * `dependsOnStageId`, seguindo as arestas "depende de" já existentes — se alcançarmos
 * `stageId`, bloqueamos.
 */
async function wouldCreateCycle(stageId, dependsOnStageId, transaction) {
  const visited = new Set();
  const stack = [dependsOnStageId];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === stageId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const edges = await StageDependency.findAll({ where: { stageId: current }, transaction });
    for (const edge of edges) {
      if (!visited.has(edge.dependsOnStageId)) {
        stack.push(edge.dependsOnStageId);
      }
    }
  }

  return false;
}

async function createStageDependency(stageId, payload, actorUserId, transaction) {
  const { groupId, companyId, dependsOnStageId } = payload;
  if (!groupId || !companyId || !dependsOnStageId) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "dependsOnStageId" são obrigatórios.', 'STAGE_DEPENDENCY_VALIDATION');
  }
  if (stageId === dependsOnStageId) {
    throw AppError.badRequest('Uma etapa não pode depender de si mesma.', 'STAGE_DEPENDENCY_SELF_REFERENCE');
  }

  const existing = await StageDependency.findOne({ where: { stageId, dependsOnStageId }, transaction });
  if (existing) {
    throw AppError.conflict('Essa dependência já existe.', 'STAGE_DEPENDENCY_DUPLICATE');
  }

  const createsCycle = await wouldCreateCycle(stageId, dependsOnStageId, transaction);
  if (createsCycle) {
    throw AppError.badRequest(
      'Esta dependência criaria um ciclo entre etapas (dependência circular).',
      'STAGE_DEPENDENCY_CYCLE'
    );
  }

  const dependency = await StageDependency.create(
    {
      groupId,
      companyId,
      stageId,
      dependsOnStageId,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.stage_dependency.create',
      entityType: 'StageDependency',
      entityId: dependency.id,
      afterJson: dependency.toJSON(),
      reason: `Etapa ${stageId} passou a depender da etapa ${dependsOnStageId}.`,
    },
    transaction
  );

  return dependency;
}

async function listStageDependencies(stageId, transaction) {
  return StageDependency.findAll({ where: { stageId }, transaction });
}

module.exports = { createStageDependency, listStageDependencies, wouldCreateCycle };
