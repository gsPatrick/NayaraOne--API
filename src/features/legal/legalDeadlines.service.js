'use strict';

const { LegalDeadline, File } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { getLegalCase, getLegalCaseForUpdate } = require('./legalCases.service');
const { publishLegalDeadlineCreated } = require('./legalEvents.service');
const { assertCriticalDeadlineAccountability, normalizeNote } = require('./legalDeadlineAccountability');
const { normalizeOptionalText, requireText } = require('./legalText');
const { assertResponsibleInTenant } = require('./legalDeadlineResponsible');

/**
 * computeSeverity — DECISÃO DE ENGENHARIA: severidade não é uma coluna persistida (o doc só
 * define due_at + status na tabela) — é calculada em runtime a partir de due_at/status, para
 * listagem/priorização, seguindo o exemplo dado no doc ("OVERDUE se due_at no passado e
 * status PENDING"). Além de OVERDUE, adicionamos DUE_SOON (próximas 48h) e NORMAL como
 * granularidade extra útil pra UI de prazos — não pedida explicitamente, mas consistente com
 * o único caso citado no doc.
 */
function computeSeverity(deadline, now = new Date()) {
  if (deadline.status !== 'PENDING') return 'DONE';
  const dueAt = new Date(deadline.dueAt);
  if (dueAt.getTime() < now.getTime()) return 'OVERDUE';
  const hoursUntilDue = (dueAt.getTime() - now.getTime()) / (1000 * 60 * 60);
  if (hoursUntilDue <= 48) return 'DUE_SOON';
  return 'NORMAL';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Valores que o prazo realmente assume (computeSeverity, job de alerta e reabertura usam so estes).
const DEADLINE_STATUSES = ['PENDING', 'DONE'];
const DEADLINE_CRITICALITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

function assertValidDate(value, field) {
  const t = value instanceof Date ? value.getTime() : typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
  if (Number.isNaN(t)) {
    throw AppError.badRequest(`O campo "${field}" deve ser uma data válida.`, 'LEGAL_DEADLINE_VALIDATION');
  }
}

async function createLegalDeadline(legalCaseId, payload, actorUserId, transaction) {
  const legalCase = await getLegalCase(legalCaseId, transaction);
  const { dueAt } = payload;
  const responsibleUserId = await assertResponsibleInTenant(payload.responsibleUserId, legalCase, transaction);
  // M45 (Caderno M5 §15 "Prazo crítico vencido abre ocorrência HIGH/CRITICAL"): criticidade.
  if (payload.criticality !== undefined && payload.criticality !== null && typeof payload.criticality !== 'string') {
    throw AppError.badRequest('"criticality" deve ser um texto.', 'LEGAL_DEADLINE_VALIDATION');
  }
  const criticality = normalizeOptionalText(payload.criticality, 'criticality')?.toUpperCase() || 'MEDIUM';
  if (!DEADLINE_CRITICALITIES.includes(criticality)) {
    throw AppError.badRequest(`"criticality" deve ser um de: ${DEADLINE_CRITICALITIES.join(', ')}.`, 'LEGAL_DEADLINE_VALIDATION');
  }
  if (!payload.description || !dueAt) {
    throw AppError.badRequest('Os campos "description" e "dueAt" são obrigatórios.', 'LEGAL_DEADLINE_VALIDATION');
  }
  // Texto obrigatorio: sem espacos/invisiveis so, so texto, dentro do tamanho da coluna.
  const description = requireText(payload.description, 'description', { max: 255 });
  assertValidDate(dueAt, 'dueAt');
  const sourceDocument = normalizeOptionalText(payload.sourceDocument, 'sourceDocument');
  const sourceEvent = normalizeOptionalText(payload.sourceEvent, 'sourceEvent');
  if ((sourceDocument && sourceDocument.length > 255) || (sourceEvent && sourceEvent.length > 255)) {
    throw AppError.badRequest('"sourceDocument" e "sourceEvent" aceitam no máximo 255 caracteres.', 'LEGAL_DEADLINE_VALIDATION');
  }
  // Caderno §15: "Prazo sempre tem source_document/source_event" — exige pelo menos um dos
  // dois (não os dois obrigatoriamente, já que um prazo pode nascer de um documento OU de um
  // evento de sistema, nunca dos dois ao mesmo tempo necessariamente).
  if (!sourceDocument && !sourceEvent) {
    throw AppError.badRequest(
      'Informe "sourceDocument" ou "sourceEvent" — todo prazo jurídico precisa de uma origem rastreável.',
      'LEGAL_DEADLINE_SOURCE_REQUIRED'
    );
  }

  // ACHADO REAL (auditoria técnica independente da Nayara, A07): um prazo que já nasce vencido
  // (dueAt no passado — o cenário mais crítico que existe, equivalente a OVERDUE desde a
  // criação) podia ser cadastrado sem nenhum responsável. O job de alerta só notifica um
  // humano quando há responsável — sem ele, o prazo fica publicado só como evento, sem ninguém
  // de fato avisado. Fail closed: prazo que nasce já vencido exige responsável definido.
  const bornOverdue = new Date(dueAt).getTime() < Date.now();
  if (bornOverdue && !responsibleUserId) {
    throw AppError.badRequest(
      'Um prazo que já nasce vencido precisa de um responsável definido, para que alguém seja notificado de verdade.',
      'LEGAL_DEADLINE_RESPONSIBLE_REQUIRED'
    );
  }

  // Auditoria da cliente (Marco 5): prazo CRITICAL exige responsavel efetivo e destino de
  // escalonamento desde a criacao, nao so quando ja esta vencido.
  // Lock do processo (FOR UPDATE) e releitura: serializa com a remocao de responsavel/escalonamento.
  if (criticality === 'CRITICAL') {
    const lockedCase = await getLegalCaseForUpdate(legalCaseId, transaction);
    assertCriticalDeadlineAccountability({ responsibleUserId }, lockedCase);
  }

  const deadline = await LegalDeadline.create(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      legalCaseId: legalCase.id,
      description,
      dueAt,
      sourceDocument: sourceDocument || null,
      sourceEvent: sourceEvent || null,
      responsibleUserId: responsibleUserId || null,
      criticality,
      status: 'PENDING',
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
      action: 'legal.deadline.create',
      entityType: 'LegalDeadline',
      entityId: deadline.id,
      afterJson: deadline.toJSON(),
      reason: `Prazo "${description}" criado para o processo ${legalCase.id}.`,
    },
    transaction
  );

  await publishLegalDeadlineCreated(deadline, transaction);

  return deadline;
}

