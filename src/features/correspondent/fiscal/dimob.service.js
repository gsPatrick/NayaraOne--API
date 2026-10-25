'use strict';

const crypto = require('crypto');
const { DimobBatch, DimobRecord, Person, Property } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { ensureObligation, completeByDimobBatch } = require('./obligations.service');
const { reconcileDimobBatch } = require('./reconciliation.service');
const { buildDimobDataset, canonicalLine, onlyDigits } = require('./dimobDataset.service');

function hashDataset(dataset) {
  // Serialização estável (a ordem já é determinística pela montagem do dataset).
  const canonical = dataset.map((r) => canonicalLine({ recordType: r.recordType || 'CORRESPONDENT_COMMISSION', ...r })).join('|');
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

  // Todo ano com batch gerado passa a constar no calendário fiscal.
  await ensureObligation({ obligationType: 'DIMOB_ANNUAL', referenceYear }, actorUserId, groupId, companyId, transaction);

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
        recordType: record.recordType,
        validationStatus: record.validationStatus,
        validationIssues: record.validationIssues,
        detailJson: record.detailJson,
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
  const invalid = await DimobRecord.count({ where: { dimobBatchId: batch.id, groupId, companyId, validationStatus: 'INVALID' }, transaction });
  if (invalid > 0) {
    throw AppError.unprocessable(
      `Este batch tem ${invalid} registro(s) com pendência de cadastro. Corrija os cadastros indicados e gere uma nova versão antes de fechar.`,
      'DIMOB_BATCH_HAS_INVALID_RECORDS'
    );
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

  // Fechar o batch conclui a obrigação do ano e confere o total contra as comissões do Financeiro.
  await completeByDimobBatch(batch, actorUserId, groupId, companyId, transaction);
  await reconcileDimobBatch(batch, actorUserId, groupId, companyId, transaction);

  return batch;
}

async function listDimobRecords(dimobBatchId, groupId, companyId, transaction) {
  const batch = await DimobBatch.findOne({ where: { id: dimobBatchId, groupId, companyId }, transaction });
  if (!batch) {
    throw AppError.notFound('Batch DIMOB não encontrado.', 'DIMOB_BATCH_NOT_FOUND');
  }
  const records = await DimobRecord.findAll({ where: { dimobBatchId, groupId, companyId }, order: [['id', 'ASC']], transaction });
  return { batch, records };
}

/**
 * exportDimobFile — arquivo de conferência do batch (CSV com ponto e vírgula), com a versão do
 * layout e o hash do snapshot. É o formato interno para o contador conferir; o arquivo oficial da
 * Receita depende do layout vigente validado por ele (o caderno condiciona a produção a isso).
 */
async function exportDimobFile(dimobBatchId, actorUserId, groupId, companyId, transaction) {
  const { batch, records } = await listDimobRecords(dimobBatchId, groupId, companyId, transaction);
  const personIds = new Set();
  const propertyIds = new Set();
  for (const r of records) {
    (r.sourceRefs.landlordPersonIds || []).forEach((id) => personIds.add(id));
    (r.sourceRefs.tenantPersonIds || []).forEach((id) => personIds.add(id));
    if (r.sourceRefs.propertyId) propertyIds.add(r.sourceRefs.propertyId);
  }
  const people = personIds.size ? await Person.findAll({ where: { groupId, companyId, id: [...personIds] }, attributes: ['id', 'legalName', 'taxIdNormalized'], transaction }) : [];
  const properties = propertyIds.size ? await Property.findAll({ where: { groupId, companyId, id: [...propertyIds] }, attributes: ['id', 'internalCode'], transaction }) : [];
  const personById = new Map(people.map((p) => [p.id, p]));
  const propertyById = new Map(properties.map((p) => [p.id, p]));

  // Célula que começa com =, +, - ou @ vira fórmula na planilha: neutraliza com apóstrofo.
  const cell = (value) => {
    const text = String(value ?? '');
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const names = (ids) => (ids || []).map((id) => personById.get(id)?.legalName || 'Sem nome').join(' / ');
  const docs = (ids) => (ids || []).map((id) => onlyDigits(personById.get(id)?.taxIdNormalized) || 'SEM DOCUMENTO').join(' / ');

  const lines = [
    `# layout;${batch.layoutVersion};formato interno de conferência, não é o arquivo oficial da Receita`,
    `# batch;${batch.id};ano;${batch.referenceYear};versao;${batch.version};status;${batch.status};hash;${batch.snapshotHash}`,
    'tipo;contrato;locador_documento;locador_nome;locatario_documento;locatario_nome;imovel;valor_no_ano;situacao;pendencias',
  ];
  for (const r of records) {
    const refs = r.sourceRefs || {};
    if (r.recordType === 'LEASE') {
      lines.push([
        'LOCACAO',
        cell(r.detailJson?.contractNumber || refs.contractId),
        cell(docs(refs.landlordPersonIds)),
        cell(names(refs.landlordPersonIds)),
        cell(docs(refs.tenantPersonIds)),
        cell(names(refs.tenantPersonIds)),
        cell(propertyById.get(refs.propertyId)?.internalCode || 'SEM IMOVEL'),
        Number(r.amount).toFixed(2),
        r.validationStatus === 'VALID' ? 'OK' : 'PENDENTE',
        cell((r.validationIssues || []).map((i) => i.message).join(' | ')),
      ].join(';'));
    } else {
      lines.push(['COMISSAO', cell(refs.commissionEntitlementId), '', '', '', '', '', Number(r.amount).toFixed(2), 'OK', ''].join(';'));
    }
  }

  await registrarAuditoria(
    {
      groupId, companyId, actorUserId,
      action: 'correspondent.dimob.file_exported',
      entityType: 'DimobBatch',
      entityId: batch.id,
      reason: `Arquivo de conferência do DIMOB ${batch.referenceYear} v${batch.version} gerado (${records.length} registro(s), hash ${batch.snapshotHash}).`,
    },
    transaction
  );
  return {
    content: `${lines.join('\n')}\n`,
    fileName: `dimob-${batch.referenceYear}-v${batch.version}.csv`,
    contentType: 'text/csv; charset=utf-8',
  };
}

async function listDimobBatches(referenceYear, groupId, companyId, transaction) {
  const where = { groupId, companyId };
  if (referenceYear) where.referenceYear = referenceYear;
  return DimobBatch.findAll({ where, order: [['reference_year', 'DESC'], ['version', 'DESC']], transaction });
}

module.exports = { generateDimobBatch, closeDimobBatch, listDimobBatches, listDimobRecords, exportDimobFile, buildDimobDataset, hashDataset };
