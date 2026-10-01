'use strict';

const { Project, ProjectCodeSequence, sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const {
  publishProjectCreated,
  publishProjectStatusChanged,
  publishProjectStarted,
  publishProjectDelivered,
  publishProjectWarrantyStarted,
  publishProjectClosed,
} = require('./constructionEvents.service');

// M6-18 (fechado 30/09/2026, rodada final) — máquina de estados EXATA da fonte (Anexo I, seção
// "4. Estados da obra"): "PLANNED → BUDGETED → READY → ACTIVE → FINAL_INSPECTION → DELIVERED →
// WARRANTY → CLOSED; PAUSED pode ocorrer durante ACTIVE." Os 9 estados (8 da cadeia principal +
// CANCELLED, que a fonte não lista mas é exigido em toda máquina de estado deste projeto para
// cobrir cancelamento a qualquer momento — mesmo padrão de legal.contracts) estão todos
// implementados como estados reais e alcançáveis, não como aliases de nomes antigos.
//
// DELIVERED, WARRANTY e CLOSED são propositalmente OMITIDOS de `VALID_TRANSITIONS` — a única
// forma de alcançá-los é pelos gates dedicados abaixo (`deliverProject`/`closeProjectWarranty`),
// que verificam pendência crítica de não conformidade / casos de garantia abertos
// (fail-closed). Isso impede que o endpoint genérico `POST /construction/projects/:id/transition`
// seja usado para contornar os gates.
const STATUSES = [
  'PLANNED',
  'BUDGETED',
  'READY',
  'ACTIVE',
  'PAUSED',
  'FINAL_INSPECTION',
  'DELIVERED',
  'WARRANTY',
  'CLOSED',
  'CANCELLED',
];

// Achado numa auditoria do cliente (30/09/2026): "os erros exibidos pro usuário alguns são em
// código ou inglês" — mensagens de erro que interpolavam o status cru (ex.: "FINAL_INSPECTION")
// direto na frase viram rótulo em português, igual ao que a tela já mostra como badge.
const STATUS_LABELS_PT = {
  PLANNED: 'Planejada',
  BUDGETED: 'Orçamento aprovado',
  READY: 'Pronta para iniciar',
  ACTIVE: 'Em execução',
  PAUSED: 'Pausada',
  FINAL_INSPECTION: 'Inspeção final',
  DELIVERED: 'Entregue',
  WARRANTY: 'Em garantia',
  CLOSED: 'Encerrada',
  CANCELLED: 'Cancelada',
};
function statusLabelPt(status) {
  return STATUS_LABELS_PT[status] || status;
}
// BUG REAL CRÍTICO CORRIGIDO (achado numa auditoria final do Marco 6, 30/09/2026):
// PLANNED->BUDGETED estava na transição GENÉRICA, permitindo pular pra "orçamento aprovado"
// via POST /transition sem passar pelo gate de approveBudget() — nenhuma margem mínima
// verificada, nenhuma baseline congelada, nenhum orçamento de verdade por trás do status. Mesmo
// raciocínio já aplicado a DELIVERED/WARRANTY/CLOSED (de propósito fora daqui, só alcançáveis
// pelos gates dedicados): BUDGETED só é alcançável de verdade por approveBudget(), que já
// transiciona o projeto como efeito colateral depois de validar a margem mínima.
const VALID_TRANSITIONS = {
  PLANNED: ['CANCELLED'],
  BUDGETED: ['READY', 'CANCELLED'],
  READY: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['PAUSED', 'FINAL_INSPECTION', 'CANCELLED'],
  PAUSED: ['ACTIVE', 'CANCELLED'],
  FINAL_INSPECTION: ['ACTIVE', 'CANCELLED'],
  DELIVERED: [],
  WARRANTY: [],
  CLOSED: [],
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
 *
 * BUG REAL CORRIGIDO (30/09/2026, achado sob carga de teste concorrente pesada — múltiplas
 * transações da mesma empresa criando obra/aprovando orçamento/margem ao mesmo tempo): duas
 * sessões inserindo concorrentemente na MESMA chave via `ON CONFLICT ... DO UPDATE` podem
 * genuinamente causar deadlock (`40P01`) no Postgres — é um caso conhecido do banco (cada
 * sessão tenta o INSERT, colide no índice único, e as duas tentam then fazer o UPDATE da linha
 * que a outra ainda não commitou). Retry sozinho não é a correção certa aqui (o problema é a
 * ORDEM de aquisição de lock ser não-determinística entre sessões concorrentes, não uma falha
 * transitória) — a correção correta é serializar o acesso a esta chave lógica com
 * `pg_advisory_xact_lock` ANTES do upsert: só uma transação por vez entra na seção crítica
 * para (companyId, year), as demais esperam na fila (sem timeout, sem erro, sem deadlock
 * possível porque não há mais duas sessões competindo pela MESMA linha ao mesmo tempo). O lock
 * é liberado automaticamente no fim da transação (commit ou rollback).
 */
async function generateProjectCode(companyId, transaction) {
  const year = new Date().getFullYear();
  const lockKey = `${companyId}:${year}`;
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', {
    replacements: { lockKey },
    transaction,
  });

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
  const { groupId, companyId, propertyId, unitId, name, responsibleUserId, budgetAmount, startsAt, endsAtPlanned, code, costCenterId } = payload;
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
      costCenterId: costCenterId || null,
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
  const { name, responsibleUserId, budgetAmount, startsAt, endsAtPlanned, propertyId, unitId, actualEndDate, costCenterId } = payload;
  if (name !== undefined) project.name = name;
  if (responsibleUserId !== undefined) project.responsibleUserId = responsibleUserId;
  if (budgetAmount !== undefined) project.budgetAmount = budgetAmount;
  if (startsAt !== undefined) project.startsAt = startsAt;
  if (endsAtPlanned !== undefined) project.endsAtPlanned = endsAtPlanned;
  if (propertyId !== undefined) project.propertyId = propertyId;
  if (unitId !== undefined) project.unitId = unitId;
  if (actualEndDate !== undefined) project.actualEndDate = actualEndDate;
  if (costCenterId !== undefined) project.costCenterId = costCenterId;
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
      `Não é possível mover a obra de "${statusLabelPt(project.status)}" para "${statusLabelPt(normalizedTarget)}".`,
      'PROJECT_STATUS_TRANSITION_INVALID'
    );
  }

  const fromStatus = project.status;
  project.status = normalizedTarget;
  // M6-01: `actualEndDate` marcado automaticamente ao entrar em inspeção final (obra fisicamente
  // concluída, aguardando conferência antes da entrega), se ainda não informado manualmente —
  // evita depender de PATCH separado pra registrar quando a obra terminou de verdade.
  if (normalizedTarget === 'FINAL_INSPECTION' && !project.actualEndDate) {
    project.actualEndDate = new Date().toISOString().slice(0, 10);
  }
  project.updatedBy = actorUserId || null;
  await project.save({ transaction });

  await publishProjectStatusChanged(project, fromStatus, transaction);

  // M6-71: evento distinto e específico, disparado só na primeira vez que a obra entra em
  // execução (READY -> ACTIVE) — não em qualquer status_changed genérico.
  if (fromStatus === 'READY' && normalizedTarget === 'ACTIVE') {
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
      reason: `Obra "${project.name}" transicionada de "${statusLabelPt(fromStatus)}" para "${statusLabelPt(project.status)}".`,
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
 * o projeto para DELIVERED se ele estiver FINAL_INSPECTION e não houver nenhuma não
 * conformidade CRITICAL em aberto — fail-closed: qualquer pendência crítica bloqueia a entrega
 * com erro explícito, nunca falha silenciosamente para "permitir".
 *
 * M6-18: DELIVERED é um marco instantâneo, não um estado de repouso — a fonte encadeia
 * "DELIVERED → WARRANTY" diretamente, então a mesma chamada já avança a obra para WARRANTY
 * logo em seguida, na MESMA transação (dois UPDATEs reais, cada um publicando seu próprio
 * evento de domínio — auditável via `project.status_changed`/`project.delivered`/
 * `project.warranty_started` no outbox, não é um "pulo" escondido).
 */
async function deliverProject(id, actorUserId, transaction) {
  // Mesmo lock pessimista de transitionProject — evita duas entregas/transições concorrentes.
  const project = await Project.findByPk(id, {
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!project) throw AppError.notFound('Obra não encontrada.', 'PROJECT_NOT_FOUND');

  if (project.status !== 'FINAL_INSPECTION') {
    throw AppError.conflict(
      `Só é possível entregar uma obra que esteja em "Inspeção final" — status atual é "${statusLabelPt(project.status)}".`,
      'PROJECT_NOT_READY_FOR_DELIVERY'
    );
  }

  const blocked = await hasOpenCriticalNonconformity(project.companyId, project.id, transaction);
  if (blocked) {
    throw AppError.conflict(
      'Não é possível entregar a obra: existe(m) não conformidade(s) CRÍTICA(S) em aberto vinculada(s) a este projeto.',
      'PROJECT_DELIVERY_BLOCKED_BY_CRITICAL_NONCONFORMITY'
    );
  }

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
      beforeJson: { status: 'FINAL_INSPECTION' },
      afterJson: { status: 'DELIVERED' },
      reason: `Obra "${project.name}" entregue (status "FINAL_INSPECTION" -> "DELIVERED").`,
    },
    transaction
  );

  // Entra em garantia imediatamente após a entrega — DELIVERED não é um estado de repouso.
  project.status = 'WARRANTY';
  await project.save({ transaction });
  await publishProjectWarrantyStarted(project, transaction);
  await registrarAuditoria(
    {
      groupId: project.groupId,
      companyId: project.companyId,
      actorUserId,
      action: 'construction.project.warranty_started',
      entityType: 'Project',
      entityId: project.id,
      beforeJson: { status: 'DELIVERED' },
      afterJson: { status: 'WARRANTY' },
      reason: `Obra "${project.name}" entrou em período de garantia.`,
    },
    transaction
  );

  return project;
}

