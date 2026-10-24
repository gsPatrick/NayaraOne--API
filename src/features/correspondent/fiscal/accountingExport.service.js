'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const { AccountingExportBatch, AccountingExportLine, AccountingReturnImport, CommissionEntitlement, InvoiceRequest } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { openReconciliation } = require('./reconciliation.service');

function hashLines(lines) {
  const canonical = lines.map((l) => `${l.sourceType}:${l.sourceId}:${Number(l.amount).toFixed(2)}`).join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * createExportBatch — "export/import contábil sempre por batch com hash" (citação literal do
 * Caderno). `lines` é a lista de lançamentos a exportar nesse período — cada linha referencia a
 * origem (`sourceType`/`sourceId`), nunca copia o dado pra um formato paralelo sem rastreio.
 *
 * Achado real (auditoria pós-DoD, Frente Financeiro/CRM, ciclo 3): nada impedia a MESMA origem
 * (sourceType+sourceId) de entrar em dois batches diferentes — duplicaria o mesmo fato contábil
 * na exportação. Agora rejeita, antes de criar qualquer coisa, se alguma linha da entrada já foi
 * exportada como linha ORIGINAL (não-ajuste) em qualquer batch anterior desta empresa. Corrigir um
 * valor já exportado é sempre via `adjustExportLine` (linha nova, nunca duplicação de origem).
 */
async function createExportBatch(referencePeriod, linesInput, actorUserId, groupId, companyId, transaction) {
  if (!/^\d{4}-\d{2}$/.test(String(referencePeriod || ''))) {
    throw AppError.badRequest('O campo "referencePeriod" deve estar no formato AAAA-MM.', 'ACCOUNTING_EXPORT_VALIDATION');
  }
  // Sem linhas informadas, o batch leva tudo que está pendente de exportação no período.
  const lines = Array.isArray(linesInput) && linesInput.length ? linesInput : await listExportCandidates(referencePeriod, groupId, companyId, transaction);
  if (!Array.isArray(lines) || lines.length === 0) {
    throw AppError.badRequest('Não há lançamentos pendentes de exportação neste período. Informe as linhas manualmente ou escolha outro mês.', 'ACCOUNTING_EXPORT_VALIDATION');
  }

  const duplicate = await AccountingExportLine.findOne({
    where: {
      groupId,
      companyId,
      adjustmentOfLineId: null,
      [Op.or]: lines.map((l) => ({ sourceType: l.sourceType, sourceId: String(l.sourceId) })),
    },
    transaction,
  });
  if (duplicate) {
    throw AppError.conflict(
      `A origem "${duplicate.sourceType}:${duplicate.sourceId}" já foi exportada no batch ${duplicate.batchId}. Para corrigir um valor já exportado, use o ajuste (adjustExportLine) em vez de exportar de novo.`,
      'ACCOUNTING_EXPORT_DUPLICATE_SOURCE'
    );
  }

  const batchHash = hashLines(lines);
  const batch = await AccountingExportBatch.create(
    { groupId, companyId, referencePeriod, batchHash, status: 'EXPORTED', createdBy: actorUserId || null },
    { transaction }
  );

  for (const line of lines) {
    // eslint-disable-next-line no-await-in-loop
    await AccountingExportLine.create(
      {
        groupId, companyId,
        batchId: batch.id,
        sourceType: line.sourceType,
        sourceId: line.sourceId,
        amount: line.amount,
        description: line.description,
      },
      { transaction }
    );
  }

  await registrarAuditoria(
    {
      groupId, companyId, actorUserId,
      action: 'correspondent.accounting_export.batch_created',
      entityType: 'AccountingExportBatch',
      entityId: batch.id,
      reason: `Batch de export contábil ${referencePeriod} criado — ${lines.length} linha(s), hash ${batchHash}.`,
    },
    transaction
  );

  return batch;
}

/**
 * listExportCandidates — lançamentos do período ainda NÃO exportados: comissões recebíveis/recebidas
 * (COMMISSION_ENTITLEMENT) e NFS-e autorizadas (NFSE). Cada linha referencia a origem real.
 */
async function listExportCandidates(referencePeriod, groupId, companyId, transaction) {
  if (!/^\d{4}-\d{2}$/.test(String(referencePeriod || ''))) {
    throw AppError.badRequest('O campo "referencePeriod" deve estar no formato AAAA-MM.', 'ACCOUNTING_EXPORT_VALIDATION');
  }
  const [year, month] = referencePeriod.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));

  const entitlements = await CommissionEntitlement.findAll({
    where: { groupId, companyId, status: { [Op.in]: ['RECEIVABLE', 'RECEIVED'] }, created_at: { [Op.gte]: start, [Op.lt]: end } },
    order: [['id', 'ASC']],
    transaction,
  });
  const invoices = await InvoiceRequest.findAll({
    where: { groupId, companyId, status: 'AUTHORIZED', created_at: { [Op.gte]: start, [Op.lt]: end } },
    order: [['id', 'ASC']],
    transaction,
  });

  const candidates = [
    ...entitlements.map((e) => ({
      sourceType: 'COMMISSION_ENTITLEMENT',
      sourceId: e.id,
      amount: Number(e.amount),
      description: `Comissão de correspondente bancário, provider ${e.providerCode}, fato gerador ${e.triggerEvent}`,
    })),
    ...invoices.map((i) => ({
      sourceType: 'NFSE',
      sourceId: i.id,
      amount: Number(i.amount),
      description: `NFS-e — ${i.description}`,
    })),
  ];
  if (candidates.length === 0) return [];

  const exported = await AccountingExportLine.findAll({
    where: {
      groupId, companyId, adjustmentOfLineId: null,
      [Op.or]: candidates.map((c) => ({ sourceType: c.sourceType, sourceId: c.sourceId })),
    },
    attributes: ['sourceType', 'sourceId'],
    transaction,
  });
  const done = new Set(exported.map((l) => `${l.sourceType}:${l.sourceId}`));
  return candidates.filter((c) => !done.has(`${c.sourceType}:${c.sourceId}`));
}

