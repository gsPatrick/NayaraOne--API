'use strict';

/**
 * Pendências de classificação do excedente de um recebimento (Caderno §10, contrato M4): o valor recebido a
 * mais fica num lançamento-filho PENDING_CLASSIFICATION até um humano decidir a classificação final. NUNCA
 * automático.
 */
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const entries = require('../../infrastructure/repositories/financial-entry.repository');
const { CLASSIFICATION_FINAL_NATURES } = require('../../domain/financial-entry');
const { assertCompetenceOpen, assertPeriodOpenForEntry } = require('./competence-guard');

/**
 * listClassificationPendings — pendências de classificação abertas (M4-contrato §10):
 * lançamentos-filhos nature=PENDING_CLASSIFICATION ainda PENDING, agrupados pelo lançamento
 * original que gerou o excedente.
 */
async function listClassificationPendings(transaction, filters = {}) {
  const where = { nature: 'PENDING_CLASSIFICATION' };
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.parentEntryId) where.parentEntryId = filters.parentEntryId;
  const rows = await entries.findClassificationPendings(where, transaction);
  // Enriquecimento para a UI: data de abertura (createdAt) e dados do lançamento de origem
  // (descrição/valor) — o id da origem continua em parentEntryId, separado do texto.
  const parentIds = [...new Set(rows.map((r) => r.parentEntryId).filter(Boolean))];
  const parents = parentIds.length ? await entries.findSummariesByIds(parentIds, transaction) : [];
  const byId = new Map(parents.map((p) => [p.id, p]));
  return rows.map((r) => {
    const json = r.toJSON();
    const parent = byId.get(r.parentEntryId);
    return {
      ...json,
      createdAt: json.createdAt || json.created_at || null,
      parentEntry: parent ? { id: parent.id, description: parent.description, amount: parent.amount, dueAt: parent.dueAt } : null,
    };
  });
}

/**
 * resolveClassificationPending — fecha a pendência: um humano decide a classificação final do
 * excedente, convertendo a nature para a definitiva (ex.: RECEIVABLE de outro contrato,
 * ADJUSTMENT, devolução). NUNCA automático (é exatamente o oposto do que o contrato proíbe).
 */
async function resolveClassificationPending(id, finalNature, actorUserId, transaction, options = {}) {
  const pending = await entries.findByIdForUpdate(id, transaction);
  if (!pending) throw AppError.notFound('Pendência de classificação não encontrada.', 'FINANCE_CLASSIFICATION_PENDING_NOT_FOUND');
  if (pending.nature !== 'PENDING_CLASSIFICATION') {
    throw AppError.conflict('Este lançamento não é uma pendência de classificação.', 'FINANCE_CLASSIFICATION_PENDING_INVALID');
  }
  if (pending.status !== 'PENDING') {
    throw AppError.conflict('Esta pendência já foi resolvida.', 'FINANCE_CLASSIFICATION_PENDING_ALREADY_RESOLVED');
  }
  const normalizedNature = String(finalNature || '').toUpperCase();
  if (!CLASSIFICATION_FINAL_NATURES.includes(normalizedNature)) {
    throw AppError.badRequest(
      'Escolha como classificar o valor excedente: receita, despesa ou ajuste.',
      'FINANCE_CLASSIFICATION_PENDING_VALIDATION'
    );
  }

  // A3 (revisão independente): transformava qualquer excedente em PAYABLE SETTLED com a conta
  // herdada — sem aprovação, sem comprovante, sem método de liquidação e sem conferir período.
  // Agora: o período da competência precisa estar aberto; RECEIVABLE/ADJUSTMENT apenas
  // classificam um dinheiro que JÁ entrou (fica SETTLED); PAYABLE vira uma OBRIGAÇÃO a pagar
  // (PENDING, com centro de custo) que segue o fluxo normal de pagamento (aprovação + banco ou
  // comprovante) — nunca uma saída de caixa automática.
  await assertPeriodOpenForEntry(pending.companyId, [pending.competenceMonth, new Date()], transaction);
  // C1: classificar muda os números da competência (o excedente passa a contar como receita,
  // despesa ou ajuste) — a competência precisa estar aberta (nem CLOSED nem em REVIEW).
  await assertCompetenceOpen(pending.companyId, pending.competenceMonth, transaction);
  const costCenterId = options && options.costCenterId ? options.costCenterId : null;
  if (normalizedNature === 'PAYABLE' && !costCenterId) {
    throw AppError.badRequest('Classificar como despesa exige o centro de custo.', 'FINANCE_ENTRY_COST_CENTER_REQUIRED');
  }
  const beforeJson = pending.toJSON();
  pending.nature = normalizedNature;
  if (normalizedNature === 'PAYABLE') {
    pending.costCenterId = costCenterId;
  } else {
    pending.status = 'SETTLED';
    pending.settledAt = new Date();
  }
  pending.updatedBy = actorUserId || null;
  await entries.save(pending, transaction);

  await registrarAuditoria(
    {
      groupId: pending.groupId,
      companyId: pending.companyId,
      actorUserId,
      action: 'finance.entry.classification_pending.resolve',
      entityType: 'FinancialEntry',
      entityId: pending.id,
      beforeJson,
      afterJson: pending.toJSON(),
      reason: `Pendência de classificação resolvida manualmente como ${normalizedNature}.`,
    },
    transaction
  );

  return pending;
}

module.exports = { listClassificationPendings, resolveClassificationPending };
