'use strict';

const { Op } = require('sequelize');
const { getInvoiceGraceDays, getFiscalSettings } = require('../commissionSplit.service');
const { isUuid, round2: roundMoney } = require('./fiscalCommon');
const { buildDimobDataset } = require('./dimobDataset.service');
const { sequelize, FiscalReconciliation, InvoiceRequest, CommissionEntitlement, DimobBatch, DimobRecord, FinancialEntry, AccountingReturnImport } = require('../../../models');
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
async function reconcile(reconciliationType, referenceId, expectedAmount, actualAmount, actorUserId, groupId, companyId, transaction, { toleranceReais } = {}) {
  if (!VALID_TYPES.includes(reconciliationType)) {
    throw AppError.badRequest(`Tipo de reconciliação inválido: "${reconciliationType}".`, 'FISCAL_RECONCILIATION_VALIDATION');
  }
  const expected = round2(expectedAmount);
  const actual = round2(actualAmount);
  const difference = round2(expected - actual);

  const tolerance = toleranceReais !== undefined
    ? toleranceReais
    : (await getFiscalSettings(groupId, companyId, actorUserId, transaction)).reconciliationToleranceReais;
  if (Math.abs(difference) <= round2(tolerance || 0)) {
    // Voltou a bater (ou a diferença cabe na tolerância definida em Parâmetros): uma issue aberta para o mesmo item é encerrada sozinha, com auditoria.
    await autoResolveIfOpen(reconciliationType, referenceId, actorUserId, groupId, companyId, transaction);
    return null;
  }

  return openReconciliation(reconciliationType, referenceId, expected, actual, difference, actorUserId, groupId, companyId, transaction);
}

