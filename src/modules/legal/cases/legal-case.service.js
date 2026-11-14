'use strict';

const { sequelize, LegalCase, LegalCaseParty, Person, Task } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { publishLegalCaseCreated } = require('../shared/legalEvents.service');
const { publishLegalCaseUpdated } = require('../shared/legalBiEvents.service');
const { assertCaseKeepsCriticalAccountability } = require('./legalDeadlineAccountability');
const { reassignCaseDeadlineTasks } = require('./legalDeadlineTask');
const { validateCaseInput } = require('./legalCaseInput');
const { requireUuid } = require('../shared/legalInput');

const CASE_TYPES = ['LITIGATION', 'CONSULTATIVE', 'COLLECTION'];

/**
 * M5-26 — PARTES e FASES formais do processo.
 *
 * LEGAL_CASE_PHASES é uma LISTA ABERTA (documentada): estes são os valores conhecidos hoje,
 * validados quando informados; a coluna no banco é STRING, não ENUM, porque o rito varia por
 * tipo de ação e a cliente pode precisar de fases próprias sem uma migration a cada uma.
 * `updateLegalCase` valida contra esta lista — se for preciso aceitar fase customizada, basta
 * acrescentar aqui (ou passar `allowUnknownPhase: true` no payload, para casos pontuais).
 *
 * PARTY_ROLES cobre o essencial do contencioso brasileiro: autor (PLAINTIFF), réu (DEFENDANT),
 * testemunha (WITNESS) e terceiro interessado (THIRD_PARTY).
 */
const LEGAL_CASE_PHASES = ['INITIAL_PETITION', 'DISCOVERY', 'TRIAL', 'APPEAL', 'CLOSED'];
const LEGAL_CASE_PARTY_ROLES = ['PLAINTIFF', 'DEFENDANT', 'WITNESS', 'THIRD_PARTY'];

function assertValidPhase(phase, allowUnknownPhase) {
  if (phase === undefined || phase === null) return;
  if (!LEGAL_CASE_PHASES.includes(phase) && !allowUnknownPhase) {
    throw AppError.badRequest(
      `"phase" deve ser um de: ${LEGAL_CASE_PHASES.join(', ')} (lista aberta — use "allowUnknownPhase" para uma fase customizada).`,
      'LEGAL_CASE_VALIDATION'
    );
  }
}

// M45 (Caderno M5 §14): órgão, classe, valor e risco do processo. O valor é sempre ESTIMADO
// (estimated_amount) e nunca vira recebível sozinho: nenhum lançamento financeiro é criado a
// partir do processo — "Não confundir estimativa processual com recebível confirmado".
const CASE_RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
function readCaseDetails(payload) {
  const out = {};
  if (payload.court !== undefined) out.court = payload.court ? String(payload.court).trim().slice(0, 160) : null;
  if (payload.caseClass !== undefined) out.caseClass = payload.caseClass ? String(payload.caseClass).trim().slice(0, 120) : null;
  if (payload.riskLevel !== undefined && payload.riskLevel !== null) {
    const risk = String(payload.riskLevel).toUpperCase();
    if (!CASE_RISK_LEVELS.includes(risk)) {
      throw AppError.badRequest(`"riskLevel" deve ser um de: ${CASE_RISK_LEVELS.join(', ')}.`, 'LEGAL_CASE_VALIDATION');
    }
    out.riskLevel = risk;
  } else if (payload.riskLevel === null) out.riskLevel = null;
  if (payload.estimatedAmount !== undefined && payload.estimatedAmount !== null && payload.estimatedAmount !== '') {
    const amount = Number(payload.estimatedAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      throw AppError.badRequest('"estimatedAmount" deve ser um número maior ou igual a zero (valor estimado do processo).', 'LEGAL_CASE_VALIDATION');
    }
    out.estimatedAmount = amount.toFixed(2);
  } else if (payload.estimatedAmount === null) out.estimatedAmount = null;
  // M9-D619: valor já CONFIRMADO (condenação, acordo ou perda), sempre separado do estimado no BI.
  if (payload.confirmedAmount !== undefined && payload.confirmedAmount !== null && payload.confirmedAmount !== '') {
    const confirmed = Number(payload.confirmedAmount);
    if (!Number.isFinite(confirmed) || confirmed < 0) {
      throw AppError.badRequest('"confirmedAmount" deve ser um número maior ou igual a zero (valor confirmado do processo).', 'LEGAL_CASE_VALIDATION');
    }
    out.confirmedAmount = confirmed.toFixed(2);
  } else if (payload.confirmedAmount === null) out.confirmedAmount = null;
  return out;
}

