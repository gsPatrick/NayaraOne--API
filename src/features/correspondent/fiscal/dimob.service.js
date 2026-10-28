'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const { DimobBatch, DimobRecord, Person, Property } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { ensureObligation, completeByDimobBatch } = require('./obligations.service');
const { reconcileDimobBatch } = require('./reconciliation.service');
const { buildDimobDataset, canonicalLine, onlyDigits } = require('./dimobDataset.service');
const { isUuid } = require('./fiscalCommon');
const { getFiscalSettings } = require('../commissionSplit.service');

function hashDataset(dataset) {
  // Serialização estável (a ordem já é determinística pela montagem do dataset).
  // Ordem canônica (não depende da ordem de inserção): o mesmo conjunto gera sempre o mesmo hash.
  const canonical = dataset.map((r) => canonicalLine({ recordType: r.recordType || 'CORRESPONDENT_COMMISSION', ...r })).sort().join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// Modelo do arquivo (colunas, separador, aviso, rótulo do layout) fotografado por versão do lote.
function buildFileModel(fiscal, layoutVersion) {
  return { layout: layoutVersion, columns: [...fiscal.dimobFileColumns], delimiter: fiscal.dimobFileDelimiter, notice: fiscal.dimobFileNotice || '' };
}
function hashFileModel(model) {
  const canonical = JSON.stringify([model.layout, model.columns, model.delimiter, model.notice]);
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

  if (referenceYear > 2100) {
    throw AppError.badRequest('O campo "referenceYear" deve ser um ano válido.', 'DIMOB_VALIDATION');
  }
  // A versão e o conteúdo são gerados sob a mesma trava (a primeira coisa da geração): duas gerações simultâneas
  // esperam uma pela outra. O fechamento usa a mesma trava.
  await DimobBatch.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `dimob:${companyId}:${referenceYear}` }, transaction });

  // Todo ano com batch gerado passa a constar no calendário fiscal.
  await ensureObligation({ obligationType: 'DIMOB_ANNUAL', referenceYear }, actorUserId, groupId, companyId, transaction);
  const dataset = await buildDimobDataset(referenceYear, groupId, companyId, transaction);
  const snapshotHash = hashDataset(dataset);

  // Duas gerações simultâneas do mesmo ano esperam uma pela outra: a versão nunca se repete.
  const previous = await DimobBatch.findOne({
    where: { groupId, companyId, referenceYear },
    order: [['version', 'DESC']],
    transaction,
  });
  const nextVersion = previous ? previous.version + 1 : 1;

  const fiscalNow = await getFiscalSettings(groupId, companyId, actorUserId, transaction);
  const layoutVersion = fiscalNow.dimobLayoutLabel.replace(/\{ano\}/gi, String(referenceYear)).slice(0, 16);
  const fileModel = buildFileModel(fiscalNow, layoutVersion);
  const batch = await DimobBatch.create(
    {
      groupId, companyId,
      referenceYear,
      version: nextVersion,
      // Layout anual versionado (caderno): a versão do layout acompanha o ano-base do batch.
      layoutVersion,
      fileModelJson: fileModel,
      fileModelHash: hashFileModel(fileModel),
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
      reason: `Batch DIMOB ${referenceYear} v${nextVersion} gerado — ${dataset.length} registro(s), hash ${snapshotHash}, modelo do arquivo ${hashFileModel(fileModel)}.`,
    },
    transaction
  );

  return batch;
}

