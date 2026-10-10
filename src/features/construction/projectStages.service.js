'use strict';

const { Op } = require('sequelize');
const { ProjectStage, Project } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishStageCompleted } = require('./constructionEvents.service');
const { assertPredecessorsDone } = require('./stageDependencies.service');

const STATUSES = ['PENDING', 'IN_PROGRESS', 'DONE'];
const STATUS_LABELS_PT = { PENDING: 'Pendente', IN_PROGRESS: 'Em andamento', DONE: 'Concluída' };

// BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 3, mesmo ângulo do MaintenanceCase do ciclo 2):
// `updateProjectStage` só validava que "status" pertencia ao enum, mas aceitava QUALQUER
// transição (DONE->PENDING, PENDING->DONE pulando IN_PROGRESS, IN_PROGRESS->PENDING) via
// chamada direta à API — só o front (que nem chega a mandar "status") limitava visualmente.
// Fix: mesmo grafo de transição válido usado em maintenanceCases.service.js.
const NEXT_STATUS_OPTIONS = {
  PENDING: ['IN_PROGRESS'],
  IN_PROGRESS: ['DONE'],
  DONE: [],
};

function assertValidDateRange(startsAt, endsAt) {
  // BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 11): comparação direta de getTime() nunca
  // disparava pra uma data inválida ("abc") — NaN < NaN é false, deixava passar pro INSERT.
  if (startsAt !== undefined && startsAt !== null && Number.isNaN(new Date(startsAt).getTime())) {
    throw AppError.badRequest('"startsAt" deve ser uma data válida.', 'PROJECT_STAGE_DATE_RANGE_INVALID');
  }
  if (endsAt !== undefined && endsAt !== null && Number.isNaN(new Date(endsAt).getTime())) {
    throw AppError.badRequest('"endsAt" deve ser uma data válida.', 'PROJECT_STAGE_DATE_RANGE_INVALID');
  }
  if (startsAt && endsAt && new Date(endsAt).getTime() < new Date(startsAt).getTime()) {
    throw AppError.badRequest('"endsAt" não pode ser anterior a "startsAt".', 'PROJECT_STAGE_DATE_RANGE_INVALID');
  }
}

// BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 7, 2026-10-06): plannedPct/plannedCost
// (project_stages.planned_pct NUMERIC(9,6) / planned_cost NUMERIC(18,2)) nunca passavam por
// nenhuma validação numérica em createProjectStage/updateProjectStage — iam direto do payload
// pro banco. "NaN"/"Infinity" (string) ou negativo persistiam silenciosamente (Postgres aceita
// o literal), corrompendo a média de plannedProgressPct e o custo projetado em
// projectHealth.service.js (categoria 14 do catálogo de bugs: NaN/Infinity passando por guard
// de sinal — aqui nem havia guard nenhum).
function assertValidPlannedPct(plannedPct) {
  if (plannedPct === undefined || plannedPct === null) return undefined;
  const numeric = Number(plannedPct);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
    throw AppError.badRequest('"plannedPct" deve ser um número entre 0 e 100.', 'PROJECT_STAGE_VALIDATION');
  }
  return numeric;
}

function assertValidPlannedCost(plannedCost) {
  if (plannedCost === undefined || plannedCost === null) return undefined;
  const numeric = Number(plannedCost);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw AppError.badRequest('"plannedCost" deve ser um número maior ou igual a zero.', 'PROJECT_STAGE_VALIDATION');
  }
  return numeric;
}

