'use strict';

/**
 * Achados do antifraude sobre um pagamento (PAYABLE com conta de destino), Caderno M4 §17, com os números da DEC-007 lidos dos parâmetros
 * (resolveAntifraudThresholds). Cada achado vira um caso próprio e deixa o lançamento retido para revisão humana (flagAnomalousPayment):
 *   - "Pagamento duplicado" (antifraude.duplicidade_janela_dias, 90): mesmo favorecido (conta) e mesmo valor de outro pagamento não cancelado nem estornado
 *     cadastrado na janela, com a mesma data de referência: o vencimento (dia de São Paulo); se um deles não tem vencimento, a competência; sem
 *     competência, o dia do cadastro (DI-DEC007-4) => DUPLICATE_PAYMENT_SUSPECT HIGH, BLOQUEANTE.
 *   - "Valor fora do padrão": amount-outlier-finding.js (mediana, amostra mínima, meses de histórico; MEDIUM revisa, HIGH bloqueia).
 *   - "Conta nova + pagamento imediato" (FIN-TS-013): conta sem nenhum pagamento liquidado recebendo de cara a partir de
 *     finance.antifraud_new_account_threshold (R$ 5.000,00) => NEW_ACCOUNT_IMMEDIATE_PAYMENT MEDIUM, retido para revisão (a conta dentro do resfriamento
 *     de finance.bank_account_cooldown_hours nem recebe: finance-antifraud.service.js).
 *   - "Fornecedor novo de alto valor" (antifraude.fornecedor_novo_dias 30, antifraude.fornecedor_novo_valor_minimo R$ 20.000,00): conta do favorecido
 *     cadastrada há menos dos dias, ou sem pagamento anterior, e valor a partir do mínimo => NEW_SUPPLIER_HIGH_VALUE MEDIUM (verificação antes de pagar).
 * Falha segura (DEC-007; M4-D022 item 11): se a conferência de um controle falhar (erro de banco, dado ilegível), o controle assume o resultado mais
 * restritivo — achado HIGH e BLOQUEANTE com o motivo — e nunca libera sem conferir. Cada controle roda num SAVEPOINT, para o erro não derrubar a transação.
 * BLOQUEANTE (achado HIGH): além de não liquidar, o pagamento retido não avança (intenção e pedido de aprovação recusados) até a liberação humana.
 */
const { Op } = require('sequelize');
const { BankAccount, FinancialEntry, sequelize } = require('../../../../models');
const { startOfBusinessDay } = require('../../../../utils/businessDate');
const { amountOutlierFinding } = require('./amount-outlier-finding');

const DAY_MS = 24 * 60 * 60 * 1000;
const brl = (n) => Number(n).toFixed(2);

async function hasPriorPayment(entry, transaction) {
  // pagamento anterior = PAYABLE já liquidado à mesma conta (qualquer categoria, todo o histórico), sem baixas parciais e sem o próprio lançamento
  const n = await FinancialEntry.count({ where: { bankAccountId: entry.bankAccountId, status: 'SETTLED', parentEntryId: null, nature: 'PAYABLE', id: { [Op.ne]: entry.id } }, transaction });
  return n > 0;
}

/**
 * Data de referência do "mesmo boleto" (DI-DEC007-4): o vencimento (dia de São Paulo) quando os dois têm; quando um deles não tem vencimento, a competência
 * (mês a que o pagamento se refere, livro §7 "Competência x caixa"); sem competência, o dia do cadastro. Assim o lançamento em dobro sem vencimento é
 * conferido, e o pagamento recorrente do mesmo valor (outra competência) não é confundido com duplicidade.
 */
function sameReference(entry) {
  const byCompetence = entry.competenceMonth
    ? { competenceMonth: entry.competenceMonth }
    : { created_at: { [Op.gte]: startOfBusinessDay(entry.get('created_at') || new Date()), [Op.lt]: startOfBusinessDay(entry.get('created_at') || new Date(), 1) } };
  if (!entry.dueAt) return byCompetence;
  const sameDueDay = { dueAt: { [Op.gte]: startOfBusinessDay(entry.dueAt), [Op.lt]: startOfBusinessDay(entry.dueAt, 1) } };
  return { [Op.or]: [sameDueDay, { dueAt: null, ...byCompetence }] };
}

