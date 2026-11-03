'use strict';

const { Op, fn, col, where: sqlWhere } = require('sequelize');
const { FinancialEntry, FinancingCase, CommissionEntitlement, CommissionAdjustment, InvoiceRequest, FinancingProposal, IntegrationError, sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { resolveCommissionSplit, readCommissionSettings, TRIGGER_EVENT_LABEL } = require('../commissionSplit.service');
const { providerLabel, caseStatusLabel } = require('../correspondentCatalog');
const { getOrCreateDefaultResultCenter } = require('../../finance/resultCenters.service');
const { createFinancialEntry, reverseFinancialEntry, settleFinancialEntry, settleFinancialEntryPartial, cancelPendingFinancialEntry, computeRemainingAmount } = require('../../finance/financialEntries.service');
const { getBankAccount } = require('../../finance/bankAccounts.service');
const { publishCommissionEntitlementCreated, publishCommissionConfirmed, publishCommissionReceived, publishCommissionAdjusted } = require('../correspondentEvents.service');
const { reconcile } = require('../fiscal/reconciliation.service');
const { recordIntegrationError, resolveIntegrationError } = require('../integrationErrors.service');
const { businessDateKey, startOfBusinessDay } = require('../../../utils/businessDate');

const INVOICE_SOURCE_TYPE_COMMISSION = 'COMMISSION_ENTITLEMENT';
const INVOICE_IN_FLIGHT_STATUSES = ['REQUESTED', 'SUBMITTED', 'UNKNOWN'];
const INVOICE_NON_TERMINAL_STATUSES = [...INVOICE_IN_FLIGHT_STATUSES, 'AUTHORIZED'];
const PERIOD_ERROR_CODES = ['FINANCE_PERIOD_CLOSED', 'FINANCE_PERIOD_IN_REVIEW'];
const MAX_EXTERNAL_CONFIRMATION_LENGTH = 128;
const COMMISSION_RESULT_CENTER_CODE = 'CORRESPONDENT_COMMISSION';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Dinheiro sempre em centavos inteiros: nenhuma conta de comissão passa por ponto flutuante.
function toCents(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100);
}
function fromCents(cents) {
  return Number(cents) / 100;
}
function formatBRL(value) {
  return `R$ ${Number(value).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}
/** Percentual (até 3 casas) sobre centavos, arredondando meio para cima, em aritmética inteira. */
function percentOfCents(cents, percentage) {
  const milli = BigInt(Math.round(Number(percentage) * 1000));
  return Number((BigInt(cents) * milli + 50000n) / 100000n);
}
/** Parte de um valor em centavos para um percentual de 0 a 100 com 2 casas. */
function shareOfCents(cents, sharePct) {
  const hundredths = BigInt(Math.round(Number(sharePct) * 100));
  return Number((BigInt(cents) * hundredths + 5000n) / 10000n);
}

function normalizeUuid(value, label = 'O identificador') {
  const text = String(value ?? '').trim();
  if (!UUID_REGEX.test(text)) {
    throw AppError.badRequest(`${label} informado não é válido.`, 'COMMISSION_ENTITLEMENT_VALIDATION');
  }
  return text.toLowerCase();
}

function wrapPeriodError(err) {
  if (PERIOD_ERROR_CODES.includes(err?.code)) {
    const closed = err.code === 'FINANCE_PERIOD_CLOSED';
    return AppError.conflict(
      `O mês deste lançamento está ${closed ? 'fechado' : 'em revisão de fechamento'} no Financeiro. Reabra o período (com justificativa) ou aguarde a conclusão da revisão e tente de novo.`,
      'COMMISSION_FINANCE_PERIOD_BLOCKED'
    );
  }
  return err;
}

async function findCase(financingCaseId, groupId, companyId, transaction, { lock = false } = {}) {
  const id = normalizeUuid(financingCaseId, 'O caso');
  const financingCase = await FinancingCase.findOne({ where: { id, groupId, companyId }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!financingCase) {
    throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  }
  return financingCase;
}

async function sumAdjustments(entitlementId, transaction, { exceptTypes = [] } = {}) {
  const rows = await CommissionAdjustment.findAll({ where: { commissionEntitlementId: entitlementId, ...(exceptTypes.length ? { adjustmentType: { [Op.notIn]: exceptTypes } } : {}) }, transaction });
  return rows.reduce((sum, r) => sum + toCents(r.amount), 0);
}

/**
 * createCommissionEntitlement — Marco 8 Fase 8. Registra o DIREITO à comissão (status EXPECTED).
 * `baseAmount` é informado explicitamente (ou vem do valor aprovado da proposta vigente) e conferido com
 * a proposta dentro de uma tolerância configurável; `percentage` vem do Motor de Regras (COR_COMMISSION_SPLIT).
 */
async function createCommissionEntitlement(financingCaseId, payload, actorUserId, groupId, companyId, transaction) {
  // Trava o caso: dois pedidos simultâneos de comissão para o mesmo caso não passam juntos pela checagem de repetição.
  const financingCase = await findCase(financingCaseId, groupId, companyId, transaction, { lock: true });
  // Uma única leitura da regra por operação: bloqueio e cálculo usam sempre a mesma versão.
  const split = await resolveCommissionSplit(financingCase.providerCode, groupId, companyId, actorUserId, transaction);
  if (split.blockedCaseStatuses.includes(financingCase.status)) {
    const messages = {
      CANCELED: 'Este caso foi cancelado e não gera comissão.',
      REJECTED: 'Este caso foi recusado pelo banco e não gera comissão.',
    };
    throw AppError.unprocessable(
      messages[financingCase.status] || `Este caso está em "${caseStatusLabel(financingCase.status)}", etapa em que a empresa não permite registrar comissão.`,
      'COMMISSION_ENTITLEMENT_CASE_NOT_ELIGIBLE'
    );
  }

  const rawTrigger = payload?.triggerEvent;
  if (rawTrigger !== undefined && rawTrigger !== null && typeof rawTrigger !== 'string') {
    throw AppError.badRequest('O fato gerador precisa ser um texto.', 'COMMISSION_ENTITLEMENT_VALIDATION');
  }
  const triggerEvent = rawTrigger && String(rawTrigger).trim() ? String(rawTrigger).trim() : split.defaultTriggerEvent;
  if (!split.allowedTriggerEvents.includes(triggerEvent)) {
    throw AppError.badRequest(
      `O fato gerador "${TRIGGER_EVENT_LABEL[triggerEvent] || triggerEvent}" não é aceito. Use um destes: ${split.allowedTriggerEvents.map((t) => TRIGGER_EVENT_LABEL[t] || t).join(', ')}.`,
      'COMMISSION_ENTITLEMENT_VALIDATION'
    );
  }
  const stagesForTrigger = (split.caseStatusesByTriggerEvent || {})[triggerEvent];
  if (Array.isArray(stagesForTrigger) && stagesForTrigger.length && !stagesForTrigger.includes(financingCase.status)) {
    throw AppError.unprocessable(
      `O fato gerador "${TRIGGER_EVENT_LABEL[triggerEvent] || triggerEvent}" só pode ser registrado quando o caso está em: ${stagesForTrigger.map(caseStatusLabel).join(', ')}. O caso está em "${caseStatusLabel(financingCase.status)}".`,
      'COMMISSION_ENTITLEMENT_CASE_STAGE_NOT_ALLOWED'
    );
  }

  // Base da comissão: informada por uma pessoa; sem valor informado, usa o valor aprovado da proposta vigente.
  const proposal = await FinancingProposal.findOne({ where: { financingCaseId: financingCase.id, groupId, companyId, status: 'ACTIVE' }, transaction });
  const proposalExpired = Boolean(proposal && proposal.validUntil && String(proposal.validUntil) < businessDateKey(new Date()));
  let baseCents;
  let baseOrigin = 'informado';
  const informed = !(payload?.baseAmount === undefined || payload?.baseAmount === null || payload?.baseAmount === '');
  if (!informed) {
    if (!proposal) {
      throw AppError.badRequest('Informe o valor-base da comissão: o caso ainda não tem proposta vigente do banco para servir de base.', 'COMMISSION_ENTITLEMENT_VALIDATION');
    }
    if (proposalExpired) {
      throw AppError.badRequest('A proposta vigente do banco está vencida. Informe o valor-base da comissão.', 'COMMISSION_ENTITLEMENT_VALIDATION');
    }
    baseCents = toCents(proposal.approvedAmount);
    baseOrigin = 'valor aprovado da proposta vigente do banco';
  } else {
    const parsed = Number(payload.baseAmount);
    if (typeof payload.baseAmount === 'boolean' || !Number.isFinite(parsed)) {
      throw AppError.badRequest('Informe um valor-base numérico para a comissão.', 'COMMISSION_ENTITLEMENT_VALIDATION');
    }
    baseCents = toCents(parsed);
  }
  if (!Number.isFinite(baseCents) || baseCents <= 0) {
    throw AppError.badRequest('Informe um valor-base maior que zero para a comissão.', 'COMMISSION_ENTITLEMENT_VALIDATION');
  }
  if (baseCents > toCents(split.maxBaseAmount)) {
    throw AppError.badRequest(`O valor-base informado é alto demais para uma comissão (acima de ${formatBRL(split.maxBaseAmount)}, limite configurado em Parâmetros). Confira se não houve erro de digitação.`, 'COMMISSION_ENTITLEMENT_VALIDATION');
  }
  let divergenceNote = '';
  if (informed && proposal && !proposalExpired && Number(proposal.approvedAmount) > 0) {
    const approvedCents = toCents(proposal.approvedAmount);
    const diffPct = (Math.abs(baseCents - approvedCents) / approvedCents) * 100;
    if (diffPct > Number(split.baseAmountTolerancePct)) {
      const justification = typeof payload?.baseJustification === 'string' ? payload.baseJustification.trim() : '';
      if (justification.length < 5) {
        throw AppError.unprocessable(
          `O valor-base informado (${formatBRL(fromCents(baseCents))}) difere ${diffPct.toFixed(1).replace('.', ',')}% do valor aprovado da proposta vigente (${formatBRL(fromCents(approvedCents))}); a tolerância é de ${String(split.baseAmountTolerancePct).replace('.', ',')}%. Informe a justificativa da diferença (mínimo 5 caracteres).`,
          'COMMISSION_BASE_DIVERGES_FROM_PROPOSAL'
        );
      }
      divergenceNote = ` Base diverge ${diffPct.toFixed(1).replace('.', ',')}% da proposta vigente (${formatBRL(fromCents(approvedCents))}); justificativa: ${justification.slice(0, 300)}.`;
    }
  }

  const { percentage, ruleVersionId } = split;
  const amountCents = percentOfCents(baseCents, percentage);
  if (!(amountCents > 0)) {
    throw AppError.badRequest('O valor-base é pequeno demais: a comissão calculada arredonda para R$ 0,00. Informe um valor-base maior.', 'COMMISSION_ENTITLEMENT_VALIDATION');
  }
  const brokerCents = shareOfCents(amountCents, split.brokerSharePct);
  const managerCents = amountCents - brokerCents;
  const baseAmount = fromCents(baseCents);
  const amount = fromCents(amountCents);
  const brokerAmount = fromCents(brokerCents);
  const managerAmount = fromCents(managerCents);

  // Um direito de comissão por caso e fato gerador: duplo clique ou chamada repetida não cria um
  // segundo direito (e, depois de confirmado, um segundo recebível). Para refazer, estorne o anterior.
  const already = split.blockDuplicateCommissionPerTrigger
    ? await CommissionEntitlement.findOne({ where: { groupId, companyId, financingCaseId: financingCase.id, triggerEvent, status: { [Op.ne]: 'ADJUSTED' } }, transaction })
    : null;
  if (already) {
    throw AppError.conflict(
      'Este caso já tem um direito de comissão ativo para esse fato gerador. Estorne o anterior antes de registrar outro.',
      'COMMISSION_ENTITLEMENT_ALREADY_EXISTS'
    );
  }

  const entitlement = await CommissionEntitlement.create(
    {
      groupId,
      companyId,
      financingCaseId: financingCase.id,
      status: 'EXPECTED',
      baseAmount,
      percentage,
      amount,
      providerCode: financingCase.providerCode,
      triggerEvent,
      brokerSharePct: split.brokerSharePct,
      managerSharePct: split.managerSharePct,
      brokerAmount,
      managerAmount,
      ruleVersionId,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishCommissionEntitlementCreated(entitlement, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.commission_entitlement.create',
      entityType: 'FinancingCase',
      entityId: financingCase.id,
      reason: `Direito à comissão de correspondente registrado: ${formatBRL(amount)} (${percentage}% sobre ${formatBRL(baseAmount)}; corretor ${formatBRL(brokerAmount)} e gerente ${formatBRL(managerAmount)}; fato gerador ${TRIGGER_EVENT_LABEL[triggerEvent] || triggerEvent}; base: ${baseOrigin}; regra versão ${ruleVersionId}).${divergenceNote}`,
    },
    transaction
  );

  return entitlement;
}

function addDaysSaoPaulo(days) {
  // Vencimento é data de calendário: meio-dia de São Paulo do dia calculado.
  return new Date(startOfBusinessDay(new Date(), Number(days || 0)).getTime() + 12 * 3600 * 1000);
}

/**
 * confirmCommissionEntitlement — Marco 8 Fase 8. Transição EXPECTED → CONFIRMED → RECEIVABLE no mesmo
 * passo (CONFIRMED é só uma passagem; o estado gravado é RECEIVABLE). "commission.confirmed cria
 * RECEIVABLE no Financeiro com sourceEventId UNIQUE" é satisfeito via `FinancialEntry.idempotencyKey`.
 *
 * Idempotente por `externalConfirmationId` (sem diferenciar maiúsculas de minúsculas): a MESMA confirmação
 * aplicada de novo devolve o resultado existente, nunca cria um segundo RECEIVABLE.
 */
async function confirmCommissionEntitlement(entitlementId, payload, actorUserId, groupId, companyId, transaction) {
  const id = normalizeUuid(entitlementId, 'O direito a comissão');
  const peek = await CommissionEntitlement.findOne({ where: { id, groupId, companyId }, attributes: ['id', 'financingCaseId'], transaction });
  if (!peek) {
    throw AppError.notFound('Direito a comissão não encontrado.', 'COMMISSION_ENTITLEMENT_NOT_FOUND');
  }
  // Ordem de travas: caso → direito (a mesma do cancelamento do caso). O caso travado impede que um
  // cancelamento em paralelo deixe nascer recebível de caso cancelado.
  const financingCase = await findCase(peek.financingCaseId, groupId, companyId, transaction, { lock: true });
  const entitlement = await CommissionEntitlement.findOne({ where: { id, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });

  const rawExternal = payload?.externalConfirmationId;
  if (rawExternal !== undefined && rawExternal !== null && typeof rawExternal !== 'string' && typeof rawExternal !== 'number') {
    throw AppError.badRequest('A identificação da confirmação precisa ser um texto.', 'COMMISSION_ENTITLEMENT_VALIDATION');
  }
  const externalConfirmationId = rawExternal ? String(rawExternal).trim() : null;
  if (!externalConfirmationId) {
    throw AppError.badRequest(
      'Informe a identificação da confirmação do banco: ela garante que a confirmação é idempotente (nunca duplica o recebível).',
      'COMMISSION_ENTITLEMENT_VALIDATION'
    );
  }
  if (externalConfirmationId.length > MAX_EXTERNAL_CONFIRMATION_LENGTH) {
    throw AppError.badRequest(`A identificação da confirmação aceita no máximo ${MAX_EXTERNAL_CONFIRMATION_LENGTH} caracteres.`, 'COMMISSION_ENTITLEMENT_VALIDATION');
  }

  if (entitlement.status === 'ADJUSTED') {
    throw AppError.conflict('Este direito a comissão foi estornado/ajustado (por exemplo, porque o caso foi cancelado) e não pode mais ser confirmado.', 'COMMISSION_ENTITLEMENT_ALREADY_ADJUSTED');
  }
  if (entitlement.status !== 'EXPECTED') {
    if (String(entitlement.externalConfirmationId || '').toLowerCase() === externalConfirmationId.toLowerCase()) {
      return entitlement;
    }
    throw AppError.conflict(
      'Este direito a comissão já foi confirmado com uma identificação diferente — não é possível confirmar de novo.',
      'COMMISSION_ENTITLEMENT_ALREADY_CONFIRMED'
    );
  }

  const settings = await readCommissionSettings(groupId, companyId, actorUserId, transaction);
  if (settings.blockedCaseStatuses.includes(financingCase.status)) {
    throw AppError.unprocessable(
      `O caso está em "${caseStatusLabel(financingCase.status)}", etapa em que a comissão não pode ser confirmada (cancelado, recusado ou bloqueado em Parâmetros).`,
      'COMMISSION_ENTITLEMENT_CASE_NOT_ELIGIBLE'
    );
  }
  // Cada confirmação do banco vale para uma única comissão (a identificação é única por empresa, sem diferenciar caixa).
  const reused = await CommissionEntitlement.findOne({
    where: { companyId, id: { [Op.ne]: entitlement.id }, status: { [Op.ne]: 'ADJUSTED' }, [Op.and]: [sqlWhere(fn('lower', col('external_confirmation_id')), externalConfirmationId.toLowerCase())] },
    transaction,
  });
  if (reused) {
    throw AppError.conflict(
      'Esta identificação de confirmação já foi usada em outra comissão. Cada confirmação do banco vale para uma única comissão.',
      'COMMISSION_EXTERNAL_CONFIRMATION_ALREADY_USED'
    );
  }

  const resultCenter = await getOrCreateDefaultResultCenter(
    groupId,
    companyId,
    COMMISSION_RESULT_CENTER_CODE,
    'Comissões de correspondente bancário',
    transaction,
    actorUserId
  );

  const confirmedAt = new Date();
  let entry;
  try {
    entry = await createFinancialEntry(
      {
        groupId,
        companyId,
        entryType: 'CREDIT',
        nature: 'RECEIVABLE',
        amount: entitlement.amount,
        description: `Comissão de correspondente bancário — caso ${financingCase.id} (provider ${providerLabel(financingCase.providerCode)})`,
        dueAt: addDaysSaoPaulo(settings.receivableDueDays),
        // A receita da comissão pertence ao mês da confirmação (São Paulo), não ao do vencimento.
        competenceMonth: businessDateKey(confirmedAt).slice(0, 7),
        resultCenterId: resultCenter.id,
        bankAccountId: settings.defaultReceiptBankAccountId || undefined,
        chartOfAccountId: settings.defaultChartOfAccountId || undefined,
        idempotencyKey: `correspondent.commission.confirmed:${entitlement.id}`,
      },
      actorUserId,
      transaction
    );
  } catch (err) {
    throw wrapPeriodError(err);
  }

  entitlement.status = 'RECEIVABLE';
  entitlement.confirmedAt = confirmedAt;
  entitlement.externalConfirmationId = externalConfirmationId;
  entitlement.financialEntryId = entry.id;
  entitlement.updatedBy = actorUserId || null;
  try {
    await entitlement.save({ transaction });
  } catch (err) {
    // Duas confirmações simultâneas com a mesma identificação: a segunda perde no índice único.
    if (err?.name === 'SequelizeUniqueConstraintError') {
      throw AppError.conflict(
        'Esta identificação de confirmação já foi usada em outra comissão. Cada confirmação do banco vale para uma única comissão.',
        'COMMISSION_EXTERNAL_CONFIRMATION_ALREADY_USED'
      );
    }
    throw err;
  }

  await publishCommissionConfirmed(entitlement, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.commission_entitlement.confirm',
      entityType: 'FinancingCase',
      entityId: entitlement.financingCaseId,
      beforeJson: { status: 'EXPECTED' },
      afterJson: { status: 'RECEIVABLE', passedThrough: 'CONFIRMED', financialEntryId: entry.id },
      reason: `Comissão de correspondente confirmada (confirmação externa "${externalConfirmationId}") — recebível ${formatBRL(entitlement.amount)} criado no Financeiro (lançamento ${entry.id}), competência ${entry.competenceMonth}.`,
    },
    transaction
  );

  return entitlement;
}

function parseReceivedAt(raw, confirmedAt) {
  if (raw === undefined || raw === null || raw === '') return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(raw));
  const value = dateOnly ? new Date(`${raw}T12:00:00-03:00`) : new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw AppError.badRequest('A data do recebimento é inválida.', 'COMMISSION_ENTITLEMENT_VALIDATION');
  }
  if (businessDateKey(value) > businessDateKey(new Date())) {
    throw AppError.badRequest('A data do recebimento não pode estar no futuro.', 'COMMISSION_ENTITLEMENT_VALIDATION');
  }
  if (confirmedAt && businessDateKey(value) < businessDateKey(confirmedAt)) {
    throw AppError.badRequest('A data do recebimento não pode ser anterior à confirmação da comissão.', 'COMMISSION_ENTITLEMENT_VALIDATION');
  }
  return value;
}

/**
 * receiveCommissionEntitlement — o banco pagou. Liquida o recebível no Financeiro (o caixa registra a entrada)
 * com a data efetiva, a conta e o valor realmente recebidos. Termina sempre com o lançamento liquidado:
 * recebimento a menor exige o motivo da diferença e fica registrado como ajuste.
 */
async function receiveCommissionEntitlement(entitlementId, actorUserId, groupId, companyId, transaction, payload = {}) {
  const id = normalizeUuid(entitlementId, 'O direito a comissão');
  const entitlement = await CommissionEntitlement.findOne({ where: { id, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!entitlement) {
    throw AppError.notFound('Direito a comissão não encontrado.', 'COMMISSION_ENTITLEMENT_NOT_FOUND');
  }
  if (entitlement.status === 'RECEIVED') return entitlement;
  if (entitlement.status !== 'RECEIVABLE') {
    throw AppError.unprocessable(
      'Só uma comissão já lançada como recebível pode ser marcada como recebida.',
      'COMMISSION_ENTITLEMENT_NOT_RECEIVABLE'
    );
  }

  const receivedAt = parseReceivedAt(payload?.receivedAt, entitlement.confirmedAt);
  const beforeStatus = entitlement.status;
  const financialEntryId = entitlement.financialEntryId;
  let entry = financialEntryId ? await FinancialEntry.findByPk(financialEntryId, { transaction, lock: transaction.LOCK.UPDATE }) : null;
  if (!entry) {
    throw AppError.conflict('Esta comissão não tem lançamento financeiro: não dá para registrar o recebimento. Confirme a comissão antes.', 'COMMISSION_ENTITLEMENT_FINANCIAL_ENTRY_MISSING');
  }
  if (['REVERSED', 'CANCELLED'].includes(entry.status)) {
    throw AppError.conflict('O lançamento financeiro desta comissão foi estornado ou cancelado: não dá para marcá-la como recebida.', 'COMMISSION_ENTITLEMENT_FINANCIAL_ENTRY_CLOSED');
  }
  if (entry.status === 'SETTLED') {
    throw AppError.conflict('O lançamento financeiro desta comissão já está liquidado por outro caminho. Confira o Financeiro.', 'COMMISSION_ENTITLEMENT_FINANCIAL_ENTRY_CLOSED');
  }

  const remainingCents = toCents(entry.status === 'PARTIALLY_SETTLED' ? await computeRemainingAmount(entry, transaction) : entry.amount);
  let receivedCents = remainingCents;
  const rawAmount = payload?.receivedAmount;
  if (!(rawAmount === undefined || rawAmount === null || rawAmount === '')) {
    const parsed = Number(rawAmount);
    if (typeof rawAmount === 'boolean' || !Number.isFinite(parsed) || parsed <= 0) {
      throw AppError.badRequest('O valor recebido precisa ser um número maior que zero.', 'COMMISSION_ENTITLEMENT_VALIDATION');
    }
    receivedCents = toCents(parsed);
  }
  if (receivedCents > remainingCents) {
    throw AppError.badRequest(`O valor recebido (${formatBRL(fromCents(receivedCents))}) é maior que o saldo a receber (${formatBRL(fromCents(remainingCents))}). Registre o excedente direto no Financeiro.`, 'COMMISSION_ENTITLEMENT_VALIDATION');
  }
  const shortCents = remainingCents - receivedCents;
  const differenceReason = typeof payload?.differenceReason === 'string' ? payload.differenceReason.trim() : '';
  if (shortCents > 0 && differenceReason.length < 5) {
    throw AppError.badRequest(`O valor recebido é ${formatBRL(fromCents(shortCents))} menor que o devido. Informe o motivo da diferença (retenção, desconto, glosa...), mínimo 5 caracteres.`, 'COMMISSION_ENTITLEMENT_DIFFERENCE_REASON_REQUIRED');
  }

  // Conta onde o dinheiro entrou: a informada agora, ou a que o recebível já tem (parâmetro da empresa).
  if (payload?.bankAccountId !== undefined && payload?.bankAccountId !== null && payload?.bankAccountId !== '') {
    const bankAccountId = normalizeUuid(payload.bankAccountId, 'A conta bancária');
    if (entry.bankAccountId !== bankAccountId) {
      const bankAccount = await getBankAccount(bankAccountId, transaction);
      if (bankAccount.companyId !== companyId) {
        throw AppError.badRequest('A conta bancária informada pertence a outra empresa.', 'FINANCE_ENTRY_BANK_ACCOUNT_COMPANY_MISMATCH');
      }
      entry.bankAccountId = bankAccountId;
      entry.updatedBy = actorUserId || null;
      await entry.save({ transaction });
    }
  }

  // O recebimento é um fato externo (o banco pagou): vale mesmo se o mês de competência do lançamento já fechou.
  const settleOptions = { viaBankConfirmation: true, ...(receivedAt ? { settledAt: receivedAt } : {}) };
  if (entry.status === 'PENDING' && shortCents === 0) {
    await settleFinancialEntry(entry.id, actorUserId, transaction, settleOptions);
  } else {
    await settleFinancialEntryPartial(entry.id, fromCents(receivedCents), actorUserId, transaction, settleOptions);
    if (shortCents > 0) {
      await cancelPendingFinancialEntry(
        entry.id,
        `Recebimento a menor da comissão ${entitlement.id}: ${differenceReason}`,
        actorUserId,
        transaction,
        { allowPartiallySettled: true, balanceWrittenOff: true, skipPeriodGuard: true }
      );
    }
  }
  entry = await FinancialEntry.findByPk(entry.id, { transaction });
  const expectedStatus = shortCents > 0 ? 'CANCELLED' : 'SETTLED';
  if (entry.status !== expectedStatus) {
    throw AppError.conflict('O lançamento financeiro desta comissão não ficou liquidado. Confira o Financeiro e tente de novo.', 'COMMISSION_ENTITLEMENT_FINANCIAL_ENTRY_NOT_SETTLED');
  }

  entitlement.status = 'RECEIVED';
  entitlement.receivedAt = receivedAt || new Date();
  entitlement.updatedBy = actorUserId || null;
  await entitlement.save({ transaction });

  let difference = null;
  if (shortCents > 0) {
    difference = await CommissionAdjustment.create(
      {
        groupId,
        companyId,
        commissionEntitlementId: entitlement.id,
        adjustmentType: 'RECEIPT_DIFFERENCE',
        statusBefore: beforeStatus,
        amount: fromCents(-shortCents),
        reason: differenceReason.slice(0, 500),
        createdBy: actorUserId || null,
      },
      { transaction }
    );
    await publishCommissionAdjusted(entitlement, difference, transaction);
  }
  await publishCommissionReceived(entitlement, { receivedAmount: fromCents(receivedCents), differenceAmount: fromCents(shortCents) }, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.commission_entitlement.received',
      entityType: 'FinancingCase',
      entityId: entitlement.financingCaseId,
      beforeJson: { status: beforeStatus, financialEntryId },
      afterJson: { status: 'RECEIVED', financialEntryId, receivedAmount: fromCents(receivedCents), receivedAt: entitlement.receivedAt, bankAccountId: entry.bankAccountId || null },
      reason: `Comissão de correspondente recebida (${formatBRL(fromCents(receivedCents))}${shortCents > 0 ? `, ${formatBRL(fromCents(shortCents))} a menos: ${differenceReason}` : ''}); o recebível correspondente foi liquidado no Financeiro.`,
    },
    transaction
  );

  return entitlement;
}

/**
 * Desfaz no Financeiro o lançamento da comissão. `amountToReverseCents` é o que ainda está de pé (valor da comissão
 * menos ajustes anteriores). Lança o erro de período fechado/em revisão para o chamador decidir (estorno pendente).
 */
async function undoFinancialEntryOfCommission(entitlement, amountToReverseCents, reasonText, actorUserId, transaction, { partialCents = null } = {}) {
  const entryToUndo = await FinancialEntry.findByPk(entitlement.financialEntryId, { transaction });
  if (!entryToUndo || ['REVERSED'].includes(entryToUndo.status)) return;
  const fullReason = `Chargeback da comissão de correspondente ${entitlement.id}: ${reasonText}`;
  const options = { skipFrequentAlert: true };
  const children = await FinancialEntry.findAll({ where: { parentEntryId: entryToUndo.id, status: 'SETTLED', nature: entryToUndo.nature }, transaction });

  if (partialCents !== null) {
    if (entryToUndo.status !== 'SETTLED' || children.length) {
      throw AppError.unprocessable('O estorno parcial só vale para comissão recebida de uma vez só. Estorne por inteiro e registre de novo.', 'COMMISSION_PARTIAL_CHARGEBACK_NOT_SUPPORTED');
    }
    await reverseFinancialEntry(entryToUndo.id, fullReason, actorUserId, transaction, { ...options, amount: fromCents(partialCents) });
    return;
  }
  if (entryToUndo.status === 'PENDING') {
    // Recebível que nunca entrou no caixa: cancela (sem criar uma saída que nunca existiu).
    await cancelPendingFinancialEntry(entryToUndo.id, fullReason, actorUserId, transaction);
    return;
  }
  if (entryToUndo.status === 'PARTIALLY_SETTLED' || (entryToUndo.status === 'CANCELLED' && children.length)) {
    // Baixas parciais: cada baixa é estornada e o saldo em aberto é cancelado (estorno maior que o recebido seria falso).
    for (const child of children) {
      // eslint-disable-next-line no-await-in-loop
      await reverseFinancialEntry(child.id, fullReason, actorUserId, transaction, options);
    }
    if (entryToUndo.status === 'PARTIALLY_SETTLED') {
      await cancelPendingFinancialEntry(entryToUndo.id, fullReason, actorUserId, transaction, { allowPartiallySettled: true });
    }
    return;
  }
  if (entryToUndo.status === 'SETTLED') {
    const isPartialLeft = amountToReverseCents < toCents(entryToUndo.amount);
    await reverseFinancialEntry(entryToUndo.id, fullReason, actorUserId, transaction, { ...options, ...(isPartialLeft ? { amount: fromCents(amountToReverseCents) } : {}) });
    if (isPartialLeft) {
      // Havia estornos parciais antes: o saldo final foi estornado e o original encerra como estornado.
      await FinancialEntry.update({ status: 'REVERSED', updatedBy: actorUserId || null }, { where: { id: entryToUndo.id }, transaction });
    }
  }
}

/**
 * chargebackCommissionEntitlement — "Chargeback/estorno sempre cria ajuste, nunca apaga/edita o registro original".
 * Cada estorno é uma linha de `commission_adjustments` (append-only) ligada ao direito original, que mantém o valor.
 * Estorno TOTAL leva o direito a ADJUSTED; estorno PARCIAL (`payload.amount`, só para comissão já recebida) mantém
 * o status e reduz o saldo (valor da comissão + soma dos ajustes).
 *
 * O lançamento financeiro é desfeito junto (cancelado se nunca liquidado; baixas parciais estornadas e saldo
 * cancelado; liquidado estornado). Mês fechado/em revisão no Financeiro: o chargeback do banco acontece mesmo assim e o
 * estorno do lançamento fica PENDENTE e visível. NFS-e: autorizada abre divergência fiscal (decisão humana); em andamento
 * bloqueia o estorno, salvo se a empresa permitir em Parâmetros.
 */
async function chargebackCommissionEntitlement(entitlementId, reasonText, actorUserId, groupId, companyId, transaction, payload = {}) {
  const id = normalizeUuid(entitlementId, 'O direito a comissão');
  const entitlement = await CommissionEntitlement.findOne({ where: { id, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!entitlement) {
    throw AppError.notFound('Direito a comissão não encontrado.', 'COMMISSION_ENTITLEMENT_NOT_FOUND');
  }
  if (entitlement.status === 'ADJUSTED') {
    throw AppError.conflict('Este direito a comissão já foi ajustado/estornado.', 'COMMISSION_ENTITLEMENT_ALREADY_ADJUSTED');
  }
  const reason = typeof reasonText === 'string' ? reasonText.trim() : '';
  if (!reason) {
    throw AppError.badRequest(
      'O chargeback de uma comissão exige um motivo documentado (ajuste auditável).',
      'COMMISSION_ENTITLEMENT_CHARGEBACK_REASON_REQUIRED'
    );
  }
  if (reason.length > 500) {
    throw AppError.badRequest('O motivo do estorno aceita no máximo 500 caracteres.', 'COMMISSION_ENTITLEMENT_CHARGEBACK_REASON_REQUIRED');
  }

  const balanceCents = toCents(entitlement.amount) + (await sumAdjustments(entitlement.id, transaction));
  if (balanceCents <= 0) {
    throw AppError.conflict('Esta comissão não tem mais saldo para estornar.', 'COMMISSION_ENTITLEMENT_ALREADY_ADJUSTED');
  }
  let partialCents = null;
  const rawAmount = payload?.amount;
  if (!(rawAmount === undefined || rawAmount === null || rawAmount === '')) {
    const parsed = Number(rawAmount);
    if (typeof rawAmount === 'boolean' || !Number.isFinite(parsed) || parsed <= 0) {
      throw AppError.badRequest('O valor do estorno precisa ser um número maior que zero.', 'COMMISSION_ENTITLEMENT_VALIDATION');
    }
    const cents = toCents(parsed);
    if (cents > balanceCents) {
      throw AppError.badRequest(`O valor do estorno (${formatBRL(fromCents(cents))}) é maior que o saldo da comissão (${formatBRL(fromCents(balanceCents))}).`, 'COMMISSION_ENTITLEMENT_VALIDATION');
    }
    if (cents < balanceCents) {
      if (entitlement.status !== 'RECEIVED') {
        throw AppError.unprocessable('O estorno parcial só vale para comissão já recebida. Antes do recebimento, estorne a comissão por inteiro e registre de novo.', 'COMMISSION_PARTIAL_CHARGEBACK_NOT_SUPPORTED');
      }
      partialCents = cents;
    }
  }
  const isPartial = partialCents !== null;
  const adjustCents = isPartial ? partialCents : balanceCents;
  const balanceAfterCents = balanceCents - adjustCents;

  const settings = await readCommissionSettings(groupId, companyId, actorUserId, transaction);
  const invoices = await InvoiceRequest.findAll({
    where: { groupId, companyId, sourceType: INVOICE_SOURCE_TYPE_COMMISSION, sourceId: entitlement.id, status: INVOICE_NON_TERMINAL_STATUSES },
    transaction,
  });
  if (!settings.chargebackAllowedWithInvoiceInFlight && invoices.some((i) => INVOICE_IN_FLIGHT_STATUSES.includes(i.status))) {
    throw AppError.conflict(
      'Há uma NFS-e desta comissão ainda em andamento (solicitada, enviada ou sem resposta do emissor). Consulte o status e conclua ou cancele a nota antes de estornar a comissão.',
      'COMMISSION_CHARGEBACK_INVOICE_IN_FLIGHT'
    );
  }

  const beforeJson = entitlement.toJSON();
  const statusBefore = entitlement.status;

  let financialReversalPending = false;
  if (entitlement.financialEntryId) {
    try {
      await undoFinancialEntryOfCommission(entitlement, adjustCents, reason, actorUserId, transaction, { partialCents });
    } catch (err) {
      // Mês já fechado/em revisão no Financeiro: o chargeback do banco acontece mesmo assim. O ajuste da comissão é
      // registrado e o estorno do lançamento fica pendente para o financeiro tratar no período aberto.
      if (PERIOD_ERROR_CODES.includes(err?.code) && !isPartial) {
        financialReversalPending = true;
      } else {
        throw wrapPeriodError(err);
      }
    }
  }

  if (!isPartial) {
    entitlement.status = 'ADJUSTED';
    entitlement.updatedBy = actorUserId || null;
    await entitlement.save({ transaction });
  }

  // O ajuste é um registro próprio (append-only), ligado ao direito original, que mantém o valor dele.
  const adjustment = await CommissionAdjustment.create(
    {
      groupId,
      companyId,
      commissionEntitlementId: entitlement.id,
      adjustmentType: isPartial ? 'PARTIAL_CHARGEBACK' : 'CHARGEBACK',
      statusBefore,
      amount: fromCents(-adjustCents),
      reason: `${reason}${financialReversalPending ? ' [estorno do lançamento financeiro pendente: o mês estava fechado ou em revisão no Financeiro]' : ''}`,
      createdBy: actorUserId || null,
    },
    { transaction }
  );

  // Comissão já exportada ao contador: o estorno gera a linha de ajuste (nunca em silêncio).
  const { zeroOutExportedSource, adjustExportLine } = require('../fiscal/accountingExport.service');
  if (isPartial) {
    const { AccountingExportLine } = require('../../../models');
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `export-adjust:${companyId}:COMMISSION_ENTITLEMENT:${entitlement.id}` }, transaction });
    const original = await AccountingExportLine.findOne({ where: { groupId, companyId, sourceType: 'COMMISSION_ENTITLEMENT', sourceId: entitlement.id, adjustmentOfLineId: null }, transaction });
    if (original) {
      await adjustExportLine(original.id, fromCents(-adjustCents), `Estorno parcial da comissão: ${reason}`, actorUserId, groupId, companyId, transaction);
    }
  } else {
    await zeroOutExportedSource('COMMISSION_ENTITLEMENT', entitlement.id, `Chargeback da comissão: ${reason}`, actorUserId, groupId, companyId, transaction);
  }

  if (financialReversalPending) {
    // Marcador persistente e visível (Erros de integração): o lançamento financeiro ainda precisa de estorno no período aberto.
    await recordIntegrationError(
      { groupId, companyId, financingCaseId: entitlement.financingCaseId, providerCode: entitlement.providerCode || 'manual', operation: 'chargeback', errorCode: 'CHARGEBACK_FINANCE_PENDING', message: `A comissão foi estornada, mas o lançamento financeiro ${entitlement.financialEntryId} está num mês fechado ou em revisão e ainda precisa de estorno no período aberto. [comissão ${entitlement.id}]` },
      transaction
    );
  }

  if (invoices.length) {
    await reconcile(
      'COMMISSION_X_FISCAL',
      entitlement.id,
      fromCents(balanceAfterCents),
      invoices.reduce((sum, i) => sum + Number(i.amount), 0),
      actorUserId,
      groupId,
      companyId,
      transaction
    );
  }

  await publishCommissionAdjusted(entitlement, adjustment, transaction);

  const adjustmentView = { id: adjustment.id, adjustmentType: adjustment.adjustmentType, statusBefore, adjustmentAmount: fromCents(-adjustCents), balanceAfter: fromCents(balanceAfterCents) };
  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.commission_entitlement.chargeback_adjustment',
      entityType: 'FinancingCase',
      entityId: entitlement.financingCaseId,
      beforeJson,
      afterJson: { entitlement: entitlement.toJSON(), adjustment: adjustmentView },
      reason: `Comissão de correspondente estornada ${isPartial ? `em parte (${formatBRL(fromCents(adjustCents))})` : '(chargeback)'}: ${reason}.${financialReversalPending ? ' ATENÇÃO: o mês do lançamento está fechado ou em revisão no Financeiro; o estorno do lançamento ficou pendente.' : ''} Direito original de ${formatBRL(entitlement.amount)} preservado no histórico — status era "${statusBefore}".`,
    },
    transaction
  );

  return { entitlement, adjustment: adjustmentView, financialReversalPending };
}

/**
 * completeFinancialReversal — conclui o estorno do lançamento financeiro de uma comissão que foi estornada
 * quando o mês dele estava fechado (o estorno do lançamento ficou pendente). Roda quando o período está
 * aberto de novo (reabertura com justificativa no Financeiro) e encerra o alerta correspondente.
 */
async function completeFinancialReversal(entitlementId, actorUserId, groupId, companyId, transaction) {
  const id = normalizeUuid(entitlementId, 'O direito a comissão');
  const entitlement = await CommissionEntitlement.findOne({ where: { id, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!entitlement) throw AppError.notFound('Direito a comissão não encontrado.', 'COMMISSION_ENTITLEMENT_NOT_FOUND');
  if (entitlement.status !== 'ADJUSTED' || !entitlement.financialEntryId) {
    throw AppError.conflict('Só uma comissão já estornada e com lançamento financeiro pode ter o estorno financeiro concluído.', 'COMMISSION_FINANCIAL_REVERSAL_NOT_APPLICABLE');
  }
  // O que ainda está de pé no Financeiro: valor da comissão menos os ajustes ANTERIORES ao estorno total.
  const standingCents = toCents(entitlement.amount) + (await sumAdjustments(entitlement.id, transaction, { exceptTypes: ['CHARGEBACK'] }));
  const entry = await FinancialEntry.findByPk(entitlement.financialEntryId, { transaction });
  const settledChildren = entry && entry.status === 'CANCELLED' ? await FinancialEntry.count({ where: { parentEntryId: entry.id, status: 'SETTLED' }, transaction }) : 0;
  if (entry && (!['REVERSED', 'CANCELLED'].includes(entry.status) || settledChildren > 0)) {
    try {
      await undoFinancialEntryOfCommission(entitlement, standingCents, `Conclusão do estorno da comissão ${entitlement.id}`, actorUserId, transaction);
    } catch (err) {
      if (PERIOD_ERROR_CODES.includes(err?.code)) {
        throw AppError.conflict('O mês deste lançamento ainda está fechado ou em revisão no Financeiro. Reabra o período (com justificativa) ou aguarde a revisão e tente de novo.', err.code);
      }
      throw err;
    }
  }
  // Só os alertas DESTA comissão (o alerta de outra comissão do mesmo caso continua aberto): o marcador [comissão <id>]
  // vai na mensagem; alertas antigos (sem marcador) casam pelo id do lançamento.
  const pending = await IntegrationError.findAll({ where: { groupId, companyId, financingCaseId: entitlement.financingCaseId, errorCode: 'CHARGEBACK_FINANCE_PENDING', status: 'OPEN' }, transaction });
  const mine = pending.filter((i) => String(i.message).includes(`[comissão ${entitlement.id}]`) || (!/\[comissão /.test(String(i.message)) && String(i.message).includes(String(entitlement.financialEntryId))));
  for (const item of mine) {
    // eslint-disable-next-line no-await-in-loop
    await resolveIntegrationError(item.id, `Estorno financeiro da comissão ${entitlement.id} concluído`, actorUserId, groupId, companyId, transaction);
  }
  await registrarAuditoria(
    { groupId, companyId, actorUserId, action: 'correspondent.commission.financial_reversal_done', entityType: 'FinancingCase', entityId: entitlement.financingCaseId, reason: `Estorno do lançamento financeiro ${entitlement.financialEntryId} da comissão ${entitlement.id} concluído.` },
    transaction
  );
  return entitlement;
}

function adjustmentView(r) {
  return { id: r.id, adjustmentType: r.adjustmentType, statusBefore: r.statusBefore, adjustmentAmount: Number(r.amount), reason: r.reason, createdBy: r.createdBy || null, createdAt: r.created_at || r.createdAt };
}

async function getCommissionEntitlementAdjustments(entitlementId, transaction) {
  const rows = await CommissionAdjustment.findAll({
    where: { commissionEntitlementId: entitlementId },
    order: [['created_at', 'ASC']],
    transaction,
  });
  return rows.map(adjustmentView);
}

async function listCommissionAdjustmentsForCase(financingCaseId, entitlementId, groupId, companyId, transaction) {
  await findCase(financingCaseId, groupId, companyId, transaction);
  const id = normalizeUuid(entitlementId, 'O direito a comissão');
  const entitlement = await CommissionEntitlement.findOne({ where: { id, financingCaseId: normalizeUuid(financingCaseId), groupId, companyId }, attributes: ['id'], transaction });
  if (!entitlement) throw AppError.notFound('Direito a comissão não encontrado neste caso.', 'COMMISSION_ENTITLEMENT_NOT_FOUND');
  return getCommissionEntitlementAdjustments(entitlement.id, transaction);
}

async function listCommissionEntitlements(financingCaseId, groupId, companyId, transaction, { limit = 100, offset = 0 } = {}) {
  const caseId = (await findCase(financingCaseId, groupId, companyId, transaction)).id;
  const rows = await CommissionEntitlement.findAll({
    where: { financingCaseId: caseId, groupId, companyId },
    order: [['created_at', 'DESC']],
    limit: Math.min(Math.max(Number(limit) || 100, 1), 200),
    offset: Math.max(Number(offset) || 0, 0),
    transaction,
  });
  const ids = rows.map((r) => r.id);
  const adjustments = ids.length ? await CommissionAdjustment.findAll({ where: { commissionEntitlementId: ids }, order: [['created_at', 'ASC']], transaction }) : [];
  const entryIds = rows.map((r) => r.financialEntryId).filter(Boolean);
  const entries = entryIds.length ? await FinancialEntry.findAll({ where: { id: entryIds }, attributes: ['id', 'status', 'dueAt', 'settledAt', 'competenceMonth', 'bankAccountId'], transaction }) : [];
  const entryById = Object.fromEntries(entries.map((e) => [e.id, e]));
  return rows.map((r) => {
    const mine = adjustments.filter((a) => a.commissionEntitlementId === r.id);
    const adjustedCents = mine.reduce((sum, a) => sum + toCents(a.amount), 0);
    const entry = r.financialEntryId ? entryById[r.financialEntryId] : null;
    return {
      id: r.id,
      financingCaseId: r.financingCaseId,
      status: r.status,
      providerCode: r.providerCode,
      providerLabel: providerLabel(r.providerCode),
      triggerEvent: r.triggerEvent,
      triggerEventLabel: TRIGGER_EVENT_LABEL[r.triggerEvent] || r.triggerEvent,
      baseAmount: Number(r.baseAmount),
      percentage: Number(r.percentage),
      amount: Number(r.amount),
      brokerSharePct: Number(r.brokerSharePct),
      managerSharePct: Number(r.managerSharePct),
      brokerAmount: Number(r.brokerAmount),
      managerAmount: Number(r.managerAmount),
      ruleVersionId: r.ruleVersionId,
      externalConfirmationId: r.externalConfirmationId,
      confirmedAt: r.confirmedAt,
      receivedAt: r.receivedAt,
      financialEntryId: r.financialEntryId,
      financialEntryStatus: entry ? entry.status : null,
      dueAt: entry ? entry.dueAt : null,
      competenceMonth: entry ? entry.competenceMonth : null,
      adjustments: mine.map(adjustmentView),
      adjustedAmount: fromCents(adjustedCents),
      balanceAmount: fromCents(toCents(r.amount) + adjustedCents),
      // Estornada cujo lançamento financeiro ainda está de pé (estorno financeiro pendente).
      financialReversalPending: Boolean(r.status === 'ADJUSTED' && entry && !['REVERSED', 'CANCELLED'].includes(entry.status)),
      // O modelo mapeia o atributo de criação como `created_at` (opção createdAt: 'created_at'); `r.createdAt` vem vazio.
      createdAt: r.created_at || r.createdAt,
    };
  });
}

module.exports = {
  completeFinancialReversal,
  createCommissionEntitlement,
  confirmCommissionEntitlement,
  receiveCommissionEntitlement,
  chargebackCommissionEntitlement,
  getCommissionEntitlementAdjustments,
  listCommissionAdjustmentsForCase,
  listCommissionEntitlements,
  normalizeUuid,
};
