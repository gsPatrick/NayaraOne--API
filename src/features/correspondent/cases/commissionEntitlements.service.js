'use strict';

const { FinancingCase, CommissionEntitlement, AuditLog, InvoiceRequest, FinancingProposal } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { resolveCommissionSplit } = require('../commissionSplit.service');
const { getOrCreateDefaultResultCenter } = require('../../finance/resultCenters.service');
const { createFinancialEntry, reverseFinancialEntry } = require('../../finance/financialEntries.service');
const { publishCommissionEntitlementCreated, publishCommissionConfirmed } = require('../correspondentEvents.service');
const { reconcile } = require('../fiscal/reconciliation.service');

const INVOICE_SOURCE_TYPE_COMMISSION = 'COMMISSION_ENTITLEMENT';
const INVOICE_NON_TERMINAL_STATUSES = ['REQUESTED', 'SUBMITTED', 'UNKNOWN', 'AUTHORIZED'];

const COMMISSION_RESULT_CENTER_CODE = 'CORRESPONDENT_COMMISSION';

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

async function findCase(financingCaseId, groupId, companyId, transaction) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  if (!financingCase) {
    throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  }
  return financingCase;
}

/**
 * createCommissionEntitlement — Marco 8 Fase 8. Registra o DIREITO à comissão (status EXPECTED).
 * `baseAmount` é informado explicitamente (mesmo padrão de Commission.createCommission em
 * src/features/finance/commissions.service.js — nenhuma comissão no projeto deriva baseAmount
 * automaticamente de outra entidade, sempre é um valor de negócio passado no momento do cálculo).
 * `percentage` vem do Motor de Regras (COR_COMMISSION_SPLIT, Fase 8), nunca hard-coded.
 */
async function createCommissionEntitlement(financingCaseId, payload, actorUserId, groupId, companyId, transaction) {
  const financingCase = await findCase(financingCaseId, groupId, companyId, transaction);

  // Base da comissão ("Chamar Motor de Regras para split/base quando aplicável"): informada por
  // uma pessoa; sem valor informado, usa o valor aprovado da proposta vigente do banco.
  let baseAmount = Number(payload?.baseAmount);
  let baseOrigin = 'informado';
  if (payload?.baseAmount === undefined || payload?.baseAmount === null || payload?.baseAmount === '') {
    const proposal = await FinancingProposal.findOne({ where: { financingCaseId, groupId, companyId, status: 'ACTIVE' }, transaction });
    if (!proposal) {
      throw AppError.badRequest('Informe o valor-base da comissão: o caso ainda não tem proposta vigente do banco para servir de base.', 'COMMISSION_ENTITLEMENT_VALIDATION');
    }
    baseAmount = Number(proposal.approvedAmount);
    baseOrigin = 'valor aprovado da proposta vigente do banco';
  }
  if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
    throw AppError.badRequest('Informe um valor-base maior que zero para a comissão.', 'COMMISSION_ENTITLEMENT_VALIDATION');
  }

  const split = await resolveCommissionSplit(financingCase.providerCode, groupId, companyId, actorUserId, transaction);
  const { percentage, ruleVersionId } = split;
  const amount = round2(baseAmount * (percentage / 100));
  const brokerAmount = round2(amount * (split.brokerSharePct / 100));
  const managerAmount = round2(amount - brokerAmount);

  const triggerEvent = payload?.triggerEvent ? String(payload.triggerEvent).trim() : split.defaultTriggerEvent;
  if (!split.allowedTriggerEvents.includes(triggerEvent)) {
    throw AppError.badRequest(
      `O fato gerador "${triggerEvent}" não é aceito. Use um destes: ${split.allowedTriggerEvents.join(', ')}.`,
      'COMMISSION_ENTITLEMENT_VALIDATION'
    );
  }

  const entitlement = await CommissionEntitlement.create(
    {
      groupId,
      companyId,
      financingCaseId,
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
      entityId: financingCaseId,
      reason: `Direito à comissão de correspondente registrado: R$ ${amount.toFixed(2)} (${percentage}% sobre R$ ${baseAmount.toFixed(2)}; corretor R$ ${brokerAmount.toFixed(2)} e gerente R$ ${managerAmount.toFixed(2)}; fato gerador ${triggerEvent}; base: ${baseOrigin}; regra versão ${ruleVersionId}).`,
    },
    transaction
  );

  return entitlement;
}

/**
 * confirmCommissionEntitlement — Marco 8 Fase 8. Transição EXPECTED → CONFIRMED → RECEIVABLE
 * no mesmo passo: o status CONFIRMED é gravado antes do recebível. "commission.confirmed cria
 * RECEIVABLE no Financeiro com sourceEventId UNIQUE" (citação literal do Caderno) é satisfeito
 * via `FinancialEntry.idempotencyKey` (o mesmo mecanismo de idempotência já usado em todo o
 * Financeiro — não existe uma coluna "sourceEventId" separada no projeto).
 *
 * Idempotente por `externalConfirmationId`: se a MESMA confirmação já foi aplicada a este
 * entitlement, retorna o resultado existente sem criar um segundo RECEIVABLE (nunca duplica —
 * testado adversarialmente).
 */
