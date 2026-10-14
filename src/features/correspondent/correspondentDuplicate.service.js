'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const { FinancingCase } = require('../../models');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

const DUPLICATE_WINDOW_HOURS = 24;

/**
 * computeDuplicateFingerprint — Marco 8 Fase 11 ("Caso duplicado → fingerprint + fila de
 * revisão, não bloqueio automático silencioso"). Hash determinístico de
 * companyId + personId principal + propertyId (ou "sem-imovel") + dia corrente (UTC) — mesmo
 * espírito do dedupe de pessoas do Marco 3 (personDedup.service.js): sinaliza, nunca bloqueia.
 */
function computeDuplicateFingerprint({ companyId, principalPersonId, propertyId }) {
  const day = new Date().toISOString().slice(0, 10);
  const raw = `${companyId}::${principalPersonId}::${propertyId || 'sem-imovel'}::${day}`;
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

module.exports = { computeDuplicateFingerprint, flagPossibleDuplicate };