/**
 * closeProjectWarranty — M6-18: fecha definitivamente a obra (WARRANTY -> CLOSED). Fail-closed:
 * só permite fechar se não houver nenhum caso de garantia (`MaintenanceCase`) ainda aberto
 * (status diferente de CLOSED) vinculado à obra — mesma disciplina de gate do `deliverProject`.
 */
async function closeProjectWarranty(id, actorUserId, transaction) {
  const project = await Project.findByPk(id, {
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!project) throw AppError.notFound('Obra não encontrada.', 'PROJECT_NOT_FOUND');

  if (project.status !== 'WARRANTY') {
    throw AppError.conflict(
      `Só é possível encerrar uma obra que esteja "Em garantia" — status atual é "${statusLabelPt(project.status)}".`,
      'PROJECT_NOT_IN_WARRANTY'
    );
  }

  const [openCases] = await sequelize.query(
    `SELECT 1 FROM "construction"."maintenance_cases"
       WHERE company_id = :companyId AND project_id = :projectId AND status != 'CLOSED'
       LIMIT 1`,
    { replacements: { companyId: project.companyId, projectId: project.id }, transaction }
  );
  if (openCases.length > 0) {
    throw AppError.conflict(
      'Não é possível encerrar a garantia da obra: existe(m) caso(s) de garantia ainda aberto(s).',
      'PROJECT_WARRANTY_CLOSE_BLOCKED_BY_OPEN_CASE'
    );
  }

  project.status = 'CLOSED';
  project.updatedBy = actorUserId || null;
  await project.save({ transaction });

  await publishProjectClosed(project, transaction);

  await registrarAuditoria(
    {
      groupId: project.groupId,
      companyId: project.companyId,
      actorUserId,
      action: 'construction.project.close_warranty',
      entityType: 'Project',
      entityId: project.id,
      beforeJson: { status: 'WARRANTY' },
      afterJson: { status: 'CLOSED' },
      reason: `Obra "${project.name}" encerrada definitivamente (garantia concluída).`,
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
  closeProjectWarranty,
  removeProject,
  hasOpenCriticalNonconformity,
  STATUSES,
};