async function closeDimobBatch(dimobBatchId, actorUserId, groupId, companyId, transaction) {
  if (!isUuid(String(dimobBatchId || ''))) {
    throw AppError.badRequest('Identificador de batch inválido.', 'DIMOB_VALIDATION');
  }
  const found = await DimobBatch.findOne({ where: { id: dimobBatchId, groupId, companyId }, transaction });
  if (!found) {
    throw AppError.notFound('Batch DIMOB não encontrado.', 'DIMOB_BATCH_NOT_FOUND');
  }
  // Mesma trava da geração: fechar a v1 enquanto a v2 é gerada espera a geração terminar; fechamento duplo também.
  await DimobBatch.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `dimob:${companyId}:${found.referenceYear}` }, transaction });
  const batch = await DimobBatch.findOne({ where: { id: dimobBatchId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (batch.status === 'CLOSED') {
    throw AppError.conflict('Este batch DIMOB já está fechado — gere uma nova versão para corrigir.', 'DIMOB_BATCH_ALREADY_CLOSED');
  }
  const newer = await DimobBatch.count({ where: { groupId, companyId, referenceYear: batch.referenceYear, version: { [Op.gt]: batch.version } }, transaction });
  if (newer > 0) {
    throw AppError.conflict(
      'Existe uma versão mais nova deste ano. Feche a versão mais recente: a anterior foi substituída.',
      'DIMOB_BATCH_SUPERSEDED'
    );
  }
  // O snapshot precisa continuar batendo com os registros guardados antes de fechar.
  const stored = await DimobRecord.findAll({ where: { dimobBatchId: batch.id, groupId, companyId }, order: [['id', 'ASC']], transaction });
  const recomputed = hashDataset(
    stored.map((r) => ({ recordType: r.recordType, sourceRefs: r.sourceRefs, amount: r.amount, detailJson: r.detailJson }))
  );
  if (recomputed !== batch.snapshotHash) {
    throw AppError.conflict('Os registros deste batch não conferem mais com o hash do snapshot. Gere uma nova versão.', 'DIMOB_BATCH_SNAPSHOT_MISMATCH');
  }
  // Os dados vivos do ano também precisam continuar iguais aos do snapshot: batch defasado não fecha
  // (nem conclui a obrigação); gera-se uma nova versão.
  const liveHash = hashDataset(await buildDimobDataset(batch.referenceYear, groupId, companyId, transaction));
  if (liveHash !== batch.snapshotHash) {
    throw AppError.conflict(
      'Os lançamentos ou cadastros do ano mudaram depois que este batch foi gerado. Gere uma nova versão para refletir os dados de hoje e feche a nova versão.',
      'DIMOB_BATCH_STALE'
    );
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
 * exportDimobFile — arquivo de conferência do batch (CSV com ponto e vírgula, vírgula decimal e BOM UTF-8), com a versão do
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
  // Batch novo: usa a foto gravada na geração. Batch antigo (sem foto): cai para o cadastro de hoje.
  const names = (ids, snapshot) => (snapshot
    ? snapshot.map((p) => p.name || 'Sem nome')
    : (ids || []).map((id) => personById.get(id)?.legalName || 'Sem nome')).join(' / ');
  const docs = (ids, snapshot) => (snapshot
    ? snapshot.map((p) => p.taxId || 'SEM DOCUMENTO')
    : (ids || []).map((id) => onlyDigits(personById.get(id)?.taxIdNormalized) || 'SEM DOCUMENTO')).join(' / ');

  // O arquivo usa SEMPRE o modelo gravado no lote. Lote antigo (sem modelo): congela o modelo vigente agora.
  let model = batch.fileModelJson;
  if (!model) {
    model = buildFileModel(await getFiscalSettings(groupId, companyId, actorUserId, transaction), batch.layoutVersion);
    await DimobBatch.sequelize.query(
      'UPDATE "correspondent"."dimob_batches" SET file_model_json = :json, file_model_hash = :hash WHERE id = :id AND file_model_json IS NULL',
      { replacements: { json: JSON.stringify(model), hash: hashFileModel(model), id: batch.id }, transaction }
    );
    batch.fileModelJson = model;
    batch.fileModelHash = hashFileModel(model);
    await registrarAuditoria(
      {
        groupId, companyId, actorUserId,
        action: 'correspondent.dimob.file_model_frozen',
        entityType: 'DimobBatch',
        entityId: batch.id,
        reason: `Lote DIMOB ${batch.referenceYear} v${batch.version} era anterior ao registro do modelo: o modelo vigente foi congelado na primeira exportação (modelo ${batch.fileModelHash}).`,
      },
      transaction
    );
  }
  const sep = model.delimiter;
  const money = (v) => Number(v).toFixed(2).replace('.', ',');
  // Cada coluna do arquivo sabe tirar o seu valor do registro; a empresa escolhe quais entram e em que ordem.
  const COLUMN_VALUE = {
    tipo: (r) => (r.recordType === 'LEASE' ? 'LOCACAO' : 'COMISSAO'),
    contrato: (r, refs) => cell(r.recordType === 'LEASE' ? (r.detailJson?.contractNumber || refs.contractId) : refs.commissionEntitlementId),
    locador_documento: (r, refs) => (r.recordType === 'LEASE' ? cell(docs(refs.landlordPersonIds, r.detailJson?.landlords)) : ''),
    locador_nome: (r, refs) => (r.recordType === 'LEASE' ? cell(names(refs.landlordPersonIds, r.detailJson?.landlords)) : ''),
    locatario_documento: (r, refs) => (r.recordType === 'LEASE' ? cell(docs(refs.tenantPersonIds, r.detailJson?.tenants)) : ''),
    locatario_nome: (r, refs) => (r.recordType === 'LEASE' ? cell(names(refs.tenantPersonIds, r.detailJson?.tenants)) : ''),
    imovel: (r, refs) => (r.recordType === 'LEASE' ? cell((r.detailJson && 'propertyCode' in r.detailJson ? r.detailJson.propertyCode : propertyById.get(refs.propertyId)?.internalCode) || 'SEM IMOVEL') : ''),
    valor_no_ano: (r) => money(r.amount),
    situacao: (r) => (r.recordType === 'LEASE' ? (r.validationStatus === 'VALID' ? 'OK' : 'PENDENTE') : 'OK'),
    pendencias: (r) => (r.recordType === 'LEASE' ? cell((r.validationIssues || []).map((i) => i.message).join(' | ')) : ''),
  };
  const columns = model.columns;
  const lines = [
    `# layout${sep}${model.layout}${model.notice ? `${sep}${model.notice}` : ''}`,
    `# batch${sep}${batch.id}${sep}ano${sep}${batch.referenceYear}${sep}versao${sep}${batch.version}${sep}status${sep}${batch.status}${sep}hash${sep}${batch.snapshotHash}`,
    `# modelo${sep}${batch.fileModelHash}`,
    columns.join(sep),
  ];
  for (const r of records) {
    const refs = r.sourceRefs || {};
    lines.push(columns.map((c) => COLUMN_VALUE[c](r, refs)).join(sep));
  }

  await registrarAuditoria(
    {
      groupId, companyId, actorUserId,
      action: 'correspondent.dimob.file_exported',
      entityType: 'DimobBatch',
      entityId: batch.id,
      reason: `Arquivo de conferência do DIMOB ${batch.referenceYear} v${batch.version} gerado (${records.length} registro(s), hash ${batch.snapshotHash}, modelo ${batch.fileModelHash}).`,
    },
    transaction
  );
  return {
    // BOM UTF-8 + valor com vírgula decimal: o Excel em português lê acentos e números corretamente.
    content: `\uFEFF${lines.join('\n')}\n`,
    fileName: `dimob-${batch.referenceYear}-v${batch.version}.csv`,
    contentType: 'text/csv; charset=utf-8',
  };
}

async function listDimobBatches(referenceYear, groupId, companyId, transaction) {
  const where = { groupId, companyId };
  if (referenceYear !== null && referenceYear !== undefined) {
    if (!Number.isInteger(referenceYear) || referenceYear < 2000 || referenceYear > 2100) {
      throw AppError.badRequest('O filtro "referenceYear" deve ser um ano válido.', 'DIMOB_VALIDATION');
    }
    where.referenceYear = referenceYear;
  }
  return DimobBatch.findAll({ where, order: [['reference_year', 'DESC'], ['version', 'DESC']], transaction });
}

module.exports = { generateDimobBatch, closeDimobBatch, listDimobBatches, listDimobRecords, exportDimobFile, buildDimobDataset, hashDataset };
