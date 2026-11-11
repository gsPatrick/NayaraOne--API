'use strict';

const { OwnerRepass, FinancialEntry, Person } = require('../../../../models');
const { formatCompetenceBR, formatMoneyBR } = require('../../../../utils/formatBR');
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { assertBankAccountEligibleForPayment, assertNoDuplicatePayment } = require('./finance-antifraud.service');
const { publishOwnerRepasseCreated, publishOwnerRepassCompleted } = require('./finance-events.service');
const { resolveRepasseDestination } = require('./owner-repasse-destination.service');
const {
  assertEligibleSources,
  assertSourcesInScope,
  eligibleAmountOf,
  getAlreadyAllocatedAmount,
  getOwnerRepasseComposition,
  listEligibleRepasseSources,
} = require('./owner-repasse-eligibility.service');

// Carregado sob demanda: financial-entry.service importa módulos que importam este arquivo.
function entriesService() {
  // eslint-disable-next-line global-require
  return require('./financial-entry.service');
}

const STATUSES = ['PENDING', 'APPROVED', 'PAID', 'CANCELLED'];

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
// finance-antifraud.service.js). `getOwnerRepasseComposition` (owner-repasse-eligibility.service.js) consulta esse rastro.

const REPASSE_STATUS_PT = { PENDING: 'aguardando aprovação', APPROVED: 'aprovado', PAID: 'pago', CANCELLED: 'cancelado' };

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
    deductionsReason,
    deductionsDocumentFileId,
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

  // Período definido (§12, Frente 3): todo repasse é de uma competência — sem isso não há como
  // impedir dois repasses do mesmo período (ver índice owner_repasses_one_per_period_uq).
  if (!referenceMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(referenceMonth))) {
    throw AppError.badRequest('Informe o período do repasse (mês/ano).', 'FINANCE_OWNER_REPASSE_PERIOD_REQUIRED');
  }
  const samePeriod = await OwnerRepass.findOne({
    where: { companyId, ownerPersonId, propertyId, contractId: contractId || null, referenceMonth, status: ['PENDING', 'APPROVED', 'PAID'] },
    transaction,
  });
  if (samePeriod) {
    throw AppError.conflict(
      `Já existe um repasse para este proprietário e imóvel no período ${formatCompetenceBR(referenceMonth)} (situação: ${REPASSE_STATUS_PT[samePeriod.status] || samePeriod.status}). Cancele o anterior antes de criar outro.`,
      'FINANCE_OWNER_REPASSE_PERIOD_DUPLICATE',
      { existingId: samePeriod.id }
    );
  }

  const sourceEntries = await assertEligibleSources(companyId, sourceEntryIds, transaction);
  await assertSourcesInScope(sourceEntries, { propertyId, contractId }, transaction);
  // remainingCentsByEntry = quanto deste lançamento ainda não foi consumido por repasses
  // anteriores não cancelados — é o "saldo disponível" real deste recebimento para repasse.
  const remainingCentsByEntry = new Map();
  let eligibleCents = 0;
  for (const entry of sourceEntries) {
    const alreadyAllocated = await getAlreadyAllocatedAmount(entry.id, transaction);
    const remainingCents = Math.max(0, Math.round((eligibleAmountOf(entry) - alreadyAllocated) * 100));
    remainingCentsByEntry.set(entry.id, remainingCents);
    eligibleCents += remainingCents;
  }
  const eligibleAmount = eligibleCents / 100;

  const grossNumeric = grossAmount === undefined || grossAmount === null ? eligibleAmount : Number(grossAmount);
  const deductionsNumeric = Number(deductionsAmount) || 0;
  if (!Number.isFinite(grossNumeric) || grossNumeric <= 0) {
    throw AppError.badRequest('O valor bruto do repasse precisa ser um número positivo.', 'FINANCE_OWNER_REPASSE_VALIDATION');
  }
  if (deductionsNumeric < 0 || deductionsNumeric > grossNumeric) {
    throw AppError.badRequest('A dedução não pode ser negativa nem maior que o valor bruto do repasse.', 'FINANCE_OWNER_REPASSE_VALIDATION');
  }
  if (referenceMonth && !/^\d{4}-\d{2}$/.test(referenceMonth)) {
    throw AppError.badRequest('O período do repasse precisa estar no formato mês/ano (ex.: 10/2026).', 'FINANCE_OWNER_REPASSE_VALIDATION');
  }

  // "Repasse não pode ser maior que valor elegível recebido, salvo ajuste formal." Sem
  // formalAdjustment documentado (motivo + aprovador), exceder o teto é SEMPRE bloqueado.
  if (round2(grossNumeric) > round2(eligibleAmount)) {
    const hasFormalAdjustment =
      formalAdjustment && typeof formalAdjustment.reason === 'string' && formalAdjustment.reason.trim() && formalAdjustment.approvedByUserId;
    if (!hasFormalAdjustment) {
      throw AppError.conflict(
        `O valor do repasse (${formatMoneyBR(round2(grossNumeric))}) é maior que o valor elegível recebido dos lançamentos escolhidos ` +
          `(${formatMoneyBR(round2(eligibleAmount))}) — bloqueado. Para exceder, é preciso um ajuste formal com motivo e aprovador.`,
        'FINANCE_OWNER_REPASSE_EXCEEDS_ELIGIBLE_CAP'
      );
    }
  }

  // Caderno M4 §12: "Desconto precisa de motivo/documento/regra." Dedução sem motivo é recusada.
  const deductionsReasonText = typeof deductionsReason === 'string' ? deductionsReason.trim() : '';
  if (deductionsNumeric > 0 && !deductionsReasonText) {
    throw AppError.badRequest('Dedução no repasse exige o motivo do desconto.', 'FINANCE_OWNER_REPASSE_DEDUCTION_REASON_REQUIRED');
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
      deductionsReason: deductionsReasonText || null,
      deductionsDocumentFileId: deductionsDocumentFileId || null,
      netAmount,
      referenceMonth,
      status: 'PENDING',
      idempotencyKey: idempotencyKey || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishOwnerRepasseCreated(repasse, transaction);

  // Composição (M4-contrato §12 "Extrato do proprietário mostra composição, não apenas valor
  // líquido."): cada lançamento-fonte entra com o valor REALMENTE consumido por ESTE repasse
  // (drenado greedily do saldo disponível de cada entry, respeitando a ordem informada em
  // sourceEntryIds), não o teto cheio do lançamento — é esse valor que fica "reservado" e é
  // descontado do saldo disponível de futuros repasses sobre o mesmo lançamento (ver
  // getAlreadyAllocatedAmount). Isso é o que impede dois repasses reutilizarem o mesmo saldo.
  let remainingGrossCentsToDraw = Math.round(grossNumeric * 100);
  const composition = sourceEntries.map((entry) => {
    const availableCents = remainingCentsByEntry.get(entry.id) || 0;
    const drawnCents = Math.min(availableCents, remainingGrossCentsToDraw);
    remainingGrossCentsToDraw -= drawnCents;
    return {
      financialEntryId: entry.id,
      description: entry.description,
      eligibleAmount: drawnCents / 100,
    };
  });

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

async function listOwnerRepasses(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.ownerPersonId) where.ownerPersonId = filters.ownerPersonId;
  if (filters.propertyId) where.propertyId = filters.propertyId;
  return OwnerRepass.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getOwnerRepasse(id, transaction, options = {}) {
  const repasse = await OwnerRepass.findByPk(id, { transaction, lock: options.lock && transaction ? transaction.LOCK.UPDATE : undefined });
  if (!repasse) throw AppError.notFound('Repasse não encontrado.', 'FINANCE_OWNER_REPASSE_NOT_FOUND');
  return repasse;
}

/**
 * approveOwnerRepasse — §12 / Frente 3: OUTRA pessoa (não quem registrou) aprova o repasse. Só
 * aqui nasce o lançamento a pagar (PAYABLE) que efetiva o pagamento — o mesmo caminho de todo
 * pagamento (intenção bancária com confirmação, ou baixa manual com comprovante aprovado).
 * FOR UPDATE no repasse: duas aprovações simultâneas não criam dois lançamentos.
 */
async function approveOwnerRepasse(id, payload, actorUserId, transaction) {
  const repasse = await getOwnerRepasse(id, transaction, { lock: true });
  if (repasse.status !== 'PENDING') {
    throw AppError.conflict(`Só é possível aprovar um repasse PENDING (atual: "${repasse.status}").`, 'FINANCE_OWNER_REPASSE_INVALID_STATUS');
  }
  if (!actorUserId || (repasse.createdBy && String(repasse.createdBy) === String(actorUserId))) {
    throw AppError.forbidden(
      'Quem registrou o repasse não pode aprová-lo — a aprovação precisa ser de outra pessoa (maker-checker).',
      'FINANCE_OWNER_REPASSE_SELF_APPROVAL_FORBIDDEN'
    );
  }
  if (!repasse.referenceMonth) {
    throw AppError.conflict('Repasse sem período definido não pode ser aprovado.', 'FINANCE_OWNER_REPASSE_PERIOD_REQUIRED');
  }
  const { bankAccountId, record: recordDestination } = await resolveRepasseDestination(repasse, payload, actorUserId, transaction);
  if (!bankAccountId) {
    throw AppError.badRequest('Informe a conta bancária de saída do repasse.', 'FINANCE_OWNER_REPASSE_BANK_ACCOUNT_REQUIRED');
  }
  const costCenterId = payload && payload.costCenterId;
  if (!costCenterId) {
    throw AppError.badRequest('Informe o centro de custo do pagamento do repasse.', 'FINANCE_OWNER_REPASSE_VALIDATION');
  }
  await assertBankAccountEligibleForPayment(bankAccountId, transaction);

  // M45: texto do lançamento sem UUID e com período no formato brasileiro.
  const owner = await Person.findByPk(repasse.ownerPersonId, { attributes: ['legalName'], transaction });
  const [refYear, refMonth] = String(repasse.referenceMonth).split('-');
  const periodBR = refMonth ? `${refMonth}/${refYear}` : repasse.referenceMonth;
  const entry = await entriesService().createFinancialEntry(
    {
      groupId: repasse.groupId,
      companyId: repasse.companyId,
      bankAccountId,
      costCenterId,
      contractId: repasse.contractId || null,
      entryType: 'DEBIT',
      nature: 'PAYABLE',
      amount: Number(repasse.netAmount),
      description: `Repasse ao proprietário${owner ? ` ${owner.legalName}` : ''} — período ${periodBR}`,
      dueAt: (payload && payload.dueAt) || null,
      competenceMonth: (payload && payload.competenceMonth) || undefined,
      idempotencyKey: `owner-repasse:${repasse.id}`,
      // Dinheiro do proprietário é de terceiro: não entra como despesa própria nos relatórios.
      isThirdPartyFunds: true,
      thirdPartyReference: `Repasse ao proprietário${owner ? ` ${owner.legalName}` : ''} — período ${periodBR}`,
    },
    actorUserId,
    transaction,
    { ownerRepasseId: repasse.id }
  );

  const beforeJson = repasse.toJSON();
  repasse.status = 'APPROVED';
  repasse.bankAccountId = bankAccountId;
  repasse.financialEntryId = entry.id;
  repasse.approvedByUserId = actorUserId;
  repasse.approvedAt = new Date();
  repasse.updatedBy = actorUserId;
  await repasse.save({ transaction });
  await recordDestination();

  await registrarAuditoria(
    {
      groupId: repasse.groupId,
      companyId: repasse.companyId,
      actorUserId,
      action: 'finance.owner_repasse.approve',
      entityType: 'OwnerRepass',
      entityId: repasse.id,
      beforeJson,
      afterJson: repasse.toJSON(),
      reason: `Repasse de ${repasse.netAmount} (período ${repasse.referenceMonth}) aprovado por outra pessoa — lançamento a pagar ${entry.id} criado.`,
    },
    transaction
  );
  return { repasse, financialEntry: entry };
}

/**
 * payOwnerRepasse — CONFIRMAÇÃO do pagamento (§12 / Frente 3). Antes, marcava PAID direto, sem
 * aprovação, sem comprovante e sem trava. Agora: FOR UPDATE no repasse; precisa estar APPROVED;
 * o lançamento a pagar por trás precisa estar SETTLED — liquidado por confirmação do banco ou por
 * baixa manual com comprovante aprovado (regras de financialEntries.settleFinancialEntry). O
 * comprovante/método fica gravado no repasse.
 */
async function payOwnerRepasse(id, actorUserId, transaction) {
  const repasse = await getOwnerRepasse(id, transaction, { lock: true });
  if (repasse.status === 'PAID') {
    throw AppError.conflict('Este repasse já foi pago.', 'FINANCE_OWNER_REPASSE_ALREADY_PAID');
  }
  if (repasse.status !== 'APPROVED' || !repasse.financialEntryId) {
    throw AppError.conflict(
      `Só é possível confirmar o pagamento de um repasse APROVADO (atual: "${repasse.status}").`,
      'FINANCE_OWNER_REPASSE_NOT_APPROVED'
    );
  }
  const entry = await FinancialEntry.findByPk(repasse.financialEntryId, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!entry || entry.status !== 'SETTLED') {
    throw AppError.conflict(
      'O pagamento do repasse ainda não foi confirmado: o lançamento a pagar precisa estar liquidado (confirmação do banco ou baixa manual com comprovante aprovado).',
      'FINANCE_OWNER_REPASSE_PAYMENT_NOT_CONFIRMED',
      { financialEntryId: repasse.financialEntryId, entryStatus: entry ? entry.status : null }
    );
  }
  const bankConfirmed = ['BANK_CONFIRMED', 'SANDBOX_CONFIRMED'].includes(entry.settlementMethod);
  if (!bankConfirmed && !entry.settlementEvidenceFileId) {
    throw AppError.conflict(
      'O pagamento do repasse não tem comprovante nem confirmação bancária.',
      'FINANCE_OWNER_REPASSE_EVIDENCE_REQUIRED'
    );
  }

  const beforeJson = repasse.toJSON();
  repasse.status = 'PAID';
  repasse.paidAt = entry.settledAt || new Date();
  repasse.confirmedByUserId = actorUserId || null;
  repasse.paymentSettlementMethod = entry.settlementMethod || 'MANUAL_WITH_EVIDENCE';
  repasse.paymentEvidenceFileId = entry.settlementEvidenceFileId || null;
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
      reason: `Repasse de ${repasse.netAmount} (período ${repasse.referenceMonth}) confirmado como pago — ${repasse.paymentSettlementMethod}${repasse.paymentEvidenceFileId ? `, comprovante ${repasse.paymentEvidenceFileId}` : ''}.`,
    },
    transaction
  );
  await publishOwnerRepassCompleted(repasse, transaction);

  return repasse;
}

module.exports = {
  createOwnerRepasse,
  listOwnerRepasses,
  listEligibleRepasseSources,
  getOwnerRepasse,
  getOwnerRepasseComposition,
  approveOwnerRepasse,
  payOwnerRepasse,
  STATUSES,
};
