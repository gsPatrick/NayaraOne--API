'use strict';

/**
 * Caderno M4 §17 "Valor fora do padrão -> Anomaly score + revisão", com os números da DEC-007 e a regra da M4-D022 item 5 (DI-DEC007-3):
 *   - histórico = pagamentos (PAYABLE) já liquidados da mesma categoria (plano de contas do lançamento; sem plano de contas, os também sem plano) e do mesmo
 *     favorecido (conta bancária de destino), liquidados nos últimos `antifraude.outlier_historico_meses` meses (12);
 *   - com menos de `antifraude.outlier_amostra_minima` (5) pagamentos, o histórico passa a ser a categoria inteira da empresa (todos os favorecidos), para
 *     que a conta com pouco histórico continue conferida; se a categoria também tiver menos que o mínimo, não pontua (M4-D022 item 5 e teste 6);
 *   - score = valor / MEDIANA do histórico. A partir de `finance.antifraud_history_multiplier` (3,0) => AMOUNT_OUTLIER MEDIUM (retido para revisão); a partir
 *     de `antifraude.outlier_bloqueio_multiplicador` (10,0) => AMOUNT_OUTLIER HIGH, BLOQUEANTE (M4-D022 item 5: "MEDIUM e exige revisão", "HIGH e bloqueia").
 * O motivo do caso traz os números usados (valor, mediana, score, amostras, base e meses), para ser explicável (M4-D022 item 10).
 */
const { Op } = require('sequelize');
const { FinancialEntry } = require('../../../../models');

const brl = (n) => Number(n).toFixed(2);
const times = (n) => Number(n).toFixed(1);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function monthsAgo(months, now = new Date()) {
  const since = new Date(now);
  since.setMonth(since.getMonth() - months);
  return since;
}

/** Pagamentos liquidados da mesma categoria nos últimos meses (com `bankAccountId`, só os do mesmo favorecido). */
async function settledAmounts(entry, since, bankAccountId, transaction) {
  const where = {
    companyId: entry.companyId, nature: 'PAYABLE', status: 'SETTLED', parentEntryId: null, reversalOfEntryId: null, isThirdPartyFunds: { [Op.not]: true },
    chartOfAccountId: entry.chartOfAccountId || null, id: { [Op.ne]: entry.id },
    [Op.or]: [{ settledAt: { [Op.gte]: since } }, { settledAt: null, created_at: { [Op.gte]: since } }],
    ...(bankAccountId ? { bankAccountId } : {}),
  };
  const rows = await FinancialEntry.findAll({ where, attributes: ['amount'], transaction });
  return rows.map((r) => Number(r.amount)).filter((n) => Number.isFinite(n));
}

/** Base de comparação: { basis: 'PAYEE_CATEGORY' | 'COMPANY_CATEGORY' | null, amounts }. */
async function outlierBaseline(entry, t, transaction) {
  const since = monthsAgo(t.outlierHistoryMonths);
  const payee = await settledAmounts(entry, since, entry.bankAccountId, transaction);
  if (payee.length >= t.outlierMinSample) return { basis: 'PAYEE_CATEGORY', amounts: payee, payeeCount: payee.length };
  const category = await settledAmounts(entry, since, null, transaction);
  if (category.length >= t.outlierMinSample) return { basis: 'COMPANY_CATEGORY', amounts: category, payeeCount: payee.length };
  return { basis: null, amounts: category, payeeCount: payee.length };
}

function describeBasis(baseline, t) {
  const categoria = 'da mesma categoria do plano de contas';
  if (baseline.basis === 'PAYEE_CATEGORY') return `dos ${baseline.amounts.length} pagamentos já liquidados a esta conta bancária ${categoria}`;
  return `dos ${baseline.amounts.length} pagamentos já liquidados pela empresa ${categoria} (esta conta tem ${baseline.payeeCount}, menos que o mínimo de ${t.outlierMinSample})`;
}

/** Achado de valor fora do padrão, ou null. `t`: resolveAntifraudThresholds. */
async function amountOutlierFinding(entry, amount, t, transaction) {
  const baseline = await outlierBaseline(entry, t, transaction);
  if (!baseline.basis) return null;
  const med = median(baseline.amounts);
  if (!(med > 0)) return null;
  const score = amount / med;
  const blocking = score >= t.outlierBlockMultiplier;
  if (!blocking && score < t.historyMultiplier) return null;
  return {
    caseType: 'AMOUNT_OUTLIER', riskLevel: blocking ? 'HIGH' : 'MEDIUM', blocking,
    reason: `Valor ${brl(amount)} é ${times(score)}x a mediana (${brl(med)}) ${describeBasis(baseline, t)} nos últimos ${t.outlierHistoryMonths} meses ` +
      `(limiar: ${t.historyMultiplier}x revisa, ${t.outlierBlockMultiplier}x bloqueia)${blocking ? '. O pagamento fica bloqueado até a revisão' : ''}.`,
  };
}

module.exports = { amountOutlierFinding, outlierBaseline, median };