async function confirmCommissionEntitlement(entitlementId, payload, actorUserId, groupId, companyId, transaction) {
  const entitlement = await CommissionEntitlement.findOne({ where: { id: entitlementId, groupId, companyId }, transaction });
  if (!entitlement) {
    throw AppError.notFound('Direito a comissão não encontrado.', 'COMMISSION_ENTITLEMENT_NOT_FOUND');
  }

  const externalConfirmationId = payload?.externalConfirmationId ? String(payload.externalConfirmationId).trim() : null;
  if (!externalConfirmationId) {
    throw AppError.badRequest(
      'O campo "externalConfirmationId" é obrigatório — garante que a confirmação é idempotente (nunca duplica o recebível).',
      'COMMISSION_ENTITLEMENT_VALIDATION'
    );
  }

  // Idempotência: já confirmado com a MESMA externalConfirmationId → retorna o existente, nunca
  // recria o RECEIVABLE (createFinancialEntry também bloquearia pela idempotencyKey, mas checar
  // aqui primeiro evita uma viagem ao banco desnecessária e dá uma mensagem mais clara).
  if (entitlement.status !== 'EXPECTED') {
    if (entitlement.externalConfirmationId === externalConfirmationId) {
      return entitlement;
    }
    throw AppError.conflict(
      'Este direito a comissão já foi confirmado com uma identificação diferente — não é possível confirmar de novo.',
      'COMMISSION_ENTITLEMENT_ALREADY_CONFIRMED'
    );
  }

  const financingCase = await findCase(entitlement.financingCaseId, groupId, companyId, transaction);
  const resultCenter = await getOrCreateDefaultResultCenter(
    groupId,
    companyId,
    COMMISSION_RESULT_CENTER_CODE,
    'Comissões de correspondente bancário',
    transaction
  );

  const entry = await createFinancialEntry(
    {
      groupId,
      companyId,
      entryType: 'CREDIT',
      nature: 'RECEIVABLE',
      amount: entitlement.amount,
      description: `Comissão de correspondente bancário — caso ${financingCase.id} (provider ${financingCase.providerCode})`,
      dueAt: new Date(),
      resultCenterId: resultCenter.id,
      idempotencyKey: `correspondent.commission.confirmed:${entitlement.id}`,
    },
    actorUserId,
    transaction
  );

  entitlement.status = 'CONFIRMED';
  entitlement.externalConfirmationId = externalConfirmationId;
  entitlement.financialEntryId = entry.id;
  entitlement.updatedBy = actorUserId || null;
  await entitlement.save({ transaction });

  entitlement.status = 'RECEIVABLE';
  await entitlement.save({ transaction });

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
      reason: `Comissão de correspondente confirmada (confirmação externa "${externalConfirmationId}") — recebível R$ ${Number(entitlement.amount).toFixed(2)} criado no Financeiro (lançamento ${entry.id}).`,
    },
    transaction
  );

  return entitlement;
}

async function receiveCommissionEntitlement(entitlementId, actorUserId, groupId, companyId, transaction) {
  const entitlement = await CommissionEntitlement.findOne({ where: { id: entitlementId, groupId, companyId }, transaction });
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

  const beforeStatus = entitlement.status;
  const financialEntryId = entitlement.financialEntryId;
  entitlement.status = 'RECEIVED';
  entitlement.updatedBy = actorUserId || null;
  await entitlement.save({ transaction });

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.commission_entitlement.received',
      entityType: 'FinancingCase',
      entityId: entitlement.financingCaseId,
      beforeJson: { status: beforeStatus, financialEntryId },
      afterJson: { status: 'RECEIVED', financialEntryId },
      reason: 'Comissão de correspondente recebida. O lançamento do Financeiro permanece o mesmo.',
    },
    transaction
  );

  return entitlement;
}

