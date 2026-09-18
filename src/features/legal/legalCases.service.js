'use strict';

const { LegalCase, LegalCaseParty, Person, Task } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishLegalCaseCreated } = require('./legalEvents.service');

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

async function createLegalCase(payload, actorUserId, transaction) {
  const { groupId, companyId, contractId, propertyId, responsibleUserId, escalationUserId, caseNumber, caseType, summary, phase } = payload;
  if (!groupId || !companyId || !caseType) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "caseType" são obrigatórios.', 'LEGAL_CASE_VALIDATION');
  }
  if (!CASE_TYPES.includes(caseType)) {
    throw AppError.badRequest(`"caseType" deve ser um de: ${CASE_TYPES.join(', ')}.`, 'LEGAL_CASE_VALIDATION');
  }
  assertValidPhase(phase, payload.allowUnknownPhase);

  const legalCase = await LegalCase.create(
    {
      groupId,
      companyId,
      contractId: contractId || null,
      propertyId: propertyId || null,
      responsibleUserId: responsibleUserId || null,
      escalationUserId: escalationUserId || null,
      caseNumber: caseNumber || null,
      caseType,
      status: 'OPEN',
      phase: phase || null,
      summary: summary || null,
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

async function updateLegalCase(id, payload, actorUserId, transaction) {
  const legalCase = await getLegalCase(id, transaction);
  const beforeJson = legalCase.toJSON();
  const { status, summary, responsibleUserId, escalationUserId, phase } = payload;
  // M5-26: mudança de FASE é uma alteração processual relevante — validada aqui e auditada
  // com antes/depois explícitos no `reason`, não só no diff genérico.
  assertValidPhase(phase, payload.allowUnknownPhase);
  const previousPhase = legalCase.phase;
  if (status !== undefined) legalCase.status = status;
  if (summary !== undefined) legalCase.summary = summary;
  if (responsibleUserId !== undefined) legalCase.responsibleUserId = responsibleUserId;
  if (escalationUserId !== undefined) legalCase.escalationUserId = escalationUserId;
  if (phase !== undefined) legalCase.phase = phase;
  legalCase.updatedBy = actorUserId || null;
  await legalCase.save({ transaction });

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
  if (!LEGAL_CASE_PARTY_ROLES.includes(partyRole)) {
    throw AppError.badRequest(
      `"partyRole" deve ser um de: ${LEGAL_CASE_PARTY_ROLES.join(', ')}.`,
      'LEGAL_CASE_PARTY_VALIDATION'
    );
  }
  const person = await Person.findByPk(personId, { transaction });
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
 * src/features/finance/approvals.service.js). Reutilizamos esse mecanismo existente: vincular
 * uma task a um processo jurídico é simplesmente setar `relatedEntityType: 'LegalCase'` e
 * `relatedEntityId: legalCaseId` na Task — sem precisar de tabela nova nem de migration.
 * `core.tasks` não tem FK real para legal.legal_cases (é polimórfico, `constraints: false`,
 * igual às demais associações desse tipo no projeto), então a integridade referencial aqui é
 * responsabilidade da aplicação, não do banco — mesmo trade-off já aceito em approvals.
 */
async function linkCaseToTask(legalCaseId, taskId, actorUserId, transaction) {
  const legalCase = await getLegalCase(legalCaseId, transaction);
  const task = await Task.findByPk(taskId, { transaction });
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
  createLegalCase,
  listLegalCases,
  getLegalCase,
  updateLegalCase,
  linkCaseToTask,
  addLegalCaseParty,
  listLegalCaseParties,
  CASE_TYPES,
  LEGAL_CASE_PHASES,
  LEGAL_CASE_PARTY_ROLES,
};
