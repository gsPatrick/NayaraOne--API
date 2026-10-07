'use strict';

const { StageDependency, ProjectStage, sequelize } = require('../../models');
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

/**
 * BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 8): `wouldCreateCycle` (DFS) + `StageDependency.create`
 * é um clássico "leitura sem lock antes de decisão" (Categoria 1 do catálogo). Sem serialização,
 * duas requisições concorrentes criando as arestas opostas de um mesmo par de etapas (ex.:
 * A depende de B, disparada ao mesmo tempo que B depende de A) podem AMBAS rodar o DFS antes de
 * qualquer uma commitar o INSERT — nenhuma das duas arestas existe ainda quando a outra faz a
 * busca, então nenhuma acusa ciclo, e as duas são aceitas, fechando um ciclo de 2 nós direto no
 * banco. Fix: mesma receita de `projects.service.js#generateProjectCode` e
 * `marginRules.service.js#createMarginRuleAttempt` — `pg_advisory_xact_lock` serializa todo
 * create de dependência para o mesmo projeto (grafo é por obra) ANTES do DFS, eliminando a
 * corrida (a segunda transação só roda seu DFS depois que a primeira já commitou a aresta).
 */
async function createStageDependency(stageId, payload, actorUserId, transaction) {
  const { groupId, companyId, dependsOnStageId } = payload;
  if (!groupId || !companyId || !dependsOnStageId) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "dependsOnStageId" são obrigatórios.', 'STAGE_DEPENDENCY_VALIDATION');
  }
  if (stageId === dependsOnStageId) {
    throw AppError.badRequest('Uma etapa não pode depender de si mesma.', 'STAGE_DEPENDENCY_SELF_REFERENCE');
  }

  const stage = await ProjectStage.findByPk(stageId, { transaction, paranoid: false });
  if (!stage) {
    throw AppError.notFound('Etapa de obra não encontrada.', 'STAGE_DEPENDENCY_STAGE_NOT_FOUND');
  }

  // BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 18): `dependsOnStageId` nunca era validado
  // contra a existência/obra da etapa dependente — só `stageId` tinha um findByPk. Isso permitia
  // duas falhas reais: (1) criar uma dependência apontando pra um UUID de etapa de OUTRA obra
  // (ex.: etapa de FUND-01 da Obra A "depende de" uma etapa qualquer da Obra B, sem sentido de
  // negócio nenhum — dependência de sequenciamento só existe dentro da mesma obra) e (2) o único
  // caminho de rejeição para um UUID inexistente era deixar o INSERT estourar a FK constraint
  // crua do banco (erro 500 não tratado) em vez de um 400/404 de negócio claro. Valida aqui,
  // fail-closed, ANTES do lock/DFS.
  const dependsOnStage = await ProjectStage.findByPk(dependsOnStageId, { transaction, paranoid: false });
  if (!dependsOnStage) {
    throw AppError.notFound('"dependsOnStageId" não corresponde a uma etapa existente.', 'STAGE_DEPENDENCY_TARGET_NOT_FOUND');
  }
  if (dependsOnStage.projectId !== stage.projectId) {
    throw AppError.badRequest(
      'Uma etapa só pode depender de outra etapa da MESMA obra.',
      'STAGE_DEPENDENCY_CROSS_PROJECT'
    );
  }

  const lockKey = `stage_dependency:${stage.projectId}`;
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', {
    replacements: { lockKey },
    transaction,
  });

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
