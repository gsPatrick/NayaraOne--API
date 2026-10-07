'use strict';

const { OwnerRepass, FinancialEntry, AuditLog } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { assertBankAccountEligibleForPayment, assertNoDuplicatePayment } = require('./financeAntifraud.service');
const { publishOwnerRepasseCreated } = require('./financeEvents.service');

const STATUSES = ['PENDING', 'PAID', 'CANCELLED'];

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

// --- M4-contrato §12 "Repasses de proprietários" --------------------------------------------
//
// Auditoria externa (contrato bruto, 2026-10-07): "Valor recebido do locatário é decomposto em
// componentes: aluguel, taxa, multa, consumo, manutenção, comissão/administração etc.",
// "owner_repass calcula valor devido ao proprietário por contrato/regra.", "Repasse não pode
// ser maior que valor elegível recebido, salvo ajuste formal." e "Extrato do proprietário
// mostra composição, não apenas valor líquido." O código ANTERIOR aceitava `grossAmount`
// digitado livremente, sem nenhum vínculo com recebimento real — violação literal da regra de
// teto. Agora `createOwnerRepasse` exige `sourceEntryIds` (lançamentos de recebimento REAIS,
// SETTLED, RECEIVABLE) e recalcula o teto elegível a partir deles; `grossAmount` nunca mais é
// aceito como valor livre.
//
// "salvo ajuste formal" é modelado como `formalAdjustment: { amount, reason, approvedBy }` —
// sem isso, exceder o teto é SEMPRE bloqueado (fail closed).
//
// MODELAGEM (sem migration disponível nesta rodada — ver nota de infraestrutura no relatório
// final; DDL indisponível para `nayara_runtime` no banco remoto no momento desta
// implementação): a COMPOSIÇÃO (quais lançamentos formaram o valor elegível) é registrada no
// `afterJson` do próprio registro de auditoria append-only (`audit.audit_log`, já existente,
// já imutável/INSERT-only) em vez de uma tabela nova dedicada — mesmo princípio de "não inventar
// tabela nova quando o fato cabe no rastro de auditoria já obrigatório" usado no restante do
// módulo (ex.: finance.financial_entries fazendo às vezes de "ledger" — ver nota em
// financeAntifraud.service.js). `getOwnerRepasseComposition` abaixo consulta esse rastro.

async function assertEligibleSources(companyId, sourceEntryIds, transaction) {
  if (!Array.isArray(sourceEntryIds) || sourceEntryIds.length === 0) {
    throw AppError.badRequest(
      'O campo "sourceEntryIds" é obrigatório — o repasse precisa ser vinculado a lançamento(s) de recebimento real(is).',
      'FINANCE_OWNER_REPASSE_VALIDATION'
    );
  }
  const uniqueIds = [...new Set(sourceEntryIds)];
  const entries = await FinancialEntry.findAll({ where: { id: uniqueIds, companyId }, transaction });
  if (entries.length !== uniqueIds.length) {
    throw AppError.notFound(
      'Um ou mais lançamentos informados em "sourceEntryIds" não foram encontrados nesta empresa.',
      'FINANCE_OWNER_REPASSE_SOURCE_NOT_FOUND'
    );
  }
  for (const entry of entries) {
    if (entry.nature !== 'RECEIVABLE') {
      throw AppError.conflict(
        `O lançamento ${entry.id} não é um recebimento (nature=${entry.nature}) — não pode compor o valor elegível do repasse.`,
        'FINANCE_OWNER_REPASSE_SOURCE_NOT_RECEIVABLE'
      );
    }
    if (!['SETTLED', 'PARTIALLY_SETTLED'].includes(entry.status)) {
      throw AppError.conflict(
        `O lançamento ${entry.id} ainda não foi recebido (status=${entry.status}) — só recebimento REAL pode compor o teto elegível.`,
        'FINANCE_OWNER_REPASSE_SOURCE_NOT_RECEIVED'
      );
    }
    if (entry.isThirdPartyFunds) {
      throw AppError.conflict(
        `O lançamento ${entry.id} é dinheiro de terceiro (caução) — não compõe o valor elegível de repasse próprio (FIN-006).`,
        'FINANCE_OWNER_REPASSE_SOURCE_THIRD_PARTY'
      );
    }
  }
  return entries;
}