async function createLegalCase(payload, actorUserId, transaction) {
  const { groupId, companyId, caseType, phase } = payload;
  if (!groupId || !companyId || !caseType) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "caseType" são obrigatórios.', 'LEGAL_CASE_VALIDATION');
  }
  if (!CASE_TYPES.includes(caseType)) {
    throw AppError.badRequest(`"caseType" deve ser um de: ${CASE_TYPES.join(', ')}.`, 'LEGAL_CASE_VALIDATION');
  }
  // Pentest M5: responsável/escalonamento só com vínculo ativo NESTA empresa; contrato/imóvel da mesma empresa; tipos.
  const refs = await validateCaseInput(payload, { groupId, companyId }, transaction);
  assertValidPhase(phase, payload.allowUnknownPhase);

  const legalCase = await LegalCase.create(
    {
      groupId,
      companyId,
      contractId: refs.contractId || null,
      propertyId: refs.propertyId || null,
      responsibleUserId: refs.responsibleUserId || null,
      escalationUserId: refs.escalationUserId || null,
      caseNumber: refs.caseNumber || null,
      caseType,
      status: 'OPEN',
      phase: phase || null,
      summary: refs.summary || null,
      ...readCaseDetails(payload),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishLegalCaseCreated(legalCase, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'legal.case.create',
      entityType: 'LegalCase',
      entityId: legalCase.id,
      afterJson: legalCase.toJSON(),
      reason: `Processo jurídico "${caseType}" aberto.`,
    },
    transaction
  );

  return legalCase;
}

async function listLegalCases(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.caseType) where.caseType = String(filters.caseType).toUpperCase();
  if (filters.contractId) where.contractId = filters.contractId;
  return LegalCase.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getLegalCase(id, transaction) {
  const legalCase = await LegalCase.findByPk(id, { transaction });
  if (!legalCase) throw AppError.notFound('Processo jurídico não encontrado.', 'LEGAL_CASE_NOT_FOUND');
  return legalCase;
}

/**
 * Le o processo com FOR UPDATE: serializa quem mexe em responsavel/escalonamento do processo e quem
 * cria/reabre prazo CRITICAL pendente (que depende deles). Ordem de lock unica: processo primeiro.
 */
async function getLegalCaseForUpdate(id, transaction) {
  const legalCase = await LegalCase.findByPk(id, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!legalCase) throw AppError.notFound('Processo jurídico não encontrado.', 'LEGAL_CASE_NOT_FOUND');
  return legalCase;
}

/**
 * assertNotOnLegalHold — gap real (auditoria Nayara, §16/JUR-010/011): um processo em legal
 * hold não pode ter status/fase alterados (é exatamente o que a retenção legal existe para
 * impedir — mudar o estado do processo durante uma disputa/investigação, mesmo sem apagar
 * nada). Campos puramente informativos (summary, responsável, escalonamento) continuam
 * editáveis: a retenção trava o ESTADO processual, não a operação do caso no dia a dia.
 */
function assertNotOnLegalHold(legalCase, { statusChanging, phaseChanging }) {
  if (legalCase.legalHold && (statusChanging || phaseChanging)) {
    throw AppError.conflict(
      `Este processo está em legal hold (retenção legal) desde ${legalCase.legalHoldSetAt ? new Date(legalCase.legalHoldSetAt).toISOString() : 'data desconhecida'}` +
        `${legalCase.legalHoldReason ? ` — motivo: "${legalCase.legalHoldReason}"` : ''}. Remova o hold antes de alterar status/fase.`,
      'LEGAL_CASE_ON_LEGAL_HOLD'
    );
  }
}

/**
 * setLegalHold — ativa/desativa a retenção legal do processo. Motivo é obrigatório ao ATIVAR
 * (nunca ao desativar — remover o hold não precisa justificar o estado anterior, só o próprio
 * ato já fica na trilha de auditoria com antes/depois). Auditado separadamente de
 * `legal.case.update` para ficar fácil de filtrar/relatar quantos processos entraram/saíram de
 * hold, sem misturar com qualquer outra edição de campo.
 */
