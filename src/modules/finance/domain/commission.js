'use strict';

// Domínio da COMISSÃO (Caderno §14 / FIN-011): regra pura, sem banco, sem HTTP, sem AppError.
// Cálculo da comissão e das parcelas, liberação proporcional ao recebimento, ajuste de
// cancelamento, estados e transições permitidas. Os erros de negócio continuam sendo lançados
// pelo serviço (application/services/commission.service.js), com os mesmos textos e códigos.

const crypto = require('node:crypto');
const money = require('./money');

const STATUSES = ['PENDING', 'APPROVED', 'PAID', 'CANCELLED'];

// Estados da parcela e transições que o código executa: PENDING -> PAID (baixa contra lançamento
// liquidado) e PENDING -> CANCELLED (cancelamento da comissão). PAID e CANCELLED são finais.
const INSTALLMENT_TRANSITIONS = {
  PENDING: ['PAID', 'CANCELLED'],
  PAID: [],
  CANCELLED: [],
};

const ADJUSTMENT_TYPE_CANCELLATION = 'CANCELLATION_REVERSAL';

// Dinheiro em centavos inteiros (domain/money.js): nada de multiplicar/somar float.
function round2(value) {
  return Number(money.centsToDecimal(money.toCents(value)));
}

// --- Caderno §14 / FIN-011 — regra de comissão no Motor de Regras ---------------------------
//
// Conferência Nayara 18/10/2026: o percentual vinha do payload e `ruleVersionId` era opcional.
// §14: "Direito de comissão nasce de fato gerador definido pelo Motor de Regras. Percentual e
// base guardam rule_version_id usado no cálculo. Comissão pode ser parcelada na mesma proporção
// do recebimento. Comissão de gerente/corretor/correspondente são componentes separados.
// Pagamento da comissão exige disponibilidade/condição prevista na regra."
//
// Agora:
//  - REG-FIN-001 (Motor de Regras genérico, versionado; Guia §11 `rules.evaluate('REG-FIN-001', ...)`,
//    DEC-005) define o percentual de cada componente (BROKER/MANAGER/CORRESPONDENT), a base (o valor
//    do lançamento a receber de origem) e o modo de arredondamento do centavo (DI-M4CC-1).
//  - O fato gerador é um lançamento a RECEBER real (`sourceEntryId`); a base é o valor dele.
//  - Percentual e base NUNCA vêm do payload; a comissão grava a versão da regra usada.
//  - Sem regra publicada: fail closed (não existe percentual padrão inventado para dinheiro).
//  - O pagamento é liberado na proporção do que o fato gerador já recebeu (ver
//    getCommissionRelease / markInstallmentPaid).

const RULE_CODE = 'REG-FIN-001';
// Código antigo da comissão (até a DEC-005): a migration 20260101009996 move as versões para REG-FIN-001.
const LEGACY_RULE_CODE = 'REG-FIN-002';
const RULE_NAME = 'Percentual de comissão por componente (fato gerador: recebimento)';
const RULE_DESCRIPTION = 'Percentual de comissão de corretor/gerente/correspondente sobre o valor do recebimento que gera o direito (Caderno §14).';
const CONDITION_AST = { fact: 'commissionRuleActive', op: '==', value: true };
const COMPONENTS = ['BROKER', 'MANAGER', 'CORRESPONDENT'];
const BASE_TYPE = 'SOURCE_ENTRY_AMOUNT';

// Chave da trava consultiva que serializa publicações da regra por empresa.
function commissionRuleLockKey(groupId, companyId) {
  return `commission_rule:${groupId}:${companyId}:${RULE_CODE}`;
}

// DI-M4CC-1: o modo de arredondamento faz parte da versão da regra (reproduz o cálculo pela rule_version_id gravada na comissão). Versão antiga sem o
// campo vale como HALF_UP, o padrão.
function ruleRoundingMode(action) {
  const mode = action && action.rounding;
  return money.ROUNDING_MODES.includes(mode) ? mode : money.DEFAULT_ROUNDING_MODE;
}

function buildRuleActionJson(normalized, description, rounding = money.DEFAULT_ROUNDING_MODE) {
  return { components: normalized, base: BASE_TYPE, rounding, description: description || null };
}