async function createProjectStage(projectId, payload, actorUserId, transaction) {
  const { groupId, companyId, name, sequence, plannedPct, startsAt, endsAt, stageCode, plannedCost } = payload;
  if (!groupId || !companyId || !name) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "name" são obrigatórios.', 'PROJECT_STAGE_VALIDATION');
  }
  assertValidDateRange(startsAt, endsAt);
  const numericPlannedPct = assertValidPlannedPct(plannedPct);
  const numericPlannedCost = assertValidPlannedCost(plannedCost);

  // BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 16, Frente A, 09/10/2026): createProjectStage
  // nunca buscava o Project — nem validava companyId/groupId cross-field (mesma classe de bug
  // já corrigida em createBudget/createMaintenanceCase/createChangeOrder), nem tomava lock
  // pessimista na linha do Project, serializando contra removeProject concorrente (ver
  // comentário detalhado em projects.service.js#removeProject).
  const project = await Project.findByPk(projectId, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!project) throw AppError.notFound('Obra não encontrada.', 'PROJECT_NOT_FOUND');
  if (project.companyId !== companyId || project.groupId !== groupId) {
    throw AppError.badRequest('Esta obra não pertence à empresa/grupo informado.', 'PROJECT_STAGE_PROJECT_COMPANY_MISMATCH');
  }

  // BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 10, Frente B, 09/10/2026): sequence ia direto
  // pro create sem checar outras etapas da mesma obra — duas etapas podiam ficar com o MESMO
  // sequence (valor repetido informado pelo chamador), quebrando a ordenação de
  // listProjectStages (order by sequence ASC fica indefinida entre as duplicadas). Quando o
  // chamador não informa sequence, auto-incrementa a partir do maior já usado na obra (em vez
  // do antigo default fixo "1", que colidia sempre que mais de uma etapa fosse criada sem
  // informar o campo).
  let resolvedSequence = sequence;
  if (resolvedSequence == null) {
    const maxSequence = await ProjectStage.max('sequence', { where: { projectId }, transaction });
    resolvedSequence = Number.isFinite(Number(maxSequence)) ? Number(maxSequence) + 1 : 1;
  } else {
    const duplicateSequence = await ProjectStage.findOne({ where: { projectId, sequence: resolvedSequence }, transaction });
    if (duplicateSequence) {
      throw AppError.conflict(
        `Já existe uma etapa desta obra com "sequence"=${resolvedSequence} ("${duplicateSequence.name}") — use um valor diferente.`,
        'PROJECT_STAGE_SEQUENCE_DUPLICATE'
      );
    }
  }

  const stage = await ProjectStage.create(
    {
      groupId,
      companyId,
      projectId,
      name,
      stageCode: stageCode || null,
      plannedCost: numericPlannedCost != null ? numericPlannedCost : null,
      sequence: resolvedSequence,
      plannedPct: numericPlannedPct != null ? numericPlannedPct : null,
      measuredPct: null,
      status: 'PENDING',
      startsAt: startsAt || null,
      endsAt: endsAt || null,
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
      action: 'construction.stage.create',
      entityType: 'ProjectStage',
      entityId: stage.id,
      afterJson: stage.toJSON(),
      reason: `Etapa "${stage.name}" criada para a obra ${projectId}.`,
    },
    transaction
  );

  return stage;
}

async function listProjectStages(projectId, transaction) {
  return ProjectStage.findAll({ where: { projectId }, order: [['sequence', 'ASC']], transaction });
}

async function getProjectStage(id, transaction) {
  const stage = await ProjectStage.findByPk(id, { transaction });
  if (!stage) throw AppError.notFound('Etapa de obra não encontrada.', 'PROJECT_STAGE_NOT_FOUND');
  return stage;
}

