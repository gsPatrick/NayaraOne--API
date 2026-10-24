'use strict';

const crypto = require('crypto');
const { DimobBatch, DimobRecord, CommissionEntitlement } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');

/**
 * buildDimobDataset — fonte real dos registros DIMOB: comissões de correspondente já RECEBÍVEIS
 * (status RECEIVABLE/RECEIVED/ADJUSTED) no ano de referência. Nunca copia dado de outra tabela
 * pro DIMOB — cada registro só guarda `sourceRefs` (referência rastreável ao
 * `commissionEntitlementId`/`financingCaseId`), citação literal do Caderno: "dataset com source
 * refs".
 *
 * Determinístico por construção (mesma entrada → mesma serialização → mesmo hash): ordenado por
 * id (chave estável, nunca por created_at, que teria resolução de milissegundo variável entre
 * execuções de teste).
 */
async function buildDimobDataset(referenceYear, groupId, companyId, transaction) {
  const { Op } = require('sequelize');
  const start = new Date(Date.UTC(referenceYear, 0, 1));
  const end = new Date(Date.UTC(referenceYear + 1, 0, 1));

  const entitlements = await CommissionEntitlement.findAll({
    where: {
      groupId,
      companyId,
      // ADJUSTED (chargeback/estorno) fica de fora de propósito: é receita revertida, nunca
      // deveria contar como renda recebida no DIMOB.
      status: { [Op.in]: ['RECEIVABLE', 'RECEIVED'] },
      // ATENÇÃO (PADRAO_COMPONENTES_E_REGRAS.md, achado real Fase 11): o model
      // CommissionEntitlement define `createdAt: 'created_at'` como OVERRIDE DE NOME do próprio
      // atributo Sequelize (não só da coluna) — a chave do where precisa ser 'created_at', nunca
      // 'createdAt', senão o Postgres recebe um identificador cru que não existe.
      created_at: { [Op.gte]: start, [Op.lt]: end },
    },
    order: [['id', 'ASC']],
    transaction,
  });

  return entitlements.map((e) => ({
    sourceRefs: { commissionEntitlementId: e.id, financingCaseId: e.financingCaseId },
    amount: Number(e.amount),
  }));
}

function hashDataset(dataset) {
  // Serialização estável (ordem de registros já é determinística pela query; stringify de objeto
  // plano com chaves fixas também é estável, sem depender de ordem de inserção de propriedade).
  const canonical = dataset.map((r) => `${r.sourceRefs.commissionEntitlementId}:${r.sourceRefs.financingCaseId}:${r.amount.toFixed(2)}`).join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * generateDimobBatch — gera uma NOVA versão do batch anual (nunca sobrescreve uma já fechada —
 * "layout anual versionado, correção por nova versão", citação literal do Caderno). Reproduzível:
 * chamar de novo com o mesmo dataset de entrada produz o MESMO `snapshotHash`.
 */
async function generateDimobBatch(referenceYear, actorUserId, groupId, companyId, transaction) {
  if (!Number.isInteger(referenceYear) || referenceYear < 2000) {
    throw AppError.badRequest('O campo "referenceYear" deve ser um ano válido.', 'DIMOB_VALIDATION');
  }

  const dataset = await buildDimobDataset(referenceYear, groupId, companyId, transaction);
  const snapshotHash = hashDataset(dataset);

  const previous = await DimobBatch.findOne({
    where: { groupId, companyId, referenceYear },
    order: [['version', 'DESC']],
    transaction,
  });
  const nextVersion = previous ? previous.version + 1 : 1;

  const batch = await DimobBatch.create(
    {
      groupId, companyId,
      referenceYear,
      version: nextVersion,
      status: 'DRAFT',
      snapshotHash,
      createdBy: actorUserId || null,
    },
    { transaction }
  );

  for (const record of dataset) {
    // eslint-disable-next-line no-await-in-loop
    await DimobRecord.create(
      {
        groupId, companyId,
        dimobBatchId: batch.id,
        sourceRefs: record.sourceRefs,
        amount: record.amount,
      },
      { transaction }
    );
  }

  await registrarAuditoria(
    {
      groupId, companyId, actorUserId,
      action: 'correspondent.dimob.batch_generated',
      entityType: 'DimobBatch',
      entityId: batch.id,
      reason: `Batch DIMOB ${referenceYear} v${nextVersion} gerado — ${dataset.length} registro(s), hash ${snapshotHash}.`,
    },
    transaction
  );

  return batch;
}

async function closeDimobBatch(dimobBatchId, actorUserId, groupId, companyId, transaction) {
  const batch = await DimobBatch.findOne({ where: { id: dimobBatchId, groupId, companyId }, transaction });
  if (!batch) {
    throw AppError.notFound('Batch DIMOB não encontrado.', 'DIMOB_BATCH_NOT_FOUND');
  }
  if (batch.status === 'CLOSED') {
    throw AppError.conflict('Este batch DIMOB já está fechado — gere uma nova versão para corrigir.', 'DIMOB_BATCH_ALREADY_CLOSED');
  }
  batch.status = 'CLOSED';
  await batch.save({ transaction });

  await registrarAuditoria(
    {
      groupId, companyId, actorUserId,
      action: 'correspondent.dimob.batch_closed',
      entityType: 'DimobBatch',
      entityId: batch.id,
      reason: `Batch DIMOB ${batch.referenceYear} v${batch.version} fechado — nunca mais editável, correções futuras exigem nova versão.`,
    },
    transaction
  );

  return batch;
}

async function listDimobBatches(referenceYear, groupId, companyId, transaction) {
  const where = { groupId, companyId };
  if (referenceYear) where.referenceYear = referenceYear;
  return DimobBatch.findAll({ where, order: [['reference_year', 'DESC'], ['version', 'DESC']], transaction });
}

module.exports = { generateDimobBatch, closeDimobBatch, listDimobBatches, buildDimobDataset, hashDataset };