function ruleVersionContentHash(actionJson) {
  return crypto.createHash('sha256').update(JSON.stringify({ CONDITION_AST, actionJson })).digest('hex');
}

// Auditoria antes/depois: a versão vigente antes desta publicação.
function describePreviousRuleVersion(previous) {
  return previous
    ? { ruleCode: RULE_CODE, versionNumber: previous.versionNumber, ...(previous.actionJson || {}), effectiveFrom: previous.effectiveFrom, effectiveUntil: null }
    : { ruleCode: RULE_CODE, versionNumber: null, components: {}, situacao: 'nenhuma versão publicada' };
}

function buildActiveRuleView(ruleVersionId, version, action) {
  return {
    ruleVersionId,
    versionNumber: version ? version.versionNumber : null,
    effectiveFrom: version ? version.effectiveFrom : null,
    ruleCode: RULE_CODE,
    components: action.components || {},
    base: action.base || BASE_TYPE,
    rounding: ruleRoundingMode(action),
  };
}

function collectPublisherIds(versions) {
  return [...new Set(versions.map((v) => v.publishedByUserId || v.createdBy).filter(Boolean))];
}

function toRuleVersionView(v, nameById) {
  const publisherId = v.publishedByUserId || v.createdBy || null;
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    status: v.status,
    components: (v.actionJson && v.actionJson.components) || {},
    base: (v.actionJson && v.actionJson.base) || BASE_TYPE,
    rounding: ruleRoundingMode(v.actionJson),
    effectiveFrom: v.effectiveFrom,
    effectiveUntil: v.effectiveUntil,
    current: v.status === 'PUBLISHED' && !v.effectiveUntil,
    publishedByName: publisherId ? (nameById.get(publisherId) || 'Usuário removido') : 'Sistema (carga inicial)',
    publishedAt: v.effectiveFrom || v.createdAt,
  };
}

// --- Cálculo da comissão ----------------------------------------------------------------------

function normalizeComponent(component) {
  return String(component).toUpperCase();
}

// O fato gerador precisa ser um lançamento a receber próprio e válido (não caução, não
// cancelado/estornado, não baixa parcial).
function isInvalidCommissionSource(sourceEntry) {
  return sourceEntry.nature !== 'RECEIVABLE' || sourceEntry.isThirdPartyFunds || ['CANCELLED', 'REVERSED'].includes(sourceEntry.status) || sourceEntry.parentEntryId;
}

function componentPercentage(action, normalizedComponent) {
  return Number((action.components || {})[normalizedComponent]);
}

/**
 * computeCommissionTotal — base x percentual, em decimal exato, com UM arredondamento ao centavo pelo modo da regra (DI-M4CC-1, padrão HALF_UP):
 * 50% de 0,29 = 0,145 -> 0,15 e 50% de 0,01 = 0,005 -> 0,01 (meio centavo sempre para cima); em HALF_EVEN, 0,14 e 0,00.
 * Devolve o texto decimal com 2 casas (o numeric do banco recebe sem passar por float).
 * @param {string|number} baseAmount
 * @param {string|number} percentage
 * @param {string} [rounding]
 * @returns {string}
 */
function computeCommissionTotal(baseAmount, percentage, rounding = money.DEFAULT_ROUNDING_MODE) {
  return money.centsToDecimal(money.percentOfCents(money.toCents(baseAmount), percentage, rounding));
}

/**
 * planInstallments — divide totalAmount em N parcelas iguais em centavos inteiros (a divisão nunca cria nem perde centavo: as N-1 primeiras recebem
 * o quociente inteiro e a última absorve o resto, então a soma das parcelas é exatamente o totalAmount).
 */
function planInstallments(totalAmount, count, firstDueAt) {
  const n = Math.max(1, Number(count) || 1);
  const totalCents = money.toCents(totalAmount);
  const baseCents = Math.trunc(totalCents / n);
  const plan = [];
  const startDate = firstDueAt ? new Date(firstDueAt) : new Date();

  for (let i = 1; i <= n; i += 1) {
    const isLast = i === n;
    const amount = money.centsToDecimal(isLast ? totalCents - baseCents * (n - 1) : baseCents);

    const dueAt = new Date(startDate);
    dueAt.setMonth(dueAt.getMonth() + (i - 1));

    plan.push({ installmentNumber: i, amount, dueAt });
  }

  return plan;
}