async function listLegalDeadlines(transaction, filters = {}) {
  const where = {};
  if (filters.legalCaseId) where.legalCaseId = filters.legalCaseId;
  if (filters.status) where.status = String(filters.status).toUpperCase();

  const deadlines = await LegalDeadline.findAll({ where, order: [['due_at', 'ASC']], transaction });
  const now = new Date();
  const withSeverity = deadlines.map((d) => {
    const json = d.toJSON();
    json.severity = computeSeverity(d, now);
    return json;
  });

  if (filters.severity) {
    return withSeverity.filter((d) => d.severity === String(filters.severity).toUpperCase());
  }
  return withSeverity;
}

async function getLegalDeadline(id, transaction) {
  const deadline = await LegalDeadline.findByPk(id, { transaction });
  if (!deadline) throw AppError.notFound('Prazo jurídico não encontrado.', 'LEGAL_DEADLINE_NOT_FOUND');
  return deadline;
}

async function updateLegalDeadline(id, payload, actorUserId, transaction) {
  const deadline = await getLegalDeadline(id, transaction);
  const beforeJson = deadline.toJSON();
  const { dueAt, conclusionEvidenceFileId, conclusionNote } = payload;
  // Auditoria da cliente (Marco 5, item 3): o status e normalizado (caixa/espacos) e validado
  // contra a lista do modelo; assim "done" vira DONE e exige a prova, e valor desconhecido e recusado.
  let status;
  if (payload.status !== undefined) {
    status = normalizeOptionalText(payload.status, 'status')?.toUpperCase();
    if (!DEADLINE_STATUSES.includes(status)) {
      throw AppError.badRequest(`"status" deve ser um de: ${DEADLINE_STATUSES.join(', ')}.`, 'LEGAL_DEADLINE_VALIDATION');
    }
  }
  const description = payload.description !== undefined ? requireText(payload.description, 'description', { max: 255 }) : undefined;
  if (dueAt !== undefined) assertValidDate(dueAt, 'dueAt');
  if (conclusionEvidenceFileId !== undefined && conclusionEvidenceFileId !== null && !UUID_RE.test(String(conclusionEvidenceFileId))) {
    throw AppError.badRequest('"conclusionEvidenceFileId" deve ser o identificador (UUID) de um arquivo.', 'LEGAL_DEADLINE_VALIDATION');
  }
  const changeReason = normalizeOptionalText(payload.changeReason, 'changeReason');

  // Atribuicao/troca de responsavel pelo PATCH (antes o campo era ignorado em silencio e o
  // responsavel anterior permanecia). null/'' remove; usuario precisa ter vinculo ativo na empresa.
  const responsibleProvided = payload.responsibleUserId !== undefined;
  const nextResponsible = responsibleProvided
    ? await assertResponsibleInTenant(payload.responsibleUserId, deadline, transaction)
    : deadline.responsibleUserId;
  const responsibleChanged = responsibleProvided && (nextResponsible || null) !== (deadline.responsibleUserId || null);
  if (responsibleChanged && !nextResponsible && deadline.status === 'PENDING' && new Date(deadline.dueAt).getTime() < Date.now()) {
    throw AppError.badRequest(
      'Um prazo pendente e já vencido precisa de um responsável definido, para que alguém seja notificado de verdade.',
      'LEGAL_DEADLINE_RESPONSIBLE_REQUIRED'
    );
  }
  if (responsibleChanged && !nextResponsible && deadline.status === 'PENDING' && deadline.criticality === 'CRITICAL') {
    const lockedCase = await getLegalCaseForUpdate(deadline.legalCaseId, transaction);
    assertCriticalDeadlineAccountability({ responsibleUserId: null }, lockedCase);
  }

  // ACHADO REAL (auditoria técnica independente da Nayara, A08): concluir um prazo (status ->
  // DONE) era aceito sem nenhuma evidência nem nota documentando o que foi feito — "{status:
  // 'DONE'}" sozinho bastava. Fail closed: concluir exige pelo menos evidência OU nota.
  // Auditoria da cliente (Marco 5): a nota e normalizada (trim) e uma nota so de espacos nao
  // conta como evidencia. A prova e reavaliada sempre que o prazo termina DONE e a conclusao
  // esta sendo feita agora ou a nota/evidencia esta sendo alterada (prazo concluido nao pode
  // perder a prova); prazo ja concluido sem mexer na prova nao e reavaliado.
  const noteProvided = conclusionNote !== undefined;
  const newNote = noteProvided ? normalizeNote(conclusionNote) : normalizeNote(deadline.conclusionNote);
  const finalStatus = status !== undefined ? status : deadline.status;
  const concluding = finalStatus === 'DONE' && deadline.status !== 'DONE';
  const touchingProof = finalStatus === 'DONE' && (noteProvided || conclusionEvidenceFileId !== undefined);
  if (concluding || touchingProof) {
    const evidenceId = conclusionEvidenceFileId !== undefined ? conclusionEvidenceFileId : deadline.conclusionEvidenceFileId;
    if (!evidenceId && !newNote) {
      throw AppError.unprocessable(
        'Concluir um prazo exige uma evidência anexada ou uma nota (com texto) explicando o que foi feito.',
        'LEGAL_DEADLINE_CONCLUSION_PROOF_REQUIRED'
      );
    }
    if (evidenceId) {
      const file = await File.findOne({ where: { id: evidenceId, companyId: deadline.companyId }, transaction });
      if (!file) {
        throw AppError.badRequest(
          'O arquivo de evidência informado não existe ou não pertence a esta empresa.',
          'LEGAL_DEADLINE_EVIDENCE_FILE_NOT_FOUND'
        );
      }
    }
  }

  // ACHADO REAL (auditoria técnica independente da Nayara, A09): mudar o vencimento de um prazo
  // já criado era aceito só com o novo "dueAt", sem o usuário informar por quê — o histórico
  // registrava um motivo genérico ("Prazo atualizado"), nunca a justificativa real. Fail closed:
  // mudar dueAt exige "changeReason" preenchido pelo usuário, usado como motivo real na auditoria.
  const dueAtChanged = dueAt !== undefined && new Date(dueAt).getTime() !== new Date(deadline.dueAt).getTime();
  if (dueAtChanged && !changeReason) {
    throw AppError.badRequest(
      'Mudar o vencimento de um prazo exige informar o motivo da mudança.',
      'LEGAL_DEADLINE_CHANGE_REASON_REQUIRED'
    );
  }

  // FIX (homologação 22/09/2026 — auditoria proativa): reabrir um prazo (status volta pra
  // PENDING) ou adiar/antecipar dueAt depois que ele já tinha sido alertado como OVERDUE
  // (lastAlertedSeverity='OVERDUE') e/ou escalado (escalatedAt setado) nunca resetava esses
  // campos. Consequência real em legalDeadlineAlertJob.js: processDeadlinesInTransaction só
  // alerta se o novo rank de severidade for MAIOR que o anterior — como OVERDUE já é o rank
  // máximo, um novo vencimento nunca dispararia alerta de novo; e processEscalations só
  // considera candidatos com escalatedAt: null — como já tinha sido setado da primeira vez, o
  // prazo nunca mais entrava na lista de candidatos, mesmo reaberto e vencido outra vez. Ou
  // seja: um prazo reaberto ficava, na prática, sem alerta e sem escalonamento para sempre.
  // Agora, reabrir (status -> PENDING) ou mudar dueAt reseta o ciclo de alerta.
  const reopening = status !== undefined && status === 'PENDING' && deadline.status !== 'PENDING';
  // Auditoria da cliente (Marco 5, contorno): reabrir um prazo CRITICAL concluido o devolve a
  // PENDING; o criterio de responsavel efetivo + destino de escalonamento e refeito aqui, para
  // nao existir prazo CRITICAL pendente sem ninguem avisado.
  if (reopening && deadline.criticality === 'CRITICAL') {
    const legalCase = await getLegalCaseForUpdate(deadline.legalCaseId, transaction);
    assertCriticalDeadlineAccountability(deadline, legalCase);
  }
  if (reopening || dueAtChanged) {
    deadline.lastAlertedSeverity = null;
    deadline.firstOverdueAlertedAt = null;
    deadline.escalatedAt = null;
  }
  // Novo responsavel precisa ser avisado do estado atual do prazo: zera so a ultima severidade alertada.
  if (responsibleChanged) deadline.lastAlertedSeverity = null;

  if (status !== undefined) deadline.status = status;
  if (description !== undefined) deadline.description = description;
  if (dueAt !== undefined) deadline.dueAt = dueAt;
  if (responsibleChanged) deadline.responsibleUserId = nextResponsible;
  if (conclusionEvidenceFileId !== undefined) deadline.conclusionEvidenceFileId = conclusionEvidenceFileId;
  if (noteProvided) deadline.conclusionNote = newNote;
  deadline.updatedBy = actorUserId || null;
  await deadline.save({ transaction });

  await registrarAuditoria(
    {
      groupId: deadline.groupId,
      companyId: deadline.companyId,
      actorUserId,
      action: 'legal.deadline.update',
      entityType: 'LegalDeadline',
      entityId: deadline.id,
      beforeJson,
      afterJson: deadline.toJSON(),
      reason: dueAtChanged
        ? changeReason
        : responsibleChanged
          ? `Responsável do prazo ${deadline.id} alterado de ${beforeJson.responsibleUserId || 'ninguém'} para ${nextResponsible || 'ninguém'}${changeReason ? `: ${changeReason}` : '.'}`
          : `Prazo ${deadline.id} atualizado.`,
    },
    transaction
  );

  return deadline;
}

module.exports = { DEADLINE_STATUSES, DEADLINE_CRITICALITIES, createLegalDeadline, listLegalDeadlines, getLegalDeadline, updateLegalDeadline, computeSeverity };