async function getExportBatch(batchId, groupId, companyId, transaction) {
  const batch = await AccountingExportBatch.findOne({ where: { id: batchId, groupId, companyId }, transaction });
  if (!batch) {
    throw AppError.notFound('Batch de exportação contábil não encontrado.', 'ACCOUNTING_EXPORT_BATCH_NOT_FOUND');
  }
  const lines = await AccountingExportLine.findAll({ where: { batchId, groupId, companyId }, order: [['created_at', 'ASC'], ['id', 'ASC']], transaction });
  const returns = await AccountingReturnImport.findAll({ where: { batchId, groupId, companyId }, order: [['imported_at', 'DESC']], transaction });
  return { batch, lines, returns };
}

/**
 * importAccountingReturn — retorno do contador. O arquivo devolvido precisa trazer o hash do batch
 * exportado (prova de que é resposta DAQUELE batch). Hash diferente = importação recusada. Hash
 * certo mas valores diferentes = importação registrada como DIVERGENT e issue aberta na reconciliação.
 */
async function importAccountingReturn(batchId, payload, actorUserId, groupId, companyId, transaction) {
  const batch = await AccountingExportBatch.findOne({ where: { id: batchId, groupId, companyId }, transaction });
  if (!batch) {
    throw AppError.notFound('Batch de exportação contábil não encontrado.', 'ACCOUNTING_EXPORT_BATCH_NOT_FOUND');
  }
  const returnedBatchHash = payload?.batchHash ? String(payload.batchHash).trim().toLowerCase() : '';
  if (!returnedBatchHash) {
    throw AppError.badRequest('Informe o hash do batch que consta no arquivo devolvido pelo contador.', 'ACCOUNTING_RETURN_VALIDATION');
  }
  if (returnedBatchHash !== String(batch.batchHash).toLowerCase()) {
    await registrarAuditoria(
      {
        groupId, companyId, actorUserId,
        action: 'correspondent.accounting_return.rejected',
        entityType: 'AccountingExportBatch',
        entityId: batch.id,
        reason: 'Retorno do contador recusado: o hash informado não confere com o do batch exportado.',
      },
      transaction
    );
    throw AppError.unprocessable(
      'O hash do arquivo devolvido não confere com o do batch exportado. Confira se o retorno é deste batch.',
      'ACCOUNTING_RETURN_HASH_MISMATCH'
    );
  }
  const returnedLines = payload?.lines;
  if (!Array.isArray(returnedLines) || returnedLines.length === 0) {
    throw AppError.badRequest('O retorno precisa de ao menos uma linha.', 'ACCOUNTING_RETURN_VALIDATION');
  }
  for (const line of returnedLines) {
    if (!line?.sourceType || !line?.sourceId || !Number.isFinite(Number(line.amount))) {
      throw AppError.badRequest('Cada linha do retorno precisa de sourceType, sourceId e amount numérico.', 'ACCOUNTING_RETURN_VALIDATION');
    }
  }

  const exportedLines = await AccountingExportLine.findAll({ where: { batchId, groupId, companyId }, transaction });
  const net = (list) => {
    const map = new Map();
    for (const l of list) {
      const key = `${l.sourceType}:${l.sourceId}`;
      map.set(key, Math.round(((map.get(key) || 0) + Number(l.amount)) * 100) / 100);
    }
    return map;
  };
  const expectedNet = net(exportedLines);
  const returnedNet = net(returnedLines);
  const divergences = [];
  for (const key of new Set([...expectedNet.keys(), ...returnedNet.keys()])) {
    const expected = expectedNet.get(key) ?? 0;
    const returned = returnedNet.get(key) ?? 0;
    if (Math.round((expected - returned) * 100) !== 0) {
      divergences.push({ source: key, expected, returned, difference: Math.round((expected - returned) * 100) / 100 });
    }
  }
  const sum = (map) => Math.round([...map.values()].reduce((a, b) => a + b, 0) * 100) / 100;
  const expectedTotal = sum(expectedNet);
  const returnedTotal = sum(returnedNet);
  const status = divergences.length ? 'DIVERGENT' : 'MATCHED';

  const record = await AccountingReturnImport.create(
    {
      groupId, companyId,
      batchId: batch.id,
      referencePeriod: batch.referencePeriod,
      fileName: payload?.fileName ? String(payload.fileName).slice(0, 255) : null,
      expectedHash: batch.batchHash,
      returnedHash: hashLines(returnedLines),
      status,
      lineCount: returnedLines.length,
      expectedTotal,
      returnedTotal,
      summaryJson: { divergences },
      importedBy: actorUserId || null,
      importedAt: new Date(),
    },
    { transaction }
  );

  if (divergences.length) {
    const absDiff = Math.round(divergences.reduce((a, d) => a + Math.abs(d.difference), 0) * 100) / 100;
    await openReconciliation('ACCOUNTING_RETURN_X_EXPORT', record.id, expectedTotal, returnedTotal, absDiff, actorUserId, groupId, companyId, transaction);
  }

  await registrarAuditoria(
    {
      groupId, companyId, actorUserId,
      action: 'correspondent.accounting_return.imported',
      entityType: 'AccountingExportBatch',
      entityId: batch.id,
      reason: `Retorno do contador importado para o batch ${batch.referencePeriod}: ${returnedLines.length} linha(s), ${divergences.length} divergência(s).`,
    },
    transaction
  );
  return record;
}