async function setLegalHold(id, payload, actorUserId, transaction) {
  const legalCase = await getLegalCase(id, transaction);
  const { legalHold, reason } = payload;
  if (typeof legalHold !== 'boolean') {
    throw AppError.badRequest('O campo "legalHold" (boolean) é obrigatório.', 'LEGAL_CASE_LEGAL_HOLD_VALIDATION');
  }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    throw AppError.badRequest('"reason" deve ser um texto.', 'LEGAL_CASE_LEGAL_HOLD_VALIDATION');
  }
  if (legalHold && (!reason || !String(reason).trim())) {
    throw AppError.badRequest('Um motivo é obrigatório para ativar a retenção legal (legal hold).', 'LEGAL_CASE_LEGAL_HOLD_REASON_REQUIRED');
  }

  const beforeJson = legalCase.toJSON();
  legalCase.legalHold = legalHold;
  legalCase.legalHoldReason = legalHold ? reason : null;
  legalCase.legalHoldSetBy = actorUserId || null;
  legalCase.legalHoldSetAt = new Date();
  legalCase.updatedBy = actorUserId || null;
  await legalCase.save({ transaction });

  await registrarAuditoria(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      actorUserId,
      action: legalHold ? 'legal.case.legal_hold_set' : 'legal.case.legal_hold_cleared',
      entityType: 'LegalCase',
      entityId: legalCase.id,
      beforeJson,
      afterJson: legalCase.toJSON(),
      reason: legalHold
        ? `Processo jurídico ${legalCase.id} colocado em legal hold: "${reason}".`
        : `Legal hold removido do processo jurídico ${legalCase.id}.`,
    },
    transaction
  );

  return legalCase;
}

async function updateLegalCase(id, payload, actorUserId, transaction) {
  const legalCase = await getLegalCaseForUpdate(id, transaction);
  const beforeJson = legalCase.toJSON();
  // Pentest M5: mesma validação da criação (vínculo ativo na empresa do processo, tipos, status de lista fechada).
  const refs = await validateCaseInput(payload, legalCase, transaction);
  const { status, summary, responsibleUserId, escalationUserId } = refs;
  const { phase } = payload;
  // M5-26: mudança de FASE é uma alteração processual relevante — validada aqui e auditada
  // com antes/depois explícitos no `reason`, não só no diff genérico.
  assertValidPhase(phase, payload.allowUnknownPhase);
  assertNotOnLegalHold(legalCase, {
    statusChanging: status !== undefined && status !== legalCase.status,
    phaseChanging: phase !== undefined && phase !== legalCase.phase,
  });
  const previousPhase = legalCase.phase;
  const nextResponsible = responsibleUserId !== undefined ? responsibleUserId : legalCase.responsibleUserId;
  const nextEscalation = escalationUserId !== undefined ? escalationUserId : legalCase.escalationUserId;
  if (nextResponsible !== legalCase.responsibleUserId || nextEscalation !== legalCase.escalationUserId) {
    // Prazo CRITICAL pendente depende do responsavel/escalonamento do processo (auditoria Marco 5).
    await assertCaseKeepsCriticalAccountability(
      { id: legalCase.id, responsibleUserId: nextResponsible || null, escalationUserId: nextEscalation || null },
      transaction
    );
  }
  if (status !== undefined) legalCase.status = status;
  if (summary !== undefined) legalCase.summary = summary;
  if (responsibleUserId !== undefined) legalCase.responsibleUserId = responsibleUserId;
  if (escalationUserId !== undefined) legalCase.escalationUserId = escalationUserId;
  if (phase !== undefined) legalCase.phase = phase;
  const details = readCaseDetails(payload);
  // §14: depois de vinculado ao Financeiro, o valor confirmado não muda por aqui (o lançamento já existe).
  if (details.confirmedAmount !== undefined && String(details.confirmedAmount) !== String(legalCase.confirmedAmount)) {
    const [[linked]] = await sequelize.query('SELECT count(*)::int AS n FROM legal.case_receivables WHERE legal_case_id = :id', { replacements: { id: legalCase.id }, transaction });
    if (linked.n > 0) throw AppError.conflict('O valor confirmado já gerou recebível no Financeiro e não pode ser alterado aqui.', 'LEGAL_CASE_RECEIVABLE_LOCKED');
  }
  Object.assign(legalCase, details);
  legalCase.updatedBy = actorUserId || null;
  await legalCase.save({ transaction });
  // Guia §12: a tarefa dos prazos pendentes que dependem do responsável do processo segue o novo responsável.
  if ((beforeJson.responsibleUserId || null) !== (legalCase.responsibleUserId || null)) await reassignCaseDeadlineTasks(legalCase, actorUserId, transaction);
  await publishLegalCaseUpdated(legalCase, transaction); // M9-D619: o BI recalcula risco, valores e processos ativos

  const phaseChanged = phase !== undefined && phase !== previousPhase;

  await registrarAuditoria(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      actorUserId,
      action: phaseChanged ? 'legal.case.phase_change' : 'legal.case.update',
      entityType: 'LegalCase',
      entityId: legalCase.id,
      beforeJson,
      afterJson: legalCase.toJSON(),
      reason: phaseChanged
        ? `Processo jurídico ${legalCase.id} mudou de fase: ${previousPhase || '(sem fase)'} -> ${legalCase.phase}.`
        : `Processo jurídico ${legalCase.id} atualizado.`,
    },
    transaction
  );

  return legalCase;
}

