'use strict';

const { LegalDeadline } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { getLegalCase, getLegalCaseForUpdate } = require('./legal-case.service');
const { publishLegalDeadlineCreated } = require('../shared/legalEvents.service');
const { publishDeadlineChange } = require('./legalDeadlineCalendarEvents.service');
const { assertCriticalDeadlineAccountability, assertHasResponsible } = require('./legalDeadlineAccountability');
const { normalizeOptionalText, requireText } = require('../shared/legalText');
const { parseDueAt } = require('./legalDeadlineDates');
const { legalDeadlineZone, legalDeadlineWindows, windowFor } = require('../shared/legalRules.params');
const { resolveDeadlineSource } = require('./legalDeadlineSource');
const { createDeadlineTask, syncDeadlineTask } = require('./legalDeadlineTask');
const { assertResponsibleInTenant } = require('./legalDeadlineResponsible');
const { assertTransitionAllowed, assertCancellation, assertConclusionProof } = require('./legalDeadlineTransitions');
const { DEADLINE_CRITICALITIES, normalizeCriticality, assertFinalDeadlineState } = require('./legalDeadlineInvariants');

/**
 * computeSeverity — DECISÃO DE ENGENHARIA: severidade não é uma coluna persistida (o doc só
 * define due_at + status na tabela) — é calculada em runtime a partir de due_at/status, para
 * listagem/priorização, seguindo o exemplo dado no doc ("OVERDUE se due_at no passado e
 * status PENDING"). Além de OVERDUE, adicionamos DUE_SOON (próximas 48h) e NORMAL como
 * granularidade extra útil pra UI de prazos — não pedida explicitamente, mas consistente com
 * o único caso citado no doc.
 * Fechamento M5 (§15 "Alertas escalonados por regra"): a antecedência do DUE_SOON é o parâmetro por criticidade
 * `legal.prazos.alerta_antecedencia_horas.<CRITICIDADE>` (padrão 48 h); `windows` vem de legalDeadlineWindows.
 */
