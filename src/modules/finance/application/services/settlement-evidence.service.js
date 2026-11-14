'use strict';

/**
 * Comprovante da baixa manual de um pagamento (revisão independente A4, 18/10/2026; M45 F2): anexado ANTES da
 * aprovação, PDF ou imagem, de uso único pelo conteúdo (SHA-256) e removível só enquanto o lançamento está em
 * aberto. Anexar ou remover invalida as aprovações anteriores (STALE).
 */
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const entries = require('../../infrastructure/repositories/financial-entry.repository');
const { OPEN_FOR_SETTLEMENT_STATUSES, isAcceptedEvidenceMime } = require('../../domain/financial-entry');
const { markApprovalRequestsStale } = require('./approvals.service');

const EVIDENCE_ALREADY_USED = 'Este comprovante já foi usado em outra baixa — cada baixa manual exige o próprio comprovante.';

async function getEntryForUpdate(id, transaction) {
  const entry = await entries.findByIdForUpdate(id, transaction);
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  return entry;
}

/**
 * attachSettlementEvidence — anexa o comprovante (e o motivo) de uma baixa manual ao PAYABLE,
 * ANTES da aprovação (A4). Invalida aprovações anteriores: a decisão precisa ser tomada vendo o
 * comprovante.
 */
async function attachSettlementEvidence(id, payload, actorUserId, transaction) {
  const { evidenceFileId, reason } = payload || {};
  const entry = await getEntryForUpdate(id, transaction);
  if (entry.nature !== 'PAYABLE') {
    throw AppError.conflict('Comprovante de baixa manual só se aplica a pagamento (PAYABLE).', 'FINANCE_SETTLEMENT_EVIDENCE_NOT_APPLICABLE');
  }
  if (!OPEN_FOR_SETTLEMENT_STATUSES.includes(entry.status)) {
    throw AppError.conflict(`Lançamento com status "${entry.status}" não aceita comprovante de baixa.`, 'FINANCE_ENTRY_INVALID_STATUS');
  }
  const normalizedReason = reason ? String(reason).trim() : '';
  if (!evidenceFileId || !normalizedReason) {
    throw AppError.badRequest('Informe o comprovante (arquivo) e o motivo da baixa manual.', 'FINANCE_SETTLEMENT_EVIDENCE_VALIDATION');
  }
  const evidence = await entries.findEvidenceFile(evidenceFileId, entry.companyId, transaction);
  if (!evidence) {
    throw AppError.badRequest(
      'O comprovante informado não foi encontrado nesta empresa — envie o arquivo do comprovante antes.',
      'FINANCE_SETTLEMENT_EVIDENCE_NOT_FOUND'
    );
  }
  if (!isAcceptedEvidenceMime(evidence.mimeType)) {
    throw AppError.badRequest('O comprovante precisa ser PDF ou imagem.', 'FINANCE_SETTLEMENT_EVIDENCE_INVALID_TYPE');
  }
  // F2 (M45): o comprovante é único pelo CONTEÚDO (SHA-256), não só pelo fileId — o mesmo arquivo
  // enviado duas vezes gera dois File com o mesmo hash. Escopo: empresa do lançamento.
  let sameContentFileIds = [evidence.id];
  if (evidence.checksumSha256) {
    if (transaction) {
      await entries.lockEvidenceContent(entry.companyId, evidence.checksumSha256, transaction);
    }
    const twins = await entries.findSameContentFileIds(entry.companyId, evidence.checksumSha256, transaction);
    sameContentFileIds = Array.from(new Set([evidence.id, ...twins.map((f) => f.id)]));
  }
  const reused = await entries.findEvidenceReuse(sameContentFileIds, entry.id, transaction);
  if (reused) {
    throw AppError.conflict(EVIDENCE_ALREADY_USED, 'FINANCE_SETTLEMENT_EVIDENCE_ALREADY_USED', { usedByEntryId: reused.id });
  }

  const beforeJson = entry.toJSON();
  entry.settlementEvidenceFileId = evidence.id;
  entry.settlementReason = normalizedReason;
  entry.settlementEvidenceAttachedBy = actorUserId || null;
  entry.settlementEvidenceAttachedAt = new Date();
  entry.updatedBy = actorUserId || null;
  try {
    await entries.save(entry, transaction);
  } catch (/** @type {any} */ err) {
    if (err && err.name === 'SequelizeUniqueConstraintError') {
      throw AppError.conflict(EVIDENCE_ALREADY_USED, 'FINANCE_SETTLEMENT_EVIDENCE_ALREADY_USED');
    }
    throw err;
  }

  await markApprovalRequestsStale(
    'FinancialEntry',
    entry.id,
    'Comprovante de baixa manual anexado — a aprovação precisa ser feita sobre o comprovante.',
    actorUserId,
    transaction
  );

  await registrarAuditoria(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      actorUserId,
      action: 'finance.entry.settlement_evidence.attach',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      beforeJson,
      afterJson: entry.toJSON(),
      reason: `Comprovante de baixa manual anexado (arquivo ${evidence.id}) — motivo: ${normalizedReason}.`,
    },
    transaction
  );
  return entry;
}

/**
 * detachSettlementEvidence — M45: remove o vínculo do comprovante de baixa manual de um
 * lançamento AINDA NÃO LIQUIDADO (PENDING). Usado para sanear vínculos que violam a regra de
 * comprovante único (ex.: mesmo arquivo/SHA-256 anexado a dois lançamentos antes da regra F2).
 * Não apaga nada do ledger: só limpa as colunas mutáveis do comprovante (o trigger de linha
 * também registra), invalida aprovações e grava auditoria de negócio com o motivo.
 */
async function detachSettlementEvidence(id, payload, actorUserId, transaction) {
  const reason = String((payload && payload.reason) || '').trim();
  if (reason.length < 5) {
    throw AppError.badRequest('Informe o motivo para remover o comprovante (mínimo de 5 caracteres).', 'FINANCE_SETTLEMENT_EVIDENCE_DETACH_REASON_REQUIRED');
  }
  const entry = await getEntryForUpdate(id, transaction);
  if (!entry.settlementEvidenceFileId) {
    throw AppError.conflict('Este lançamento não tem comprovante de baixa anexado.', 'FINANCE_SETTLEMENT_EVIDENCE_NOT_ATTACHED');
  }
  if (entry.status !== 'PENDING') {
    throw AppError.conflict(
      'Só é possível remover o comprovante de um lançamento ainda não liquidado (em aberto).',
      'FINANCE_ENTRY_INVALID_STATUS'
    );
  }
  const beforeJson = entry.toJSON();
  const removedFileId = entry.settlementEvidenceFileId;
  entry.settlementEvidenceFileId = null;
  entry.settlementReason = null;
  entry.settlementEvidenceAttachedBy = null;
  entry.settlementEvidenceAttachedAt = null;
  entry.updatedBy = actorUserId || null;
  await entries.save(entry, transaction);
  await markApprovalRequestsStale(
    'FinancialEntry',
    entry.id,
    'Comprovante de baixa manual removido — a aprovação precisa ser refeita sobre um novo comprovante.',
    actorUserId,
    transaction
  );
  await registrarAuditoria(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      actorUserId,
      action: 'finance.entry.settlement_evidence.detach',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      beforeJson,
      afterJson: entry.toJSON(),
      reason: `Comprovante de baixa manual removido (arquivo ${removedFileId}) — motivo: ${reason}.`,
    },
    transaction
  );
  return entry;
}

module.exports = { attachSettlementEvidence, detachSettlementEvidence };