/**
 * addLegalCaseParty — M5-26: registra uma parte formal (Person) no processo, com seu papel
 * processual. A UNIQUE (legal_case_id, person_id, party_role) no banco impede duplicar a mesma
 * pessoa no mesmo papel; a MESMA pessoa pode ter dois papéis diferentes (ex.: réu em um
 * pedido e testemunha em outro ponto), por isso o papel entra na chave.
 */
async function addLegalCaseParty(legalCaseId, payload, actorUserId, transaction) {
  const legalCase = await getLegalCase(legalCaseId, transaction);
  const { personId, partyRole } = payload;
  if (!personId) {
    throw AppError.badRequest('O campo "personId" é obrigatório.', 'LEGAL_CASE_PARTY_VALIDATION');
  }
  requireUuid(personId, 'personId', 'LEGAL_CASE_PARTY_VALIDATION');
  if (!LEGAL_CASE_PARTY_ROLES.includes(partyRole)) {
    throw AppError.badRequest(
      `"partyRole" deve ser um de: ${LEGAL_CASE_PARTY_ROLES.join(', ')}.`,
      'LEGAL_CASE_PARTY_VALIDATION'
    );
  }
  const person = await Person.findOne({ where: { id: personId, companyId: legalCase.companyId }, transaction });
  if (!person) throw AppError.notFound('Pessoa não encontrada.', 'LEGAL_CASE_PARTY_PERSON_NOT_FOUND');

  const existing = await LegalCaseParty.findOne({
    where: { legalCaseId: legalCase.id, personId, partyRole },
    transaction,
  });
  if (existing) {
    throw AppError.conflict('Esta pessoa já está registrada neste papel no processo.', 'LEGAL_CASE_PARTY_DUPLICATE');
  }

  const party = await LegalCaseParty.create(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      legalCaseId: legalCase.id,
      personId,
      partyRole,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      actorUserId,
      action: 'legal.case_party.create',
      entityType: 'LegalCaseParty',
      entityId: party.id,
      afterJson: party.toJSON(),
      reason: `Parte ${partyRole} (pessoa ${personId}) adicionada ao processo ${legalCase.id}.`,
    },
    transaction
  );

  return party;
}

async function listLegalCaseParties(legalCaseId, transaction) {
  return LegalCaseParty.findAll({ where: { legalCaseId }, order: [['created_at', 'ASC']], transaction });
}

/**
 * linkCaseToTask — DECISÃO DE ENGENHARIA: o doc pede para verificar se existe uma
 * tabela/model de tasks vinculável antes de inventar mecanismo. Existe `Task` (core.tasks,
 * src/models/Task.js) com colunas polimórficas `related_entity_type` + `related_entity_id`
 * — o MESMO padrão já usado por finance.approval_requests (ver
 * src/modules/finance/application/services/approvals.service.js). Reutilizamos esse mecanismo existente: vincular
 * uma task a um processo jurídico é simplesmente setar `relatedEntityType: 'LegalCase'` e
 * `relatedEntityId: legalCaseId` na Task — sem precisar de tabela nova nem de migration.
 * `core.tasks` não tem FK real para legal.legal_cases (é polimórfico, `constraints: false`,
 * igual às demais associações desse tipo no projeto), então a integridade referencial aqui é
 * responsabilidade da aplicação, não do banco — mesmo trade-off já aceito em approvals.
 */
async function linkCaseToTask(legalCaseId, taskId, actorUserId, transaction) {
  const legalCase = await getLegalCase(legalCaseId, transaction);
  requireUuid(taskId, 'taskId', 'LEGAL_CASE_VALIDATION');
  const task = await Task.findOne({ where: { id: taskId, companyId: legalCase.companyId }, transaction });
  if (!task) throw AppError.notFound('Tarefa não encontrada.', 'LEGAL_CASE_TASK_NOT_FOUND');

  const beforeJson = task.toJSON();
  task.relatedEntityType = 'LegalCase';
  task.relatedEntityId = legalCase.id;
  task.updatedBy = actorUserId || null;
  await task.save({ transaction });

  await registrarAuditoria(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      actorUserId,
      action: 'legal.case.link_task',
      entityType: 'Task',
      entityId: task.id,
      beforeJson,
      afterJson: task.toJSON(),
      reason: `Tarefa ${task.id} vinculada ao processo jurídico ${legalCase.id}.`,
    },
    transaction
  );

  return task;
}

module.exports = {
  getLegalCaseForUpdate,
  CASE_RISK_LEVELS,
  createLegalCase,
  listLegalCases,
  getLegalCase,
  updateLegalCase,
  setLegalHold,
  linkCaseToTask,
  addLegalCaseParty,
  listLegalCaseParties,
  CASE_TYPES,
  LEGAL_CASE_PHASES,
  LEGAL_CASE_PARTY_ROLES,
};