/**
 * chargebackCommissionEntitlement — Marco 8 Fase 8 ("Chargeback/estorno sempre cria ajuste,
 * nunca apaga/edita o registro original", citação literal). MESMO padrão append-only já usado
 * por Commission.cancelCommission (src/features/finance/commissions.service.js): o ajuste é um
 * registro de auditoria (`audit.audit_log`), nunca uma linha editada/apagada. `amount`/`status`
 * do entitlement original permanecem intocados — só o campo `status` muda para ADJUSTED, que é o
 * próprio registro sinalizando "este direito foi estornado", não uma reescrita do fato histórico.
 *
 * Achado real (auditoria pós-DoD, Frente Financeiro/CRM): quando a comissão já tinha sido
 * CONFIRMADA (RECEIVABLE/RECEIVED, com um FinancialEntry real criado no Financeiro), o chargeback
 * só marcava o entitlement como ADJUSTED e nunca tocava o lançamento financeiro correspondente —
 * o recebível ficava aberto no Financeiro pra sempre, mesmo a comissão tendo sido estornada aqui.
 * Agora, se `financialEntryId` existir, o lançamento é estornado de verdade via
 * `reverseFinancialEntry` (mesmo mecanismo já usado por Procurement) antes de marcar o entitlement.
 *
 * Achado real adicional (mesma auditoria, ciclo 2): se já existia uma NFS-e emitida/autorizada
 * para esta comissão (sourceType COMMISSION_ENTITLEMENT) e ela sofre chargeback, NUNCA cancelamos
 * a nota fiscal automaticamente aqui (decisão fiscal exige revisão humana) — em vez disso, abrimos
 * uma `fiscal_reconciliation` (tipo COMMISSION_X_FISCAL, esperado R$ 0,00 vs o valor real da nota),
 * exatamente o comportamento que o Caderno exige: "qualquer diferença abre uma fiscal_reconciliation,
 * nunca é ignorada silenciosamente".
 */
async function chargebackCommissionEntitlement(entitlementId, reasonText, actorUserId, groupId, companyId, transaction) {
  const entitlement = await CommissionEntitlement.findOne({ where: { id: entitlementId, groupId, companyId }, transaction });
  if (!entitlement) {
    throw AppError.notFound('Direito a comissão não encontrado.', 'COMMISSION_ENTITLEMENT_NOT_FOUND');
  }
  if (entitlement.status === 'ADJUSTED') {
    throw AppError.conflict('Este direito a comissão já foi ajustado/estornado.', 'COMMISSION_ENTITLEMENT_ALREADY_ADJUSTED');
  }
  if (!reasonText || !String(reasonText).trim()) {
    throw AppError.badRequest(
      'O chargeback de uma comissão exige um motivo documentado (ajuste auditável).',
      'COMMISSION_ENTITLEMENT_CHARGEBACK_REASON_REQUIRED'
    );
  }

  const beforeJson = entitlement.toJSON();
  const statusBefore = entitlement.status;

  if (entitlement.financialEntryId) {
    await reverseFinancialEntry(
      entitlement.financialEntryId,
      `Chargeback da comissão de correspondente ${entitlement.id}: ${reasonText}`,
      actorUserId,
      transaction
    );
  }

  entitlement.status = 'ADJUSTED';
  entitlement.updatedBy = actorUserId || null;
  await entitlement.save({ transaction });

  const openInvoice = await InvoiceRequest.findOne({
    where: {
      groupId,
      companyId,
      sourceType: INVOICE_SOURCE_TYPE_COMMISSION,
      sourceId: entitlement.id,
      status: INVOICE_NON_TERMINAL_STATUSES,
    },
    transaction,
  });
  if (openInvoice) {
    await reconcile(
      'COMMISSION_X_FISCAL',
      entitlement.id,
      0,
      Number(openInvoice.amount),
      actorUserId,
      groupId,
      companyId,
      transaction
    );
  }

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.commission_entitlement.chargeback_adjustment',
      entityType: 'FinancingCase',
      entityId: entitlement.financingCaseId,
      beforeJson,
      afterJson: {
        entitlement: entitlement.toJSON(),
        adjustment: { adjustmentType: 'CHARGEBACK', statusBefore, adjustmentAmount: round2(-Number(entitlement.amount)) },
      },
      reason: `Comissão de correspondente estornada (chargeback): ${reasonText}. Direito original de R$ ${Number(entitlement.amount).toFixed(2)} preservado no histórico — status era "${statusBefore}".`,
    },
    transaction
  );

  return {
    entitlement,
    adjustment: { adjustmentType: 'CHARGEBACK', statusBefore, adjustmentAmount: round2(-Number(entitlement.amount)) },
  };
}

async function getCommissionEntitlementAdjustments(entitlementId, transaction) {
  const logs = await AuditLog.findAll({
    where: { action: 'correspondent.commission_entitlement.chargeback_adjustment', entityType: 'FinancingCase' },
    transaction,
  });
  return logs
    .filter((log) => (log.afterJson || {}).entitlement?.id === entitlementId)
    .map((log) => (log.afterJson || {}).adjustment)
    .filter(Boolean);
}

async function listCommissionEntitlements(financingCaseId, groupId, companyId, transaction) {
  await findCase(financingCaseId, groupId, companyId, transaction);
  return CommissionEntitlement.findAll({
    where: { financingCaseId, groupId, companyId },
    order: [['created_at', 'DESC']],
    transaction,
  });
}

module.exports = {
  createCommissionEntitlement,
  confirmCommissionEntitlement,
  receiveCommissionEntitlement,
  chargebackCommissionEntitlement,
  getCommissionEntitlementAdjustments,
  listCommissionEntitlements,
};