async function autoResolveIfOpen(reconciliationType, referenceId, actorUserId, groupId, companyId, transaction, motivo = 'os valores voltaram a bater') {
  const open = await FiscalReconciliation.findOne({ where: { groupId, companyId, reconciliationType, referenceId, status: 'OPEN' }, transaction });
  if (!open) return;
  open.status = 'RESOLVED';
  open.resolvedAt = new Date();
  open.resolutionKind = 'AUTO';
  open.resolutionNote = `Encerrada automaticamente: ${motivo}.`.slice(0, 1000);
  await open.save({ transaction });
  await registrarAuditoria(
    {
      groupId, companyId, actorUserId: actorUserId || null,
      action: 'correspondent.fiscal.reconciliation_auto_resolved',
      entityType: 'FiscalReconciliation',
      entityId: open.id,
      reason: `Reconciliação fiscal (${reconciliationType}) encerrada automaticamente: ${motivo}.`,
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

  // Diferença que uma pessoa já aceitou (resolução manual com a mesma diferença): não reabre a cada conferência.
  const accepted = await FiscalReconciliation.findOne({
    where: { groupId, companyId, reconciliationType, referenceId, status: 'RESOLVED', resolutionKind: 'MANUAL', acceptedDifference: difference },
    transaction,
  });
  if (accepted) return null;

  let reconciliation;
  try {
    // Savepoint: duas conferências simultâneas não deixam a transação abortada (há uma issue aberta por item).
    reconciliation = await sequelize.transaction({ transaction }, (savepoint) => FiscalReconciliation.create(
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
      { transaction: savepoint }
    ));
  } catch (err) {
    if (err?.name === 'SequelizeUniqueConstraintError') {
      const winner = await FiscalReconciliation.findOne({ where: { groupId, companyId, reconciliationType, referenceId, status: 'OPEN' }, transaction });
      if (winner) return winner;
    }
    throw err;
  }

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
  if (!isUuid(String(reconciliationId || ''))) {
    throw AppError.badRequest('Identificador de reconciliação inválido.', 'FISCAL_RECONCILIATION_VALIDATION');
  }
  const reconciliation = await FiscalReconciliation.findOne({ where: { id: reconciliationId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!reconciliation) {
    throw AppError.notFound('Reconciliação fiscal não encontrada.', 'FISCAL_RECONCILIATION_NOT_FOUND');
  }
  if (reconciliation.status === 'RESOLVED') {
    throw AppError.conflict('Esta reconciliação já foi resolvida.', 'FISCAL_RECONCILIATION_ALREADY_RESOLVED');
  }
  const reason = typeof reasonText === 'string' ? reasonText.trim() : '';
  if (!reason) {
    throw AppError.badRequest('Resolver uma reconciliação exige um motivo documentado.', 'FISCAL_RECONCILIATION_REASON_REQUIRED');
  }
  if (reason.length > 500) {
    throw AppError.badRequest('O motivo da resolução deve ter no máximo 500 caracteres.', 'FISCAL_RECONCILIATION_REASON_REQUIRED');
  }

  reconciliation.status = 'RESOLVED';
  reconciliation.resolvedAt = new Date();
  // A diferença aceita fica guardada: a próxima conferência não abre outra issue para a mesma diferença.
  reconciliation.resolutionKind = 'MANUAL';
  reconciliation.resolutionNote = reason;
  reconciliation.acceptedDifference = reconciliation.differenceAmount;
  await reconciliation.save({ transaction });

  await registrarAuditoria(
    {
      groupId, companyId, actorUserId,
      action: 'correspondent.fiscal.reconciliation_resolved',
      entityType: 'FiscalReconciliation',
      entityId: reconciliation.id,
      reason: `Reconciliação fiscal resolvida (diferença de R$ ${Number(reconciliation.differenceAmount).toFixed(2)} aceita): ${reason}.`,
    },
    transaction
  );

  return reconciliation;
}

const PAGE = 500;

// Percorre uma consulta em páginas (a conferência não carrega a empresa inteira de uma vez).
async function forEachPage(model, where, order, transaction, fn) {
  for (let offset = 0; ; offset += PAGE) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await model.findAll({ where, order, limit: PAGE, offset, transaction });
    if (rows.length === 0) break;
    // eslint-disable-next-line no-await-in-loop
    await fn(rows);
    if (rows.length < PAGE) break;
  }
}

/**
 * runReconciliations — conferência completa sob demanda (Financeiro × NFS-e e DIMOB × contratos).
 * Devolve o que foi conferido e as issues abertas; quando tudo bate, não abre nada. A origem que sumiu
 * (lançamento ou comissão apagados) também abre divergência: o esperado passa a ser zero, nunca fica em silêncio.
 */
async function runReconciliations(actorUserId, groupId, companyId, transaction) {
  const result = { checked: { FINANCE_X_NFSE: 0, COMMISSION_X_FISCAL: 0, DIMOB_X_CONTRACTS: 0 }, opened: [] };
  const settings = await getFiscalSettings(groupId, companyId, actorUserId, transaction);
  const opts = { toleranceReais: settings.reconciliationToleranceReais };

  // Notas de comissão: uma consulta de comissões por página de notas (em vez de uma por nota).
  await forEachPage(InvoiceRequest, { groupId, companyId, status: 'AUTHORIZED', sourceType: 'COMMISSION_ENTITLEMENT' }, [['id', 'ASC']], transaction, async (invoices) => {
    const entitlements = await CommissionEntitlement.findAll({ where: { id: invoices.map((i) => i.sourceId), groupId, companyId }, transaction });
    const entitlementById = new Map(entitlements.map((e) => [e.id, e]));
    for (const invoice of invoices) {
      const entitlement = entitlementById.get(invoice.sourceId);
      result.checked.FINANCE_X_NFSE += 1;
      const expected = !entitlement || entitlement.status === 'ADJUSTED' ? 0 : Number(entitlement.amount);
      // eslint-disable-next-line no-await-in-loop
      const opened = await reconcile('FINANCE_X_NFSE', invoice.id, expected, Number(invoice.amount), actorUserId, groupId, companyId, transaction, opts);
      if (opened) result.opened.push(opened);
    }
  });
  // Notas de lançamento do Financeiro: confere o valor da nota com o do lançamento.
  await forEachPage(InvoiceRequest, { groupId, companyId, status: 'AUTHORIZED', sourceType: 'FINANCIAL_ENTRY' }, [['id', 'ASC']], transaction, async (invoices) => {
    const entries = await FinancialEntry.findAll({ where: { id: invoices.map((i) => i.sourceId), groupId, companyId }, transaction });
    const entryById = new Map(entries.map((e) => [e.id, e]));
    for (const invoice of invoices) {
      const entry = entryById.get(invoice.sourceId);
      result.checked.FINANCE_X_NFSE += 1;
      const expectedEntry = !entry || ['REVERSED', 'CANCELLED'].includes(entry.status) ? 0 : Number(entry.amount);
      // eslint-disable-next-line no-await-in-loop
      const openedEntry = await reconcile('FINANCE_X_NFSE', invoice.id, expectedEntry, Number(invoice.amount), actorUserId, groupId, companyId, transaction, opts);
      if (openedEntry) result.opened.push(openedEntry);
    }
  });

  // Nota que foi cancelada ou recusada depois de abrir divergência: a issue perde o sentido e se
  // encerra sozinha (a nota não está mais de pé).
  await forEachPage(InvoiceRequest, { groupId, companyId, status: ['CANCELED', 'REJECTED'], sourceType: ['COMMISSION_ENTITLEMENT', 'FINANCIAL_ENTRY'] }, [['id', 'ASC']], transaction, async (closed) => {
    for (const invoice of closed) {
      // eslint-disable-next-line no-await-in-loop
      await autoResolveIfOpen('FINANCE_X_NFSE', invoice.id, actorUserId, groupId, companyId, transaction, 'a nota foi cancelada ou recusada');
    }
  });

  // Comissões × fiscal: toda comissão recebível precisa de NFS-e AUTORIZADA do mesmo valor (depois do prazo
  // configurado em Parâmetros); comissão estornada não pode ter nota autorizada de pé. Nota ainda não
  // autorizada (solicitada, enviada ou incerta) não conta como faturada.
  const graceDays = await getInvoiceGraceDays(groupId, companyId, actorUserId, transaction);
  const limit = new Date(Date.now() - graceDays * 86400000);
  await forEachPage(CommissionEntitlement, { groupId, companyId, status: { [Op.in]: ['RECEIVABLE', 'RECEIVED', 'ADJUSTED'] } }, [['id', 'ASC']], transaction, async (entitlements) => {
    const relatedInvoices = await InvoiceRequest.findAll({
      where: { groupId, companyId, sourceType: 'COMMISSION_ENTITLEMENT', sourceId: entitlements.map((e) => e.id), status: 'AUTHORIZED' },
      transaction,
    });
    for (const entitlement of entitlements) {
      const related = relatedInvoices.filter((i) => i.sourceId === entitlement.id);
      const invoiced = roundMoney(related.reduce((sum, i) => sum + Number(i.amount), 0));
      const expected = entitlement.status === 'ADJUSTED' ? 0 : Number(entitlement.amount);
      if (related.length === 0 && entitlement.status === 'ADJUSTED') {
        // Comissão estornada e sem nota de pé: a divergência antiga perde o sentido e se encerra.
        // eslint-disable-next-line no-await-in-loop
        await autoResolveIfOpen('COMMISSION_X_FISCAL', entitlement.id, actorUserId, groupId, companyId, transaction, 'a comissão foi estornada e não há nota de pé');
        continue;
      }
      if (related.length === 0 && new Date(entitlement.confirmedAt || entitlement.get('created_at') || entitlement.createdAt) > limit) continue;
      result.checked.COMMISSION_X_FISCAL += 1;
      // eslint-disable-next-line no-await-in-loop
      const opened = await reconcile('COMMISSION_X_FISCAL', entitlement.id, expected, invoiced, actorUserId, groupId, companyId, transaction, opts);
      if (opened) result.opened.push(opened);
    }
  });

  const batches = await DimobBatch.findAll({ where: { groupId, companyId }, order: [['reference_year', 'DESC'], ['version', 'DESC']], transaction });
  const latestByYear = new Map();
  for (const batch of batches) if (!latestByYear.has(batch.referenceYear)) latestByYear.set(batch.referenceYear, batch);
  // Versão antiga de um batch do mesmo ano: a issue aberta dela perde o sentido (a versão nova é que vale).
  for (const batch of batches) {
    if (latestByYear.get(batch.referenceYear)?.id === batch.id) continue;
    // eslint-disable-next-line no-await-in-loop
    await autoResolveIfOpen('DIMOB_X_CONTRACTS', batch.id, actorUserId, groupId, companyId, transaction, 'substituído por uma versão mais nova do mesmo ano');
  }
  for (const batch of latestByYear.values()) {
    result.checked.DIMOB_X_CONTRACTS += 1;
    // eslint-disable-next-line no-await-in-loop
    const opened = await reconcileDimobBatch(batch, actorUserId, groupId, companyId, transaction, opts);
    if (opened) result.opened.push(opened);
  }
  // Total de issues abertas depois da conferência (as já existentes contam, não só as novas).
  result.openTotal = await FiscalReconciliation.count({ where: { groupId, companyId, status: 'OPEN' }, transaction });
  return result;
}

/**
 * reconcileDimobBatch — DIMOB × contratos/transações: o total do batch precisa bater com as
 * comissões recebíveis do ano que existem hoje no Financeiro.
 */
async function reconcileDimobBatch(batch, actorUserId, groupId, companyId, transaction, options = {}) {
  // Total que o ano tem hoje (locações recebidas + comissões recebíveis) contra o total do batch.
  const live = await buildDimobDataset(batch.referenceYear, groupId, companyId, transaction);
  const records = await DimobRecord.findAll({ where: { dimobBatchId: batch.id, groupId, companyId }, transaction });
  const expected = live.reduce((sum, e) => sum + Number(e.amount), 0);
  const actual = records.reduce((sum, r) => sum + Number(r.amount), 0);
  return reconcile('DIMOB_X_CONTRACTS', batch.id, expected, actual, actorUserId, groupId, companyId, transaction, options);
}

// Descreve, em português, o item que gerou a divergência (a tela mostra qual nota, comissão, batch ou retorno é).
async function describeReferences(rows, groupId, companyId, transaction) {
  const idsOf = (type) => rows.filter((r) => r.reconciliationType === type).map((r) => r.referenceId);
  const byType = {};
  const nfseIds = idsOf('FINANCE_X_NFSE');
  const invoices = nfseIds.length ? await InvoiceRequest.findAll({ where: { id: nfseIds, groupId, companyId }, attributes: ['id', 'sourceType', 'sourceId', 'status', 'description'], transaction }) : [];
  byType.FINANCE_X_NFSE = new Map(invoices.map((i) => [i.id, i]));
  const comIds = idsOf('COMMISSION_X_FISCAL');
  const commissions = comIds.length ? await CommissionEntitlement.findAll({ where: { id: comIds, groupId, companyId }, attributes: ['id', 'financingCaseId', 'providerCode', 'status'], transaction }) : [];
  byType.COMMISSION_X_FISCAL = new Map(commissions.map((c) => [c.id, c]));
  const batchIds = idsOf('DIMOB_X_CONTRACTS');
  const dimob = batchIds.length ? await DimobBatch.findAll({ where: { id: batchIds, groupId, companyId }, attributes: ['id', 'referenceYear', 'version'], transaction }) : [];
  byType.DIMOB_X_CONTRACTS = new Map(dimob.map((d) => [d.id, d]));
  const retIds = idsOf('ACCOUNTING_RETURN_X_EXPORT');
  const returns = retIds.length ? await AccountingReturnImport.findAll({ where: { id: retIds, groupId, companyId }, attributes: ['id', 'batchId', 'referencePeriod', 'fileName', 'summaryJson'], transaction }) : [];
  byType.ACCOUNTING_RETURN_X_EXPORT = new Map(returns.map((r) => [r.id, r]));
  const STATUS = { REQUESTED: 'solicitada', SUBMITTED: 'enviada ao emissor', UNKNOWN: 'em verificação', AUTHORIZED: 'autorizada', REJECTED: 'recusada', CANCELED: 'cancelada' };
  const SRC = { COMMISSION_ENTITLEMENT: 'da comissão', FINANCIAL_ENTRY: 'do lançamento do Financeiro', SERVICE_ORDER: 'da ordem de serviço' };
  return new Map(rows.map((r) => {
    const ref = byType[r.reconciliationType]?.get(r.referenceId);
    let info;
    if (!ref) {
      info = { kind: r.reconciliationType, label: 'O item que gerou esta divergência não existe mais.', found: false };
    } else if (r.reconciliationType === 'FINANCE_X_NFSE') {
      info = { kind: 'NFSE', found: true, invoiceRequestId: ref.id, sourceType: ref.sourceType, sourceId: ref.sourceId, label: `NFS-e ${STATUS[ref.status] || ref.status} ${SRC[ref.sourceType] || 'da origem'} ${ref.sourceId}` };
    } else if (r.reconciliationType === 'COMMISSION_X_FISCAL') {
      info = { kind: 'COMMISSION', found: true, commissionId: ref.id, financingCaseId: ref.financingCaseId, label: `Comissão ${ref.id} do caso ${ref.financingCaseId}` };
    } else if (r.reconciliationType === 'DIMOB_X_CONTRACTS') {
      info = { kind: 'DIMOB', found: true, dimobBatchId: ref.id, label: `DIMOB ${ref.referenceYear}, versão ${ref.version}` };
    } else {
      info = {
        kind: 'ACCOUNTING_RETURN', found: true, returnImportId: ref.id, exportBatchId: ref.batchId,
        label: `Retorno do contador${ref.fileName ? ` (${ref.fileName})` : ''} do período ${ref.referencePeriod}`,
        divergences: Array.isArray(ref.summaryJson?.divergences) ? ref.summaryJson.divergences : [],
      };
    }
    return [r.id, info];
  }));
}

async function listReconciliations(status, groupId, companyId, transaction, { limit } = {}) {
  const where = { groupId, companyId };
  if (status) {
    if (!['OPEN', 'RESOLVED'].includes(status)) {
      throw AppError.badRequest('O filtro "status" deve ser OPEN ou RESOLVED.', 'FISCAL_RECONCILIATION_VALIDATION');
    }
    where.status = status;
  }
  const rows = await FiscalReconciliation.findAll({ where, order: [['detected_at', 'DESC'], ['id', 'ASC']], limit: Math.min(Math.max(Number.parseInt(limit, 10) || 300, 1), 500), transaction });
  const info = await describeReferences(rows, groupId, companyId, transaction);
  return rows.map((row) => ({ ...row.toJSON(), typeLabel: TYPE_LABEL[row.reconciliationType] || row.reconciliationType, referenceInfo: info.get(row.id) }));
}

module.exports = { autoResolveIfOpen, reconcile, openReconciliation, runReconciliations, reconcileDimobBatch, resolveReconciliation, listReconciliations, VALID_TYPES, TYPE_LABEL };