async function duplicateFinding(entry, amount, t, transaction) {
  const since = new Date(Date.now() - t.duplicateWindowDays * DAY_MS);
  const twin = await FinancialEntry.findOne({
    where: {
      [Op.and]: [sameReference(entry)],
      companyId: entry.companyId, nature: 'PAYABLE', bankAccountId: entry.bankAccountId, amount: entry.amount,
      parentEntryId: null, reversalOfEntryId: null, isThirdPartyFunds: { [Op.not]: true },
      status: { [Op.notIn]: ['CANCELLED', 'REVERSED'] }, id: { [Op.ne]: entry.id }, created_at: { [Op.gte]: since },
    },
    order: [['created_at', 'ASC']],
    transaction,
  });
  if (!twin) return null;
  const vencimento = entry.dueAt && twin.dueAt ? 'o mesmo vencimento'
    : `a mesma referência (sem vencimento em um deles: vale a ${entry.competenceMonth ? `competência ${entry.competenceMonth}` : 'data de cadastro'})`;
  return {
    caseType: 'DUPLICATE_PAYMENT_SUSPECT', riskLevel: 'HIGH', blocking: true,
    reason: `Possível pagamento duplicado: o lançamento ${twin.id} (${twin.status}) tem o mesmo favorecido, o mesmo valor (${brl(amount)}) e ${vencimento}, ` +
      `cadastrado nos últimos ${t.duplicateWindowDays} dias. O pagamento fica bloqueado até a revisão.`,
  };
}

function newAccountFinding(amount, prior, t) {
  if (prior || amount < t.newAccountThreshold) return null;
  return {
    caseType: 'NEW_ACCOUNT_IMMEDIATE_PAYMENT', riskLevel: 'MEDIUM', blocking: false,
    reason: `Primeiro pagamento desta conta bancária já no valor de ${brl(amount)} (limite do antifraude para conta sem histórico: ${brl(t.newAccountThreshold)}). ` +
      'O pagamento fica retido até a revisão de outra pessoa da equipe.',
  };
}

async function newSupplierFinding(entry, amount, prior, t, transaction) {
  if (amount < t.newSupplierMinAmount) return null;
  const account = await BankAccount.findByPk(entry.bankAccountId, { transaction });
  const createdAt = account && (account.get('created_at') || account.createdAt);
  // Sem data de cadastro legível, a conta conta como nova (falha segura).
  const ageDays = createdAt ? (Date.now() - new Date(createdAt).getTime()) / DAY_MS : 0;
  const isNew = !(ageDays >= t.newSupplierDays);
  if (!isNew && prior) return null;
  const why = [isNew ? `conta do favorecido cadastrada há ${Math.floor(ageDays)} dia(s) (menos de ${t.newSupplierDays})` : null, prior ? null : 'sem pagamento anterior'].filter(Boolean).join(' e ');
  return {
    caseType: 'NEW_SUPPLIER_HIGH_VALUE', riskLevel: 'MEDIUM', blocking: false,
    reason: `Fornecedor novo de alto valor: ${why}, pagamento de ${brl(amount)} (a partir de ${brl(t.newSupplierMinAmount)}). Confira o cadastro do favorecido antes de liberar.`,
  };
}

/** Roda a conferência de um controle num SAVEPOINT; se falhar, devolve o achado mais restritivo daquele controle (HIGH, bloqueante). */
async function safely(control, caseType, transaction, fn) {
  try {
    return transaction ? await sequelize.transaction({ transaction }, (savepoint) => fn(savepoint)) : await fn(undefined);
  } catch (err) {
    return {
      caseType, riskLevel: 'HIGH', blocking: true, failSafe: true,
      reason: `Não foi possível conferir "${control}" (${err && err.message ? err.message : 'erro desconhecido'}). Por segurança o pagamento fica retido e bloqueado até a revisão.`,
    };
  }
}

/** Todos os achados do pagamento (vazio = nada a reter). `t`: resolveAntifraudThresholds. */
async function collectPayableFindings(entry, t, transaction) {
  const amount = Number(entry.amount);
  const findings = [
    await safely('pagamento duplicado', 'DUPLICATE_PAYMENT_SUSPECT', transaction, (sp) => duplicateFinding(entry, amount, t, sp)),
    await safely('valor fora do padrão', 'AMOUNT_OUTLIER', transaction, (sp) => amountOutlierFinding(entry, amount, t, sp)),
    ...(await safely('conta nova e fornecedor novo', 'NEW_SUPPLIER_HIGH_VALUE', transaction, async (sp) => {
      const prior = await hasPriorPayment(entry, sp);
      return [newAccountFinding(amount, prior, t), await newSupplierFinding(entry, amount, prior, t, sp)];
    }).then((r) => (Array.isArray(r) ? r : [r]))),
  ];
  return findings.filter(Boolean);
}

// Tipos de caso abertos por estes achados (o portão de pagamento não reavalia um lançamento que já tem um deles aberto).
const FINDING_CASE_TYPES = Object.freeze(['DUPLICATE_PAYMENT_SUSPECT', 'AMOUNT_OUTLIER', 'NEW_ACCOUNT_IMMEDIATE_PAYMENT', 'NEW_SUPPLIER_HIGH_VALUE']);
// Achado bloqueante = risco alto (duplicidade, múltiplo de bloqueio, conferência que falhou). CRITICAL também bloqueia (caso aberto à mão).
const BLOCKING_RISK_LEVELS = Object.freeze(['HIGH', 'CRITICAL']);

module.exports = { collectPayableFindings, FINDING_CASE_TYPES, BLOCKING_RISK_LEVELS };