function computeSeverity(deadline, now = new Date(), windows = null) {
  if (deadline.status === 'CANCELLED') return 'CANCELLED';
  if (deadline.status !== 'PENDING') return 'DONE';
  const dueAt = new Date(deadline.dueAt);
  if (dueAt.getTime() < now.getTime()) return 'OVERDUE';
  const hoursUntilDue = (dueAt.getTime() - now.getTime()) / (1000 * 60 * 60);
  if (hoursUntilDue <= windowFor(windows, deadline.criticality).dueSoonHours) return 'DUE_SOON';
  return 'NORMAL';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Valores que o prazo assume: PENDING -> DONE (concluir, com prova) | CANCELLED (cancelar, com motivo; terminal).
const DEADLINE_STATUSES = ['PENDING', 'DONE', 'CANCELLED'];

/**
 * createDeadline (Guia do Marcelo §12): origem verificável obrigatória (sourceFileId/sourceEventId, senão
 * DEADLINE_SOURCE_REQUIRED), due_at no fuso de São Paulo, responsável em todo prazo (o do prazo ou, sem ele, o do
 * processo — Caderno §15 "due_at em timezone correto + responsável + severidade") e a TAREFA do responsável criada
 * na mesma transação. `options.contingencyOrigin` só para a contingência do BCP (ver legalDeadlineSource.js).
 */
async function createLegalDeadline(legalCaseId, payload, actorUserId, transaction, options = {}) {
  const legalCase = await getLegalCase(legalCaseId, transaction);
  const responsibleUserId = await assertResponsibleInTenant(payload.responsibleUserId, legalCase, transaction);
  // M45 (Caderno M5 §15 "Prazo crítico vencido abre ocorrência HIGH/CRITICAL"): criticidade.
  const criticality = normalizeCriticality(payload.criticality) || 'MEDIUM';
  if (!payload.description || payload.dueAt === undefined || payload.dueAt === null || payload.dueAt === '') {
    throw AppError.badRequest('Os campos "description" e "dueAt" são obrigatórios.', 'LEGAL_DEADLINE_VALIDATION');
  }
  // Texto obrigatorio: sem espacos/invisiveis so, so texto, dentro do tamanho da coluna.
  const description = requireText(payload.description, 'description', { max: 255 });
  const dueAt = parseDueAt(payload.dueAt, 'dueAt', await legalDeadlineZone(legalCase, transaction));
  const source = await resolveDeadlineSource(payload, legalCase, transaction, options);

  // ACHADO REAL (auditoria técnica independente da Nayara, A07): prazo que já nasce vencido exige responsável
  // PRÓPRIO definido, para que alguém seja notificado de verdade.
  if (dueAt.getTime() < Date.now() && !responsibleUserId) {
    throw AppError.badRequest(
      'Um prazo que já nasce vencido precisa de um responsável definido, para que alguém seja notificado de verdade.',
      'LEGAL_DEADLINE_RESPONSIBLE_REQUIRED'
    );
  }
  // Lock do processo (FOR UPDATE) e releitura: serializa com a remoção de responsável/escalonamento do processo.
  const lockedCase = await getLegalCaseForUpdate(legalCaseId, transaction);
  // Auditoria da cliente (Marco 5): prazo CRITICAL exige responsável efetivo e destino de escalonamento.
  if (criticality === 'CRITICAL') assertCriticalDeadlineAccountability({ responsibleUserId }, lockedCase);
  assertHasResponsible({ responsibleUserId }, lockedCase);

  const deadline = await LegalDeadline.create(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      legalCaseId: legalCase.id,
      description,
      dueAt,
      ...source,
      responsibleUserId: responsibleUserId || null,
      criticality,
      status: 'PENDING',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
  await createDeadlineTask(deadline, lockedCase, actorUserId, transaction);

  await registrarAuditoria(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      actorUserId,
      action: 'legal.deadline.create',
      entityType: 'LegalDeadline',
      entityId: deadline.id,
      afterJson: deadline.toJSON(),
      reason: `Prazo "${description}" criado para o processo ${legalCase.id} (tarefa ${deadline.taskId}).`,
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
  const windows = deadlines.length ? await legalDeadlineWindows(deadlines[0], transaction) : null;
  const withSeverity = deadlines.map((d) => {
    const json = d.toJSON();
    json.severity = computeSeverity(d, now, windows);
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

/**
 * Le o prazo com lock de linha respeitando a ordem unica de lock (processo primeiro, depois
 * prazo): duas trocas simultaneas do mesmo prazo se serializam, e a segunda enxerga (e audita
 * como `before`) o estado ja gravado pela primeira. O prazo e relido apos o lock, de modo que
 * as checagens (vencido, CRITICAL, responsavel atual) usam o estado vigente, nao um stale.
 */
async function getLegalDeadlineLocked(id, transaction) {
  const peek = await getLegalDeadline(id, transaction);
  await getLegalCaseForUpdate(peek.legalCaseId, transaction);
  const deadline = await LegalDeadline.findByPk(id, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!deadline) throw AppError.notFound('Prazo jurídico não encontrado.', 'LEGAL_DEADLINE_NOT_FOUND');
  return deadline;
}

async function updateLegalDeadline(id, payload, actorUserId, transaction, options = {}) {
  const deadline = await getLegalDeadlineLocked(id, transaction);
  const legalCase = await getLegalCase(deadline.legalCaseId, transaction);
  const beforeJson = deadline.toJSON();
  const beforeStatus = deadline.status;
  const { conclusionEvidenceFileId } = payload;
  // Auditoria da cliente (Marco 5, item 3): o status e normalizado (caixa/espacos) e validado
  // contra a lista do modelo; assim "done" vira DONE e exige a prova, e valor desconhecido e recusado.
  let status;
  if (payload.status !== undefined) {
    status = normalizeOptionalText(payload.status, 'status')?.toUpperCase();
    if (!DEADLINE_STATUSES.includes(status)) {
      throw AppError.badRequest(`"status" deve ser um de: ${DEADLINE_STATUSES.join(', ')}.`, 'LEGAL_DEADLINE_VALIDATION');
    }
  }
  const finalStatus = status !== undefined ? status : deadline.status;
  assertTransitionAllowed(deadline.status, finalStatus);
  const description = payload.description !== undefined ? requireText(payload.description, 'description', { max: 255 }) : undefined;
  const dueAt = payload.dueAt !== undefined ? parseDueAt(payload.dueAt, 'dueAt', await legalDeadlineZone(legalCase, transaction)) : undefined;
  if (conclusionEvidenceFileId !== undefined && conclusionEvidenceFileId !== null && !UUID_RE.test(String(conclusionEvidenceFileId))) {
    throw AppError.badRequest('"conclusionEvidenceFileId" deve ser o identificador (UUID) de um arquivo.', 'LEGAL_DEADLINE_VALIDATION');
  }
  const changeReason = normalizeOptionalText(payload.changeReason, 'changeReason');
  const criticality = normalizeCriticality(payload.criticality);

  // Atribuicao/troca de responsavel pelo PATCH. null/'' remove; usuario precisa ter vinculo ativo na empresa.
  const responsibleProvided = payload.responsibleUserId !== undefined;
  const nextResponsible = responsibleProvided
    ? await assertResponsibleInTenant(payload.responsibleUserId, deadline, transaction)
    : deadline.responsibleUserId;
  const responsibleChanged = responsibleProvided && (nextResponsible || null) !== (deadline.responsibleUserId || null);
  // Regra unica: as invariantes sao avaliadas sobre o estado FINAL da requisicao (legalDeadlineInvariants.js).
  const criticalityChanged = criticality !== undefined && criticality !== deadline.criticality;
  const dueAtChanged = dueAt !== undefined && dueAt.getTime() !== new Date(deadline.dueAt).getTime();
  await assertFinalDeadlineState({
    final: {
      status: finalStatus,
      responsibleUserId: nextResponsible || null,
      dueAt: dueAt !== undefined ? dueAt : deadline.dueAt,
      criticality: criticality !== undefined ? criticality : deadline.criticality,
    },
    touched: responsibleChanged || criticalityChanged || dueAtChanged || finalStatus !== deadline.status,
    getLockedCase: () => getLegalCaseForUpdate(deadline.legalCaseId, transaction),
  });

  // ACHADO REAL (A08) + §19: conclusão com prova e por quem pode (legalDeadlineTransitions.js).
  const { noteProvided, newNote } = await assertConclusionProof({ deadline, legalCase, payload, finalStatus, actorUserId, permissions: options.actorPermissions, transaction });
  const cancelling = finalStatus === 'CANCELLED' && deadline.status !== 'CANCELLED';
  const cancellation = cancelling ? assertCancellation({ deadline, legalCase, payload, actorUserId, permissions: options.actorPermissions }) : null;

  // ACHADO REAL (A09): mudar o vencimento exige "changeReason", usado como motivo real na auditoria.
  if (dueAtChanged && !changeReason) {
    throw AppError.badRequest(
      'Mudar o vencimento de um prazo exige informar o motivo da mudança.',
      'LEGAL_DEADLINE_CHANGE_REASON_REQUIRED'
    );
  }

  // FIX (homologação 22/09/2026): reabrir (status -> PENDING) ou mudar dueAt reseta o ciclo de alerta, senão o job
  // nunca mais alertaria nem escalaria o prazo (OVERDUE já é o rank máximo e escalated_at já estava preenchido).
  const reopening = status !== undefined && status === 'PENDING' && deadline.status !== 'PENDING';
  if (reopening || dueAtChanged) {
    deadline.lastAlertedSeverity = null;
    deadline.firstOverdueAlertedAt = null;
    deadline.escalatedAt = null;
  }
  // Novo responsavel precisa ser avisado do estado atual do prazo: zera so a ultima severidade alertada.
  if (responsibleChanged) deadline.lastAlertedSeverity = null;

  if (status !== undefined) deadline.status = status;
  if (description !== undefined) deadline.description = description;
  if (criticalityChanged) deadline.criticality = criticality;
  if (dueAt !== undefined) deadline.dueAt = dueAt;
  if (responsibleChanged) deadline.responsibleUserId = nextResponsible;
  if (conclusionEvidenceFileId !== undefined) deadline.conclusionEvidenceFileId = conclusionEvidenceFileId;
  if (noteProvided) deadline.conclusionNote = newNote;
  if (cancellation) Object.assign(deadline, { cancelReason: cancellation.cancelReason, cancelledAt: cancellation.cancelledAt, cancelledBy: cancellation.cancelledBy });
  deadline.updatedBy = actorUserId || null;
  await deadline.save({ transaction });
  // Guia §12: a tarefa do responsável acompanha o prazo (concluir, cancelar, reabrir, remarcar, reatribuir).
  await syncDeadlineTask(deadline, legalCase, actorUserId, transaction);

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
        : cancellation
          ? `Prazo ${deadline.id} cancelado: ${cancellation.cancelReason}`
          : responsibleChanged
            ? `Responsável do prazo ${deadline.id} alterado de ${beforeJson.responsibleUserId || 'ninguém'} para ${nextResponsible || 'ninguém'}${changeReason ? `: ${changeReason}` : '.'}`
            : `Prazo ${deadline.id} atualizado.`,
    },
    transaction
  );

  // M9-D802: o Calendário fecha/reabre/atualiza o item a partir deste evento (a conclusão acontece AQUI, na origem).
  await publishDeadlineChange(deadline, beforeStatus, transaction);

  return deadline;
}

module.exports = { DEADLINE_STATUSES, DEADLINE_CRITICALITIES, createLegalDeadline, listLegalDeadlines, getLegalDeadline, updateLegalDeadline, computeSeverity };
