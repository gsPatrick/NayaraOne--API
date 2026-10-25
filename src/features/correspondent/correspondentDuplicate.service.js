'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const { FinancingCase, CaseApplicant, Person } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

const DUPLICATE_WINDOW_HOURS = 24;

/**
 * computeDuplicateFingerprint — Marco 8 Fase 11 ("Caso duplicado → fingerprint + fila de
 * revisão, não bloqueio automático silencioso"). Hash determinístico de
 * companyId + personId principal + propertyId (ou "sem-imovel") — mesmo espírito do dedupe de
 * pessoas do Marco 3 (personDedup.service.js): sinaliza, nunca bloqueia.
 *
 * ACHADO REAL CORRIGIDO (auditoria pós-DoD, frente Segurança): a versão anterior incluía o dia
 * calendário UTC no hash. Isso fazia dois casos criados minutos antes/depois da virada de dia
 * (ex: 23:59 e 00:01) gerarem fingerprints DIFERENTES, escapando da detecção mesmo estando bem
 * dentro da janela de `DUPLICATE_WINDOW_HOURS` pretendida — a janela de tempo real já é aplicada
 * pelo filtro `created_at >= since` em `flagPossibleDuplicate`, então o fingerprint não precisa
 * (e não deve) carregar nenhum componente de data.
 */
