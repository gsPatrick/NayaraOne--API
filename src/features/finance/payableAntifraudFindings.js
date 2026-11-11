'use strict';

/**
 * Achados do antifraude sobre um pagamento (PAYABLE com conta de destino), Caderno M4 §17, com os números da DEC-007 lidos dos parâmetros
 * (resolveAntifraudThresholds). Cada achado vira um caso próprio e deixa o lançamento retido para revisão humana (flagAnomalousPayment):
 *   - "Pagamento duplicado" (antifraude.duplicidade_janela_dias, 90): mesmo favorecido (conta), mesmo valor e mesmo vencimento (dia de São Paulo) de
 *     outro pagamento não cancelado nem estornado criado na janela => DUPLICATE_PAYMENT_SUSPECT, BLOQUEANTE. Lançamento sem vencimento não tem a impressão
 *     digital do boleto (a chave de idempotência e o índice único continuam valendo para ele).
 *   - "Valor fora do padrão": valor / média dos pagamentos já liquidados à mesma conta (mínimo de 2 no histórico, como antes). A partir de
 *     finance.antifraud_history_multiplier (3,0) => AMOUNT_OUTLIER HIGH (revisão); a partir de antifraude.outlier_bloqueio_multiplicador (10,0) =>
 *     AMOUNT_OUTLIER CRITICAL, BLOQUEANTE.
 *   - "Conta nova + pagamento imediato" (FIN-TS-013): conta sem nenhum pagamento liquidado recebendo de cara a partir de
 *     finance.antifraud_new_account_threshold (R$ 5.000,00) => AMOUNT_OUTLIER HIGH (a conta dentro do resfriamento nem recebe: financeAntifraud).
 *   - "Fornecedor novo de alto valor" (antifraude.fornecedor_novo_dias 30, antifraude.fornecedor_novo_valor_minimo R$ 20.000,00): conta do favorecido
 *     cadastrada há menos dos dias, ou sem pagamento anterior, e valor a partir do mínimo => NEW_SUPPLIER_HIGH_VALUE MEDIUM (verificação antes de pagar).
 * BLOQUEANTE: além de não liquidar, o pagamento retido não avança (intenção e pedido de aprovação recusados) até a liberação humana — paymentAnomalyGate.
 */
const { Op } = require('sequelize');
const { BankAccount, FinancialEntry } = require('../../models');
const { startOfBusinessDay } = require('../../utils/businessDate');

// Comportamento que já existia: com 1 pagamento só a média não significa nada. A amostra mínima do catálogo (antifraude.outlier_amostra_minima = 5)
// não é aplicada aqui porque tiraria da conferência as contas com 2 a 4 pagamentos (afrouxaria a regra): DI-DEC007-1.
const OUTLIER_MIN_HISTORY = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const brl = (n) => Number(n).toFixed(2);
const times = (n) => Number(n).toFixed(1);

async function settledHistory(entry, transaction) {
  return FinancialEntry.findAll({
    // histórico = pagamentos (§17), nunca recebimentos na mesma conta; sem baixas parciais e sem o próprio lançamento
    where: { bankAccountId: entry.bankAccountId, status: 'SETTLED', parentEntryId: null, nature: 'PAYABLE', id: { [Op.ne]: entry.id } },
    transaction,
  });
}

async function duplicateFinding(entry, amount, t, transaction) {
  // A impressão digital do "mesmo boleto" inclui o vencimento (M4-D022 item 1; o modelo não tem número de documento): sem vencimento não há o que comparar.
  if (!entry.dueAt) return null;
  const since = new Date(Date.now() - t.duplicateWindowDays * DAY_MS);
  const dueAt = { [Op.gte]: startOfBusinessDay(entry.dueAt), [Op.lt]: startOfBusinessDay(entry.dueAt, 1) };
  const twin = await FinancialEntry.findOne({
    where: {
      companyId: entry.companyId, nature: 'PAYABLE', bankAccountId: entry.bankAccountId, amount: entry.amount, dueAt,
      parentEntryId: null, reversalOfEntryId: null, isThirdPartyFunds: { [Op.not]: true },
      status: { [Op.notIn]: ['CANCELLED', 'REVERSED'] }, id: { [Op.ne]: entry.id }, created_at: { [Op.gte]: since },
    },
    order: [['created_at', 'ASC']],
    transaction,
  });
  if (!twin) return null;
  return {
    caseType: 'DUPLICATE_PAYMENT_SUSPECT', riskLevel: 'HIGH', blocking: true,
    reason: `Possível pagamento duplicado: o lançamento ${twin.id} (${twin.status}) tem o mesmo favorecido, o mesmo valor (${brl(amount)}) e o mesmo vencimento, ` +
      `criado nos últimos ${t.duplicateWindowDays} dias. O pagamento fica bloqueado até a revisão.`,
  };
}