// --- Liberação proporcional ao recebimento (centavos inteiros) --------------------------------

const { toCents } = money;

function sumPaidCents(installments) {
  return money.sumCents(installments.filter((i) => i.status === 'PAID').map((i) => i.amount));
}

// Comissão anterior à regra (sem fato gerador registrado): mantém o comportamento antigo.
function buildLegacyRelease(totalCents, paidCents) {
  return { legacy: true, totalAmount: totalCents / 100, receivedRatio: null, releasedAmount: totalCents / 100, paidAmount: paidCents / 100, availableAmount: (totalCents - paidCents) / 100 };
}

// `remainingAmount` só é usado quando o fato gerador está PARTIALLY_SETTLED.
function buildSourceRelease(source, { totalCents, paidCents, baseCents, remainingAmount }) {
  let receivedCents = 0;
  if (source.status === 'SETTLED') receivedCents = baseCents;
  else if (source.status === 'PARTIALLY_SETTLED') receivedCents = baseCents - toCents(remainingAmount);
  receivedCents = Math.max(0, Math.min(receivedCents, baseCents));
  const releasedCents = baseCents > 0 ? Math.floor((totalCents * receivedCents) / baseCents) : 0;
  return {
    legacy: false,
    totalAmount: totalCents / 100,
    sourceEntryId: source.id,
    sourceStatus: source.status,
    receivedAmount: receivedCents / 100,
    receivedRatio: baseCents > 0 ? receivedCents / baseCents : 0,
    releasedAmount: releasedCents / 100,
    paidAmount: paidCents / 100,
    availableAmount: Math.max(0, releasedCents - paidCents) / 100,
  };
}

function exceedsAvailable(installmentAmount, availableAmount) {
  return toCents(installmentAmount) > toCents(availableAmount);
}

function amountsMatch(entryAmount, installmentAmount) {
  return toCents(entryAmount) === toCents(installmentAmount);
}

// --- Estados e transições ---------------------------------------------------------------------

function canTransitionInstallment(from, to) {
  return Object.prototype.hasOwnProperty.call(INSTALLMENT_TRANSITIONS, from) && INSTALLMENT_TRANSITIONS[from].includes(to);
}

function isCommissionCancelled(commission) {
  return commission.status === 'CANCELLED';
}

// Ajuste = o que ainda estava em aberto (não pago) quando o cancelamento aconteceu — é esse
// valor que deixa de ser devido a partir daqui. Negativo por convenção (reduz o direito).
function computeCancellationAdjustment(installments, totalAmount) {
  const paidCents = sumPaidCents(installments);
  const totalCents = toCents(totalAmount);
  return {
    paidAmountBefore: paidCents / 100,
    totalAmountBefore: totalCents / 100,
    adjustmentAmount: -(totalCents - paidCents) / 100,
  };
}

module.exports = {
  STATUSES,
  INSTALLMENT_TRANSITIONS,
  ADJUSTMENT_TYPE_CANCELLATION,
  RULE_CODE,
  LEGACY_RULE_CODE,
  RULE_NAME,
  RULE_DESCRIPTION,
  CONDITION_AST,
  COMPONENTS,
  BASE_TYPE,
  round2,
  commissionRuleLockKey,
  buildRuleActionJson,
  ruleVersionContentHash,
  describePreviousRuleVersion,
  buildActiveRuleView,
  collectPublisherIds,
  toRuleVersionView,
  normalizeComponent,
  isInvalidCommissionSource,
  componentPercentage,
  ruleRoundingMode,
  computeCommissionTotal,
  planInstallments,
  toCents,
  sumPaidCents,
  buildLegacyRelease,
  buildSourceRelease,
  exceedsAvailable,
  amountsMatch,
  canTransitionInstallment,
  isCommissionCancelled,
  computeCancellationAdjustment,
};
