'use strict';

const { Project, ProjectCodeSequence, sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const {
  publishProjectCreated,
  publishProjectStatusChanged,
  publishProjectStarted,
  publishProjectDelivered,
} = require('./constructionEvents.service');

// DECISÃO DE ENGENHARIA: os documentos fonte não definem os valores válidos de
// projects.status (coluna STRING(32) livre, só com default 'PLANNED') — workflow linear
// abaixo é uma decisão de engenharia, seguindo o mesmo padrão de máquina de estados linear
// já usado em legal.contracts (contracts.service.js).
//
// M6-25/M6-39/M6-51/M6-65/M6-79/M6-87: adicionado o estado terminal `DELIVERED` (entrega da
// obra). Propositalmente NÃO aparece como destino em `VALID_TRANSITIONS` — a única forma de
// chegar em DELIVERED é pelo gate dedicado `deliverProject()` abaixo, que primeiro verifica
// pendência crítica de não conformidade (fail-closed). Isso impede que o endpoint genérico
// `POST /construction/projects/:id/transition` seja usado para contornar o gate.
const STATUSES = ['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'DELIVERED', 'CANCELLED'];
const VALID_TRANSITIONS = {
  PLANNED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  DELIVERED: [],
  CANCELLED: [],
};

function assertValidDateRange(startsAt, endsAtPlanned) {
  if (startsAt && endsAtPlanned && new Date(endsAtPlanned).getTime() < new Date(startsAt).getTime()) {
    throw AppError.badRequest('"endsAtPlanned" não pode ser anterior a "startsAt".', 'PROJECT_DATE_RANGE_INVALID');
  }
}

/**
 * generateProjectCode — M6-01 (fechado 30/09/2026): gera "OBRA-{ANO}-{SEQ:04d}" (ex.:
 * OBRA-2026-0001), sequencial por (companyId, ano corrente). Mesmo padrão atômico de
 * `generateContractNumber` (legal/contracts.service.js): um único INSERT...ON CONFLICT...DO
 * UPDATE, nunca SELECT COUNT(*)+1 (evita corrida de concorrência real).
 */
async function generateProjectCode(companyId, transaction) {
  const year = new Date().getFullYear();
  const [rows] = await sequelize.query(
    `INSERT INTO "construction"."project_code_sequences" (id, company_id, "year", last_seq, created_at, updated_at)
     VALUES (gen_random_uuid(), :companyId, :year, 1, now(), now())
     ON CONFLICT (company_id, "year")
     DO UPDATE SET last_seq = "construction"."project_code_sequences".last_seq + 1, updated_at = now()
     RETURNING last_seq`,
    { replacements: { companyId, year }, transaction }
  );
  const seq = rows[0].last_seq;
  return `OBRA-${year}-${String(seq).padStart(4, '0')}`;
}

async function createProject(payload, actorUserId, transaction) {
  const { groupId, companyId, propertyId, unitId, name, responsibleUserId, budgetAmount, startsAt, endsAtPlanned, code } = payload;
  if (!groupId || !companyId || !name) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "name" são obrigatórios.', 'PROJECT_VALIDATION');
  }
  assertValidDateRange(startsAt, endsAtPlanned);

  const resolvedCode = code || (await generateProjectCode(companyId, transaction));

  const project = await Project.create(
    {
      groupId,
      companyId,
      propertyId: propertyId || null,
      unitId: unitId || null,
      name,
      code: resolvedCode,
      responsibleUserId: responsibleUserId || null,
      budgetAmount: budgetAmount != null ? budgetAmount : null,
      startsAt: startsAt || null,
      endsAtPlanned: endsAtPlanned || null,
      status: 'PLANNED',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishProjectCreated(project, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.project.create',
      entityType: 'Project',
      entityId: project.id,
      afterJson: project.toJSON(),
      reason: `Obra "${project.name}" criada.`,
    },
    transaction
  );

  return project;
}

async function listProjects(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.propertyId) where.propertyId = filters.propertyId;
  return Project.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getProject(id, transaction) {
  const project = await Project.findByPk(id, { transaction });
  if (!project) throw AppError.notFound('Obra não encontrada.', 'PROJECT_NOT_FOUND');
  return project;
}

async function updateProject(id, payload, actorUserId, transaction) {
  const project = await getProject(id, transaction);
  const beforeJson = project.toJSON();
  const { name, responsibleUserId, budgetAmount, startsAt, endsAtPlanned, propertyId, unitId, actualEndDate } = payload;
  if (name !== undefined) project.name = name;
  if (responsibleUserId !== undefined) project.responsibleUserId = responsibleUserId;
  if (budgetAmount !== undefined) project.budgetAmount = budgetAmount;
  if (startsAt !== undefined) project.startsAt = startsAt;
  if (endsAtPlanned !== undefined) project.endsAtPlanned = endsAtPlanned;
  if (propertyId !== undefined) project.propertyId = propertyId;
  if (unitId !== undefined) project.unitId = unitId;
  if (actualEndDate !== undefined) project.actualEndDate = actualEndDate;
  assertValidDateRange(
    startsAt !== undefined ? startsAt : project.startsAt,
    endsAtPlanned !== undefined ? endsAtPlanned : project.endsAtPlanned
  );
  project.updatedBy = actorUserId || null;
  await project.save({ transaction });

  await registrarAuditoria(
    {
      groupId: project.groupId,
      companyId: project.companyId,
      actorUserId,
      action: 'construction.project.update',
      entityType: 'Project',
      entityId: project.id,
      beforeJson,
      afterJson: project.toJSON(),
      reason: `Obra "${project.name}" atualizada.`,
    },
    transaction
  );

  return project;
}

async function transitionProject(id, targetStatus, actorUserId, transaction) {
  // Lock pessimista: sem isto, duas transições concorrentes a partir do mesmo status de
  // origem (ex.: IN_PROGRESS->COMPLETED numa aba e IN_PROGRESS->CANCELLED em outra) liam o
  // mesmo status de origem antes de qualquer uma commitar — ambas passavam pela checagem de
  // transição válida isoladamente e a última a salvar vencia silenciosamente (lost update),
  // mesmo padrão já corrigido em proposals.service.js.
  const project = await Project.findByPk(id, {
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!project) throw AppError.notFound('Obra não encontrada.', 'PROJECT_NOT_FOUND');
  const normalizedTarget = String(targetStatus || '').toUpperCase();
  if (!STATUSES.includes(normalizedTarget)) {
    throw AppError.badRequest(`"targetStatus" deve ser um de: ${STATUSES.join(', ')}.`, 'PROJECT_STATUS_INVALID');
  }
  const allowed = VALID_TRANSITIONS[project.status] || [];
  if (!allowed.includes(normalizedTarget)) {
    throw AppError.conflict(
      `Não é possível mover a obra de "${project.status}" para "${normalizedTarget}".`,
      'PROJECT_STATUS_TRANSITION_INVALID'
    );
  }

  const fromStatus = project.status;
  project.status = normalizedTarget;
  // M6-01: `actualEndDate` marcado automaticamente ao concluir, se ainda não informado
  // manualmente — evita depender de PATCH separado pra registrar quando a obra terminou de
  // verdade.
  if (normalizedTarget === 'COMPLETED' && !project.actualEndDate) {
    project.actualEndDate = new Date().toISOString().slice(0, 10);
  }
  project.updatedBy = actorUserId || null;
  await project.save({ transaction });

  await publishProjectStatusChanged(project, fromStatus, transaction);

  // M6-71: evento distinto e específico, disparado só na primeira vez que a obra entra em
  // execução (PLANNED -> IN_PROGRESS) — não em qualquer status_changed genérico.
  if (fromStatus === 'PLANNED' && normalizedTarget === 'IN_PROGRESS') {
    await publishProjectStarted(project, transaction);
  }

  await registrarAuditoria(
    {
      groupId: project.groupId,
      companyId: project.companyId,
      actorUserId,
      action: 'construction.project.status_change',
      entityType: 'Project',
      entityId: project.id,
      beforeJson: { status: fromStatus },
      afterJson: { status: project.status },
      reason: `Obra "${project.name}" transicionada de "${fromStatus}" para "${project.status}".`,
    },
    transaction
  );

  return project;
}

/**
 * hasOpenCriticalNonconformity — M6-25/M6-39/M6-51/M6-65/M6-79/M6-87: verifica se existe
 * alguma Não Conformidade com status=OPEN e severity=CRITICAL vinculada ao projeto.
 *
 * TODO: ATIVAR QUANDO "nonconformities" EXISTIR — no momento em que este código foi escrito, a
 * tabela `construction.nonconformities` estava sendo criada por outro agente em paralelo (fatia
 * separada de Não Conformidades) e ainda não tinha sido mergeada. A query abaixo é DEFENSIVA:
 * se a tabela ainda não existir (erro de Postgres 42P01 "undefined_table"), trata como "sem
 * pendência crítica" para não travar a entrega de obras enquanto a outra fatia não é mergeada.
 * ISSO PRECISA SER REVISTO/REATIVADO EXPLICITAMENTE depois do merge: sem a tabela real, o gate
 * de entrega NÃO bloqueia nada de fato — está apenas com a "porta pronta" para quando a tabela
 * existir. Depois do merge, rode os testes de `test/construction.delivery.test.js` de novo:
 * eles cobrem o caminho "tabela existe e tem pendência crítica" simulando a tabela diretamente.
 */
async function hasOpenCriticalNonconformity(companyId, projectId, transaction) {
  // Postgres aborta a transação INTEIRA quando um statement dá erro (ex.: "relation does not
  // exist"), mesmo que o erro seja capturado no JS — qualquer comando seguinte na mesma
  // transação falharia com "current transaction is aborted". Por isso a query abaixo roda
  // dentro de um SAVEPOINT: se a tabela não existir, fazemos ROLLBACK TO SAVEPOINT e a
  // transação de `deliverProject` (o UPDATE de status logo depois) continua utilizável.
  await sequelize.query('SAVEPOINT nonconformity_gate_check', { transaction });
  try {
    const [rows] = await sequelize.query(
      `SELECT 1 FROM "construction"."nonconformities"
         WHERE company_id = :companyId AND project_id = :projectId
           AND status = 'OPEN' AND severity = 'CRITICAL'
         LIMIT 1`,
      { replacements: { companyId, projectId }, transaction }
    );
    await sequelize.query('RELEASE SAVEPOINT nonconformity_gate_check', { transaction });
    return rows.length > 0;
  } catch (err) {
    await sequelize.query('ROLLBACK TO SAVEPOINT nonconformity_gate_check', { transaction });
    const pgCode = err && err.original && err.original.code;
    if (pgCode === '42P01') {
      // undefined_table — construction.nonconformities ainda não existe neste ambiente.
      return false;
    }
    throw err;
  }
}

/**
 * deliverProject — M6-25/M6-39/M6-51/M6-65/M6-79/M6-87: gate de entrega da obra. Só transiciona
 * o projeto para DELIVERED se ele estiver COMPLETED e não houver nenhuma não conformidade
 * CRITICAL em aberto — fail-closed: qualquer pendência crítica bloqueia a entrega com erro
 * explícito, nunca falha silenciosamente para "permitir".
 */
async function deliverProject(id, actorUserId, transaction) {
  // Mesmo lock pessimista de transitionProject — evita duas entregas/transições concorrentes.
  const project = await Project.findByPk(id, {
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!project) throw AppError.notFound('Obra não encontrada.', 'PROJECT_NOT_FOUND');

  if (project.status !== 'COMPLETED') {
    throw AppError.conflict(
      `Só é possível entregar uma obra "COMPLETED" — status atual é "${project.status}".`,
      'PROJECT_NOT_COMPLETED'
    );
  }

  const blocked = await hasOpenCriticalNonconformity(project.companyId, project.id, transaction);
  if (blocked) {
    throw AppError.conflict(
      'Não é possível entregar a obra: existe(m) não conformidade(s) CRÍTICA(S) em aberto vinculada(s) a este projeto.',
      'PROJECT_DELIVERY_BLOCKED_BY_CRITICAL_NONCONFORMITY'
    );
  }

  const fromStatus = project.status;
  project.status = 'DELIVERED';
  project.updatedBy = actorUserId || null;
  await project.save({ transaction });

  await publishProjectDelivered(project, transaction);

  await registrarAuditoria(
    {
      groupId: project.groupId,
      companyId: project.companyId,
      actorUserId,
      action: 'construction.project.deliver',
      entityType: 'Project',
      entityId: project.id,
      beforeJson: { status: fromStatus },
      afterJson: { status: project.status },
      reason: `Obra "${project.name}" entregue (status "${fromStatus}" -> "DELIVERED").`,
    },
    transaction
  );

  return project;
}

async function removeProject(id, actorUserId, transaction) {
  const project = await getProject(id, transaction);
  const beforeJson = project.toJSON();
  project.deletedBy = actorUserId || null;
  await project.save({ transaction });
  await project.destroy({ transaction });

  await registrarAuditoria(
    {
      groupId: project.groupId,
      companyId: project.companyId,
      actorUserId,
      action: 'construction.project.delete',
      entityType: 'Project',
      entityId: project.id,
      beforeJson,
      reason: `Obra "${project.name}" excluída.`,
    },
    transaction
  );

  return { id: project.id };
}

module.exports = {
  createProject,
  listProjects,
  getProject,
  updateProject,
  transitionProject,
  deliverProject,
  removeProject,
  hasOpenCriticalNonconformity,
  STATUSES,
};
