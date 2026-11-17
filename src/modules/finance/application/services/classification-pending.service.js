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
const { assertCentersOfCompany } = require('./entry-reference-guards');
const { assertExcessClassificationComplete } = require('./open-entry-guards');
const { isDueYearPlausible, DUE_DATE_MIN_YEAR, DUE_DATE_MAX_YEAR } = require('../../domain/financial-entry');

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

/** Mesma faixa plausível do vencimento da criação (FIX AUD-2026-09-14, domain/financial-entry.js). */
function assertPlausibleDueDate(dueAt) {
  const parsed = new Date(dueAt);
  if (Number.isNaN(parsed.getTime())) throw AppError.badRequest('O vencimento informado não é uma data válida.', 'FINANCE_ENTRY_VALIDATION');
  if (!isDueYearPlausible(parsed.getUTCFullYear())) {
    throw AppError.badRequest(`O vencimento tem um ano fora do intervalo plausível (${DUE_DATE_MIN_YEAR} a ${DUE_DATE_MAX_YEAR}).`, 'FINANCE_ENTRY_VALIDATION');
  }
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
  // (PENDING, com centro de custo e vencimento) que segue o fluxo normal de pagamento (aprovação
  // + banco ou comprovante) — nunca uma saída de caixa automática.
  // Segunda leva (16/11/2026, DI-BI2-6, M4 §4 e §19): receita exige o centro de resultado ("obrigatório para receita e análise de
  // margem"); despesa exige o vencimento (sem ele a conta some de "contas 7/30/60"). Centros só da própria empresa (FIN-002).
  const costCenterId = normalizedNature === 'PAYABLE' && options && options.costCenterId ? options.costCenterId : null;
  const resultCenterId = normalizedNature === 'RECEIVABLE' && options && options.resultCenterId ? options.resultCenterId : null;
  const dueAt = normalizedNature === 'PAYABLE' && options ? options.dueAt : undefined;
  assertExcessClassificationComplete(normalizedNature, { costCenterId, resultCenterId, dueAt });
  if (dueAt !== undefined) assertPlausibleDueDate(dueAt);
  await assertCentersOfCompany({ costCenterId, resultCenterId }, pending.companyId, transaction);
  await assertPeriodOpenForEntry(pending.companyId, [pending.competenceMonth, new Date(), dueAt || null], transaction);
  // C1: classificar muda os números da competência (o excedente passa a contar como receita,
  // despesa ou ajuste) — a competência precisa estar aberta (nem CLOSED nem em REVIEW).
  await assertCompetenceOpen(pending.companyId, pending.competenceMonth, transaction);
  const beforeJson = pending.toJSON();
  pending.nature = normalizedNature;
  if (normalizedNature === 'PAYABLE') {
    pending.costCenterId = costCenterId;
    pending.dueAt = dueAt; // o excedente nasce sem vencimento: preenchido uma vez, ainda PENDING (migration 20261117010000)
  } else {
    if (normalizedNature === 'RECEIVABLE') pending.resultCenterId = resultCenterId;
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