/**
 * adjustExportLine — "ajustes auditados, nunca edição direta de linha já exportada" (citação
 * literal do Caderno). Cria uma linha NOVA no MESMO batch, referenciando a original via
 * `adjustmentOfLineId` — a linha original nunca é alterada.
 */
async function adjustExportLine(originalLineId, deltaAmount, reasonText, actorUserId, groupId, companyId, transaction) {
  const original = await AccountingExportLine.findOne({ where: { id: originalLineId, groupId, companyId }, transaction });
  if (!original) {
    throw AppError.notFound('Linha de export contábil não encontrada.', 'ACCOUNTING_EXPORT_LINE_NOT_FOUND');
  }
  if (!reasonText || !String(reasonText).trim()) {
    throw AppError.badRequest('Ajustar uma linha exportada exige um motivo documentado.', 'ACCOUNTING_EXPORT_ADJUST_REASON_REQUIRED');
  }
  const delta = Number(deltaAmount);
  if (!Number.isFinite(delta) || delta === 0) {
    throw AppError.badRequest('O campo "deltaAmount" deve ser um número diferente de zero.', 'ACCOUNTING_EXPORT_VALIDATION');
  }

  const adjustment = await AccountingExportLine.create(
    {
      groupId, companyId,
      batchId: original.batchId,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      amount: delta,
      description: `Ajuste (${reasonText}) referente à linha ${original.id}.`,
      adjustmentOfLineId: original.id,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId, companyId, actorUserId,
      action: 'correspondent.accounting_export.line_adjusted',
      entityType: 'AccountingExportLine',
      entityId: original.id,
      reason: `Ajuste de R$ ${delta.toFixed(2)} criado sobre a linha ${original.id} (nunca editada diretamente): ${reasonText}.`,
    },
    transaction
  );

  return adjustment;
}

async function listExportBatches(groupId, companyId, transaction) {
  return AccountingExportBatch.findAll({ where: { groupId, companyId }, order: [['created_at', 'DESC']], transaction });
}

module.exports = { createExportBatch, adjustExportLine, listExportBatches, listExportCandidates, getExportBatch, importAccountingReturn, hashLines };