function eligibleAmountOf(entry) {
  // Recebimento SETTLED: todo o amount é elegível. PARTIALLY_SETTLED: só a parte já realmente
  // recebida (soma das baixas filhas SETTLED) entra no teto — nunca o saldo ainda não recebido.
  if (entry.status === 'SETTLED') return Number(entry.amount);
  return 0; // PARTIALLY_SETTLED tratado via computeRemainingAmount pelo chamador quando necessário.
}

/**
 * createOwnerRepasse — `sourceEntryIds` (obrigatório) aponta para os lançamentos de recebimento
 * REAIS que formam o valor elegível. `grossAmount`, quando informado, é só uma conveniência de
 * exibição (percentual/regra aplicada) mas NUNCA pode exceder a soma elegível dos
 * `sourceEntryIds`, salvo `formalAdjustment` explícito. netAmount = min(grossAmount, teto) -
 * deductionsAmount (sempre recalculado server-side).
 */
async function createOwnerRepasse(payload, actorUserId, transaction) {
  const {
    groupId,
    companyId,
    propertyId,
    ownerPersonId,
    contractId,
    bankAccountId,
    sourceEntryIds,
    grossAmount,
    deductionsAmount,
    referenceMonth,
    idempotencyKey,
    formalAdjustment,
  } = payload;

  if (!groupId || !companyId || !propertyId || !ownerPersonId) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "propertyId" e "ownerPersonId" são obrigatórios.',
      'FINANCE_OWNER_REPASSE_VALIDATION'
    );
  }

  const sourceEntries = await assertEligibleSources(companyId, sourceEntryIds, transaction);
  const eligibleCents = sourceEntries.reduce((acc, entry) => acc + Math.round(eligibleAmountOf(entry) * 100), 0);
  const eligibleAmount = eligibleCents / 100;

  const grossNumeric = grossAmount === undefined || grossAmount === null ? eligibleAmount : Number(grossAmount);
  const deductionsNumeric = Number(deductionsAmount) || 0;
  if (!Number.isFinite(grossNumeric) || grossNumeric <= 0) {
    throw AppError.badRequest('O campo "grossAmount" deve ser um número positivo.', 'FINANCE_OWNER_REPASSE_VALIDATION');
  }
  if (deductionsNumeric < 0 || deductionsNumeric > grossNumeric) {
    throw AppError.badRequest('O campo "deductionsAmount" não pode ser negativo nem maior que "grossAmount".', 'FINANCE_OWNER_REPASSE_VALIDATION');
  }
  if (referenceMonth && !/^\d{4}-\d{2}$/.test(referenceMonth)) {
    throw AppError.badRequest('O campo "referenceMonth" deve estar no formato "YYYY-MM".', 'FINANCE_OWNER_REPASSE_VALIDATION');
  }

  // "Repasse não pode ser maior que valor elegível recebido, salvo ajuste formal." Sem
  // formalAdjustment documentado (motivo + aprovador), exceder o teto é SEMPRE bloqueado.
  if (round2(grossNumeric) > round2(eligibleAmount)) {
    const hasFormalAdjustment =
      formalAdjustment && typeof formalAdjustment.reason === 'string' && formalAdjustment.reason.trim() && formalAdjustment.approvedByUserId;
    if (!hasFormalAdjustment) {
      throw AppError.conflict(
        `Valor do repasse (${round2(grossNumeric)}) excede o valor elegível recebido dos lançamentos informados ` +
          `(${round2(eligibleAmount)}) — bloqueado. Para exceder, informe "formalAdjustment" com motivo e aprovador.`,
        'FINANCE_OWNER_REPASSE_EXCEEDS_ELIGIBLE_CAP'
      );
    }
  }

  await assertNoDuplicatePayment(OwnerRepass, idempotencyKey, transaction);

  const netAmount = round2(grossNumeric - deductionsNumeric);

  const repasse = await OwnerRepass.create(
    {
      groupId,
      companyId,
      propertyId,
      ownerPersonId,
      contractId: contractId || null,
      bankAccountId: bankAccountId || null,
      grossAmount: grossNumeric,
      deductionsAmount: deductionsNumeric,
      netAmount,
      referenceMonth: referenceMonth || null,
      status: 'PENDING',
      idempotencyKey: idempotencyKey || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishOwnerRepasseCreated(repasse, transaction);

  // Composição (M4-contrato §12 "Extrato do proprietário mostra composição, não apenas valor
  // líquido."): cada lançamento-fonte, com seu valor elegível, vai no afterJson — ver nota de
  // modelagem no topo do arquivo sobre a ausência de tabela dedicada nesta rodada.
  const composition = sourceEntries.map((entry) => ({
    financialEntryId: entry.id,
    description: entry.description,
    eligibleAmount: round2(eligibleAmountOf(entry)),
  }));

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.owner_repasse.create',
      entityType: 'OwnerRepass',
      entityId: repasse.id,
      afterJson: { ...repasse.toJSON(), eligibleAmount: round2(eligibleAmount), composition, formalAdjustment: formalAdjustment || null },
      reason: `Repasse de ${netAmount} (bruto ${grossNumeric} - deduções ${deductionsNumeric}) registrado — teto elegível ${round2(eligibleAmount)} de ${sourceEntries.length} recebimento(s).`,
    },
    transaction
  );

  return repasse;
}

