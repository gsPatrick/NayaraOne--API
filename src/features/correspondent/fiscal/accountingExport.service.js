'use strict';

const crypto = require('crypto');
const { AccountingExportBatch, AccountingExportLine } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');

function hashLines(lines) {
  const canonical = lines.map((l) => `${l.sourceType}:${l.sourceId}:${Number(l.amount).toFixed(2)}`).join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * createExportBatch — "export/import contábil sempre por batch com hash" (citação literal do
 * Caderno). `lines` é a lista de lançamentos a exportar nesse período — cada linha referencia a
 * origem (`sourceType`/`sourceId`), nunca copia o dado pra um formato paralelo sem rastreio.
 */
async function createExportBatch(referencePeriod, lines, actorUserId, groupId, companyId, transaction) {
  if (!/^\d{4}-\d{2}$/.test(String(referencePeriod || ''))) {
    throw AppError.badRequest('O campo "referencePeriod" deve estar no formato AAAA-MM.', 'ACCOUNTING_EXPORT_VALIDATION');
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    throw AppError.badRequest('O batch precisa de ao menos uma linha.', 'ACCOUNTING_EXPORT_VALIDATION');
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

module.exports = { createExportBatch, adjustExportLine, listExportBatches, hashLines };