function computeDuplicateFingerprint({ companyId, principalPersonId, propertyId }) {
  const raw = `${companyId}::${principalPersonId}::${propertyId || 'sem-imovel'}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 64);
}

/**
 * flagPossibleDuplicate — roda DEPOIS da criação do financing_case (nunca bloqueia a criação em
 * si). Procura outro case do mesmo tenant com o mesmo fingerprint, criado dentro da janela de
 * `DUPLICATE_WINDOW_HOURS`; se achar, marca o case recém-criado com
 * `possibleDuplicateOfCaseId` e audita para revisão humana. Nunca lança erro.
 */
async function flagPossibleDuplicate(financingCase, principalPersonId, actorUserId, transaction) {
  const fingerprint = computeDuplicateFingerprint({
    companyId: financingCase.companyId,
    principalPersonId,
    propertyId: financingCase.propertyId,
  });

  const since = new Date(Date.now() - DUPLICATE_WINDOW_HOURS * 60 * 60 * 1000);
  const existing = await FinancingCase.findOne({
    where: {
      companyId: financingCase.companyId,
      duplicateFingerprint: fingerprint,
      id: { [Op.ne]: financingCase.id },
      created_at: { [Op.gte]: since },
    },
    order: [['created_at', 'ASC']],
    transaction,
  });

  financingCase.duplicateFingerprint = fingerprint;
  if (existing) {
    financingCase.possibleDuplicateOfCaseId = existing.id;
    financingCase.duplicateReviewStatus = 'PENDING';
  }
  await financingCase.save({ transaction });

  if (existing) {
    await registrarAuditoria(
      {
        groupId: financingCase.groupId,
        companyId: financingCase.companyId,
        actorUserId,
        action: 'correspondent.case.possible_duplicate',
        entityType: 'FinancingCase',
        entityId: financingCase.id,
        reason: `Possível duplicata do caso ${existing.id} — mesmo proponente principal, imóvel e janela de ${DUPLICATE_WINDOW_HOURS}h. Sinalizado para revisão, criação NÃO foi bloqueada.`,
      },
      transaction
    );
  }

  return { duplicateOfCaseId: existing ? existing.id : null };
}

/**
 * listPendingDuplicateReviews — fila de revisão do caderno ("fingerprint/review"): casos
 * sinalizados que ainda não foram revisados por uma pessoa.
 */
async function listPendingDuplicateReviews(groupId, companyId, transaction) {
  const cases = await FinancingCase.findAll({
    where: { groupId, companyId, duplicateReviewStatus: 'PENDING', status: { [Op.ne]: 'CANCELED' } },
    include: [{ model: CaseApplicant, as: 'applicants', include: [{ model: Person, as: 'person', attributes: ['id', 'legalName'] }] }],
    order: [['created_at', 'DESC']],
    transaction,
  });
  const originalIds = cases.map((c) => c.possibleDuplicateOfCaseId).filter(Boolean);
  const originals = originalIds.length
    ? await FinancingCase.findAll({ where: { id: originalIds, groupId, companyId }, transaction })
    : [];
  const byId = new Map(originals.map((o) => [o.id, o]));
  return cases.map((c) => ({ ...c.toJSON(), originalCase: byId.get(c.possibleDuplicateOfCaseId)?.toJSON() || null }));
}

/**
 * reviewDuplicate — decisão humana sobre a sinalização:
 *  - DISMISS: não é duplicata, o caso segue normalmente;
 *  - CONFIRM: é duplicata, o caso é cancelado (motivo cita o original) e o trabalho continua no caso original ("reusa").
 * Nunca é automático e sempre exige uma nota.
 */
async function reviewDuplicate(financingCaseId, { decision, note }, actorUserId, groupId, companyId, transaction) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  if (!financingCase) {
    throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  }
  if (!financingCase.possibleDuplicateOfCaseId || financingCase.duplicateReviewStatus !== 'PENDING') {
    throw AppError.conflict('Este caso não está na fila de revisão de duplicatas.', 'CASE_DUPLICATE_REVIEW_NOT_PENDING');
  }
  const normalized = String(decision || '').toUpperCase();
  if (!['DISMISS', 'CONFIRM'].includes(normalized)) {
    throw AppError.badRequest('A decisão deve ser DISMISS (não é duplicata) ou CONFIRM (é duplicata).', 'CASE_DUPLICATE_REVIEW_VALIDATION');
  }
  const text = String(note || '').trim();
  if (text.length < 3) {
    throw AppError.badRequest('Informe uma observação sobre a decisão (mínimo 3 caracteres).', 'CASE_DUPLICATE_REVIEW_VALIDATION');
  }

  const originalId = financingCase.possibleDuplicateOfCaseId;
  financingCase.duplicateReviewStatus = normalized === 'DISMISS' ? 'DISMISSED' : 'CONFIRMED';
  financingCase.duplicateReviewedBy = actorUserId || null;
  financingCase.duplicateReviewedAt = new Date();
  financingCase.duplicateReviewNote = text.slice(0, 500);
  await financingCase.save({ transaction });

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: `correspondent.case.duplicate_${normalized === 'DISMISS' ? 'dismissed' : 'confirmed'}`,
      entityType: 'FinancingCase',
      entityId: financingCase.id,
      beforeJson: { duplicateReviewStatus: 'PENDING' },
      afterJson: { duplicateReviewStatus: financingCase.duplicateReviewStatus, originalCaseId: originalId },
      reason: normalized === 'DISMISS'
        ? `Sinalização de duplicata do caso ${originalId} descartada por uma pessoa: ${text}.`
        : `Duplicata do caso ${originalId} confirmada por uma pessoa: ${text}. O trabalho segue no caso original.`,
    },
    transaction
  );

  if (normalized === 'CONFIRM' && !['CANCELED', 'COMPLETED'].includes(financingCase.status)) {
    // Carregado aqui para evitar dependência circular entre os serviços do correspondente.
    // eslint-disable-next-line global-require
    const { cancelCase } = require('./cases/caseWorkflow.service');
    const original = await FinancingCase.findOne({ where: { id: originalId, groupId, companyId }, transaction });
    const quando = original?.get('created_at') ? new Date(original.get('created_at')).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', ' às') : 'data não disponível';
    await cancelCase(financingCase.id, { reason: `Duplicata do caso criado em ${quando}. ${text}` }, actorUserId, groupId, companyId, transaction);
  }

  const refreshed = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  return { financingCase: refreshed, originalCaseId: originalId };
}

module.exports = { computeDuplicateFingerprint, flagPossibleDuplicate, listPendingDuplicateReviews, reviewDuplicate };