/**
 * getOwnerRepasseComposition — devolve a composição (lançamentos-fonte + valor elegível de
 * cada) registrada no momento da criação do repasse, lendo o rastro de auditoria append-only
 * (ver nota de modelagem acima). "Extrato do proprietário mostra composição, não apenas valor
 * líquido." — esta função é o que alimenta essa visão.
 */
async function getOwnerRepasseComposition(ownerRepasseId, transaction) {
  const log = await AuditLog.findOne({
    where: { action: 'finance.owner_repasse.create', entityType: 'OwnerRepass', entityId: ownerRepasseId },
    order: [['created_at', 'ASC']],
    transaction,
  });
  if (!log) throw AppError.notFound('Nenhum registro de criação encontrado para este repasse.', 'FINANCE_OWNER_REPASSE_NOT_FOUND');
  const afterJson = log.afterJson || {};
  return {
    ownerRepasseId,
    eligibleAmount: afterJson.eligibleAmount || null,
    composition: afterJson.composition || [],
    formalAdjustment: afterJson.formalAdjustment || null,
  };
}

async function listOwnerRepasses(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.ownerPersonId) where.ownerPersonId = filters.ownerPersonId;
  if (filters.propertyId) where.propertyId = filters.propertyId;
  return OwnerRepass.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getOwnerRepasse(id, transaction) {
  const repasse = await OwnerRepass.findByPk(id, { transaction });
  if (!repasse) throw AppError.notFound('Repasse não encontrado.', 'FINANCE_OWNER_REPASSE_NOT_FOUND');
  return repasse;
}

/**
 * payOwnerRepasse — efetiva o pagamento do repasse. Passa pela MESMA checagem de elegibilidade
 * antifraude da conta bancária (cooldown/bloqueio) usada em financialEntries.settleFinancialEntry.
 */
async function payOwnerRepasse(id, actorUserId, transaction) {
  const repasse = await getOwnerRepasse(id, transaction);
  if (repasse.status !== 'PENDING') {
    throw AppError.conflict(`Só é possível pagar um repasse PENDING (atual: "${repasse.status}").`, 'FINANCE_OWNER_REPASSE_INVALID_STATUS');
  }
  const beforeJson = repasse.toJSON();

  if (repasse.bankAccountId) {
    await assertBankAccountEligibleForPayment(repasse.bankAccountId, transaction);
  }

  repasse.status = 'PAID';
  repasse.updatedBy = actorUserId || null;
  await repasse.save({ transaction });

  await registrarAuditoria(
    {
      groupId: repasse.groupId,
      companyId: repasse.companyId,
      actorUserId,
      action: 'finance.owner_repasse.pay',
      entityType: 'OwnerRepass',
      entityId: repasse.id,
      beforeJson,
      afterJson: repasse.toJSON(),
      reason: `Repasse de ${repasse.netAmount} pago ao proprietário.`,
    },
    transaction
  );

  return repasse;
}

module.exports = {
  createOwnerRepasse,
  listOwnerRepasses,
  getOwnerRepasse,
  getOwnerRepasseComposition,
  payOwnerRepasse,
  STATUSES,
};