async function updateProjectStage(id, payload, actorUserId, transaction) {
  // BUG REAL CORRIGIDO (rodada 42): sem lock, duas chamadas concorrentes podiam ambas disparar
  // publishStageCompleted (evento duplicado) na transição pra DONE.
  const stage = await ProjectStage.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!stage) throw AppError.notFound('Etapa de obra não encontrada.', 'PROJECT_STAGE_NOT_FOUND');
  const beforeJson = stage.toJSON();
  const { name, sequence, plannedPct, status, startsAt, endsAt, stageCode, plannedCost } = payload;
  const previousStatus = stage.status;
  if (name !== undefined) stage.name = name;
  if (sequence !== undefined && sequence !== stage.sequence) {
    const duplicateSequence = await ProjectStage.findOne({
      where: { projectId: stage.projectId, sequence, id: { [Op.ne]: stage.id } },
      transaction,
    });
    if (duplicateSequence) {
      throw AppError.conflict(
        `Já existe uma etapa desta obra com "sequence"=${sequence} ("${duplicateSequence.name}") — use um valor diferente.`,
        'PROJECT_STAGE_SEQUENCE_DUPLICATE'
      );
    }
    stage.sequence = sequence;
  }
  if (plannedPct !== undefined) stage.plannedPct = assertValidPlannedPct(plannedPct);
  if (stageCode !== undefined) stage.stageCode = stageCode;
  if (plannedCost !== undefined) stage.plannedCost = assertValidPlannedCost(plannedCost);
  if (status !== undefined) {
    const normalizedStatus = String(status).toUpperCase();
    if (!STATUSES.includes(normalizedStatus)) {
      throw AppError.badRequest(
        `"status" deve ser um de: ${STATUSES.map((s) => STATUS_LABELS_PT[s]).join(', ')}.`,
        'PROJECT_STAGE_STATUS_INVALID'
      );
    }
    if (normalizedStatus !== previousStatus) {
      const allowedNext = NEXT_STATUS_OPTIONS[previousStatus] || [];
      if (!allowedNext.includes(normalizedStatus)) {
        throw AppError.conflict(
          `Não é possível mover a etapa de "${STATUS_LABELS_PT[previousStatus] || previousStatus}" para "${STATUS_LABELS_PT[normalizedStatus] || normalizedStatus}".`,
          'PROJECT_STAGE_STATUS_TRANSITION_INVALID'
        );
      }
    }
    if (normalizedStatus === 'DONE' && previousStatus !== 'DONE') {
      await assertPredecessorsDone(stage.id, transaction);
    }
    stage.status = normalizedStatus;
  }
  if (startsAt !== undefined) stage.startsAt = startsAt;
  if (endsAt !== undefined) stage.endsAt = endsAt;
  assertValidDateRange(
    startsAt !== undefined ? startsAt : stage.startsAt,
    endsAt !== undefined ? endsAt : stage.endsAt
  );

  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 46, 2026-10-05): o contrato
  // (TAB-0701) trata stage_code, planned_cost e planned_start/planned_end como NOT NULL —
  // mesmo gate já aplicado em Project (READY -> ACTIVE): exige os campos no momento em que a
  // etapa de fato começa a ser executada, sem forçá-los na criação (onde ainda podem estar
  // sendo planejados).
  if (previousStatus !== 'IN_PROGRESS' && stage.status === 'IN_PROGRESS') {
    const missing = [];
    if (!stage.stageCode) missing.push('código da etapa (stageCode)');
    if (stage.plannedCost == null) missing.push('custo previsto (plannedCost)');
    if (!stage.startsAt) missing.push('data de início (startsAt)');
    if (!stage.endsAt) missing.push('data de término prevista (endsAt)');
    if (missing.length > 0) {
      throw AppError.badRequest(
        `Não é possível iniciar a etapa sem: ${missing.join(', ')}.`,
        'PROJECT_STAGE_MISSING_REQUIRED_FIELDS'
      );
    }
  }

  stage.updatedBy = actorUserId || null;
  await stage.save({ transaction });

  // M6-72/M6-106: dispara só na transição de fato para DONE (não repete em updates que já
  // estavam DONE) — nome canônico definido em constructionEvents.service.js.
  if (previousStatus !== 'DONE' && stage.status === 'DONE') {
    await publishStageCompleted(stage, transaction);
  }

  await registrarAuditoria(
    {
      groupId: stage.groupId,
      companyId: stage.companyId,
      actorUserId,
      action: 'construction.stage.update',
      entityType: 'ProjectStage',
      entityId: stage.id,
      beforeJson,
      afterJson: stage.toJSON(),
      reason: `Etapa "${stage.name}" atualizada.`,
    },
    transaction
  );

  return stage;
}

module.exports = { createProjectStage, listProjectStages, getProjectStage, updateProjectStage, STATUSES };