function outlierFinding(amount, history, t) {
  if (history.length >= OUTLIER_MIN_HISTORY) {
    const average = history.reduce((acc, e) => acc + Number(e.amount), 0) / history.length;
    if (!(average > 0)) return null;
    const score = amount / average;
    const blocking = score >= t.outlierBlockMultiplier;
    if (!blocking && score < t.historyMultiplier) return null;
    return {
      caseType: 'AMOUNT_OUTLIER', riskLevel: blocking ? 'CRITICAL' : 'HIGH', blocking,
      reason: `Valor ${brl(amount)} é ${times(score)}x a média histórica (${brl(average)}) dos ${history.length} pagamentos já liquidados desta conta bancária ` +
        `(limiar FIN-005: ${t.historyMultiplier}x revisa, ${t.outlierBlockMultiplier}x bloqueia)${blocking ? '. O pagamento fica bloqueado até a revisão' : ''}.`,
    };
  }
  if (history.length === 0 && amount >= t.newAccountThreshold) {
    return {
      caseType: 'AMOUNT_OUTLIER', riskLevel: 'HIGH', blocking: false,
      reason: `Primeiro pagamento desta conta bancária já no valor de ${brl(amount)} (limite FIN-005 para conta sem histórico: ${brl(t.newAccountThreshold)}).`,
    };
  }
  return null;
}

async function newSupplierFinding(entry, amount, history, t, transaction) {
  if (amount < t.newSupplierMinAmount) return null;
  const account = await BankAccount.findByPk(entry.bankAccountId, { transaction });
  const createdAt = account && (account.get('created_at') || account.createdAt);
  // Sem data de cadastro legível, a conta conta como nova (falha segura).
  const ageDays = createdAt ? (Date.now() - new Date(createdAt).getTime()) / DAY_MS : 0;
  const isNew = !(ageDays >= t.newSupplierDays);
  if (!isNew && history.length > 0) return null;
  const why = [isNew ? `conta do favorecido cadastrada há ${Math.floor(ageDays)} dia(s) (menos de ${t.newSupplierDays})` : null, history.length === 0 ? 'sem pagamento anterior' : null].filter(Boolean).join(' e ');
  return {
    caseType: 'NEW_SUPPLIER_HIGH_VALUE', riskLevel: 'MEDIUM', blocking: false,
    reason: `Fornecedor novo de alto valor: ${why}, pagamento de ${brl(amount)} (a partir de ${brl(t.newSupplierMinAmount)}). Confira o cadastro do favorecido antes de liberar.`,
  };
}

/** Todos os achados do pagamento (vazio = nada a reter). `t`: resolveAntifraudThresholds. */
async function collectPayableFindings(entry, t, transaction) {
  const amount = Number(entry.amount);
  const history = await settledHistory(entry, transaction);
  const findings = [
    await duplicateFinding(entry, amount, t, transaction),
    outlierFinding(amount, history, t),
    await newSupplierFinding(entry, amount, history, t, transaction),
  ];
  return findings.filter(Boolean);
}

// Tipos de caso abertos por estes achados (o portão de pagamento não reavalia um lançamento que já tem um deles aberto).
const FINDING_CASE_TYPES = Object.freeze(['DUPLICATE_PAYMENT_SUSPECT', 'AMOUNT_OUTLIER', 'NEW_SUPPLIER_HIGH_VALUE']);

module.exports = { collectPayableFindings, FINDING_CASE_TYPES, OUTLIER_MIN_HISTORY };
