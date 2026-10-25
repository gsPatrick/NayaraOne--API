'use strict';

const { Op } = require('sequelize');
const { getInvoiceGraceDays } = require('../commissionSplit.service');
const { buildDimobDataset } = require('./dimobDataset.service');
const { FiscalReconciliation, InvoiceRequest, CommissionEntitlement, DimobBatch, DimobRecord } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');

const VALID_TYPES = ['FINANCE_X_NFSE', 'COMMISSION_X_FISCAL', 'DIMOB_X_CONTRACTS', 'ACCOUNTING_RETURN_X_EXPORT'];
const TYPE_LABEL = {
  FINANCE_X_NFSE: 'Financeiro × NFS-e',
  COMMISSION_X_FISCAL: 'Comissões × fiscal',
  DIMOB_X_CONTRACTS: 'DIMOB × contratos/transações',
  ACCOUNTING_RETURN_X_EXPORT: 'Retorno do contador × exportação',
};

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * reconcile — Marco 8 Fase 12. "Qualquer diferença abre uma fiscal_reconciliation/issue, nunca é
 * ignorada silenciosamente" (citação literal do Caderno). Quando expectedAmount === actualAmount,
 * NÃO cria registro (não há issue nenhuma pra abrir — zero diferença não é "ignorar
 * silenciosamente", é confirmar que bate). Qualquer diferença != 0, por menor que seja, abre.
 */
async function reconcile(reconciliationType, referenceId, expectedAmount, actualAmount, actorUserId, groupId, companyId, transaction) {
  if (!VALID_TYPES.includes(reconciliationType)) {
    throw AppError.badRequest(`Tipo de reconciliação inválido: "${reconciliationType}".`, 'FISCAL_RECONCILIATION_VALIDATION');
  }
  const expected = round2(expectedAmount);
  const actual = round2(actualAmount);
  const difference = round2(expected - actual);

  if (difference === 0) {
    // Voltou a bater: uma issue aberta para o mesmo item é encerrada sozinha, com auditoria.
    await autoResolveIfOpen(reconciliationType, referenceId, actorUserId, groupId, companyId, transaction);
    return null;
  }

  return openReconciliation(reconciliationType, referenceId, expected, actual, difference, actorUserId, groupId, companyId, transaction);
}

async function autoResolveIfOpen(reconciliationType, referenceId, actorUserId, groupId, companyId, transaction) {
  const open = await FiscalReconciliation.findOne({ where: { groupId, companyId, reconciliationType, referenceId, status: 'OPEN' }, transaction });
  if (!open) return;
  open.status = 'RESOLVED';
  open.resolvedAt = new Date();
  await open.save({ transaction });
  await registrarAuditoria(
    {
      groupId, companyId, actorUserId: actorUserId || null,
      action: 'correspondent.fiscal.reconciliation_auto_resolved',
      entityType: 'FiscalReconciliation',
      entityId: open.id,
      reason: `Reconciliação fiscal (${reconciliationType}) encerrada automaticamente: os valores voltaram a bater.`,
    },
    transaction
  );
}

/**
 * openReconciliation — abre a issue. Se já existe uma ABERTA para o mesmo tipo e referência,
 * atualiza os valores em vez de abrir outra (rodar a conferência de novo não duplica issue).
 */
async function openReconciliation(reconciliationType, referenceId, expected, actual, difference, actorUserId, groupId, companyId, transaction) {
  const existing = await FiscalReconciliation.findOne({
    where: { groupId, companyId, reconciliationType, referenceId, status: 'OPEN' },
    transaction,
  });
  if (existing) {
    existing.expectedAmount = expected;
    existing.actualAmount = actual;
    existing.differenceAmount = difference;
    await existing.save({ transaction });
    return existing;
  }

  const reconciliation = await FiscalReconciliation.create(
    {
      groupId, companyId,
      reconciliationType,
      referenceId,
      expectedAmount: expected,
      actualAmount: actual,
      differenceAmount: difference,
      status: 'OPEN',
      detectedAt: new Date(),
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId, companyId, actorUserId: actorUserId || null,
      action: 'correspondent.fiscal.reconciliation_opened',
      entityType: 'FiscalReconciliation',
      entityId: reconciliation.id,
      reason: `Divergência fiscal (${reconciliationType}) detectada: esperado R$ ${expected.toFixed(2)}, real R$ ${actual.toFixed(2)}, diferença R$ ${difference.toFixed(2)}.`,
    },
    transaction
  );

  return reconciliation;
}

async function resolveReconciliation(reconciliationId, reasonText, actorUserId, groupId, companyId, transaction) {
  const reconciliation = await FiscalReconciliation.findOne({ where: { id: reconciliationId, groupId, companyId }, transaction });
  if (!reconciliation) {
    throw AppError.notFound('Reconciliação fiscal não encontrada.', 'FISCAL_RECONCILIATION_NOT_FOUND');
  }
  if (reconciliation.status === 'RESOLVED') {
    throw AppError.conflict('Esta reconciliação já foi resolvida.', 'FISCAL_RECONCILIATION_ALREADY_RESOLVED');
  }
  if (!reasonText || !String(reasonText).trim()) {
    throw AppError.badRequest('Resolver uma reconciliação exige um motivo documentado.', 'FISCAL_RECONCILIATION_REASON_REQUIRED');
  }

  reconciliation.status = 'RESOLVED';
  reconciliation.resolvedAt = new Date();
  await reconciliation.save({ transaction });

  await registrarAuditoria(
    {
      groupId, companyId, actorUserId,
      action: 'correspondent.fiscal.reconciliation_resolved',
      entityType: 'FiscalReconciliation',
      entityId: reconciliation.id,
      reason: `Reconciliação fiscal resolvida: ${reasonText}.`,
    },
    transaction
  );

  return reconciliation;
}

/**
 * runReconciliations — conferência completa sob demanda (Financeiro × NFS-e e DIMOB × contratos).
 * Devolve o que foi conferido e as issues abertas; quando tudo bate, não abre nada.
 */
async function runReconciliations(actorUserId, groupId, companyId, transaction) {
  const result = { checked: { FINANCE_X_NFSE: 0, COMMISSION_X_FISCAL: 0, DIMOB_X_CONTRACTS: 0 }, opened: [] };

  const invoices = await InvoiceRequest.findAll({
    where: { groupId, companyId, status: 'AUTHORIZED', sourceType: 'COMMISSION_ENTITLEMENT' },
    transaction,
  });
  for (const invoice of invoices) {
    // eslint-disable-next-line no-await-in-loop
    const entitlement = await CommissionEntitlement.findOne({ where: { id: invoice.sourceId, groupId, companyId }, transaction });
    if (!entitlement) continue;
    result.checked.FINANCE_X_NFSE += 1;
    const expected = entitlement.status === 'ADJUSTED' ? 0 : Number(entitlement.amount);
    // eslint-disable-next-line no-await-in-loop
    const opened = await reconcile('FINANCE_X_NFSE', invoice.id, expected, Number(invoice.amount), actorUserId, groupId, companyId, transaction);
    if (opened) result.opened.push(opened);
  }

  // Comissões × fiscal: toda comissão recebível precisa de NFS-e do mesmo valor (depois do prazo
  // configurado em Parâmetros); comissão estornada não pode ter nota autorizada de pé.
  const graceDays = await getInvoiceGraceDays(groupId, companyId, actorUserId, transaction);
  const limit = new Date(Date.now() - graceDays * 86400000);
  const entitlements = await CommissionEntitlement.findAll({ where: { groupId, companyId, status: { [Op.in]: ['RECEIVABLE', 'RECEIVED', 'ADJUSTED'] } }, transaction });
  for (const entitlement of entitlements) {
    // eslint-disable-next-line no-await-in-loop
    const related = await InvoiceRequest.findAll({
      where: { groupId, companyId, sourceType: 'COMMISSION_ENTITLEMENT', sourceId: entitlement.id, status: ['REQUESTED', 'SUBMITTED', 'UNKNOWN', 'AUTHORIZED'] },
      transaction,
    });
    const invoiced = related.reduce((sum, i) => sum + Number(i.amount), 0);
    const expected = entitlement.status === 'ADJUSTED' ? 0 : Number(entitlement.amount);
    if (related.length === 0 && (entitlement.status === 'ADJUSTED' || new Date(entitlement.get('created_at') || entitlement.createdAt) > limit)) continue;
    result.checked.COMMISSION_X_FISCAL += 1;
    // eslint-disable-next-line no-await-in-loop
    const opened = await reconcile('COMMISSION_X_FISCAL', entitlement.id, expected, invoiced, actorUserId, groupId, companyId, transaction);
    if (opened) result.opened.push(opened);
  }

  const batches = await DimobBatch.findAll({ where: { groupId, companyId }, order: [['reference_year', 'DESC'], ['version', 'DESC']], transaction });
  const latestByYear = new Map();
  for (const batch of batches) if (!latestByYear.has(batch.referenceYear)) latestByYear.set(batch.referenceYear, batch);
  for (const batch of latestByYear.values()) {
    result.checked.DIMOB_X_CONTRACTS += 1;
    // eslint-disable-next-line no-await-in-loop
    const opened = await reconcileDimobBatch(batch, actorUserId, groupId, companyId, transaction);
    if (opened) result.opened.push(opened);
  }
  return result;
}

/**
 * reconcileDimobBatch — DIMOB × contratos/transações: o total do batch precisa bater com as
 * comissões recebíveis do ano que existem hoje no Financeiro.
 */
async function reconcileDimobBatch(batch, actorUserId, groupId, companyId, transaction) {
  // Total que o ano tem hoje (locações recebidas + comissões recebíveis) contra o total do batch.
  const live = await buildDimobDataset(batch.referenceYear, groupId, companyId, transaction);
  const records = await DimobRecord.findAll({ where: { dimobBatchId: batch.id, groupId, companyId }, transaction });
  const expected = live.reduce((sum, e) => sum + Number(e.amount), 0);
  const actual = records.reduce((sum, r) => sum + Number(r.amount), 0);
  return reconcile('DIMOB_X_CONTRACTS', batch.id, expected, actual, actorUserId, groupId, companyId, transaction);
}

async function listReconciliations(status, groupId, companyId, transaction) {
  const where = { groupId, companyId };
  if (status) where.status = status;
  return FiscalReconciliation.findAll({ where, order: [['detected_at', 'DESC']], transaction });
}

module.exports = { reconcile, openReconciliation, runReconciliations, reconcileDimobBatch, resolveReconciliation, listReconciliations, VALID_TYPES, TYPE_LABEL };
