'use strict';

const crypto = require('crypto');
const { Op, literal } = require('sequelize');
const { sequelize } = require('../../../models');
const { AccountingExportBatch, AccountingExportLine, AccountingReturnImport, CommissionEntitlement, InvoiceRequest, TaxDocument, FinancialEntry } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { openReconciliation, autoResolveIfOpen } = require('./reconciliation.service');
const { TRIGGER_EVENT_LABEL, getFiscalSettings } = require('../commissionSplit.service');
const { isUuid, parseMoney, parsePeriod, brasiliaDate } = require('./fiscalCommon');
const { providerLabel } = require('../correspondentCatalog');

function hashLines(lines) {
  // Ordem canônica: o mesmo conjunto de linhas gera sempre o mesmo hash, na ordem em que vier.
  // Valor a 2 casas e identificador em minúsculas: é o que fica gravado no banco, então o hash recalculado sempre bate.
  const canonical = lines.map((l) => `${l.sourceType}:${String(l.sourceId).toLowerCase()}:${Number(l.amount).toFixed(2)}`).sort().join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

const EXPORT_SOURCE_TYPES = ['COMMISSION_ENTITLEMENT', 'NFSE', 'FINANCIAL_ENTRY'];
const SOURCE_TYPE_LABEL = { COMMISSION_ENTITLEMENT: 'comissão', NFSE: 'NFS-e', FINANCIAL_ENTRY: 'lançamento do Financeiro' };
const MAX_LINES = 5000;

// Último mês aceito: o corrente (o maior entre o de Brasília e o UTC, para não quebrar na virada do mês).
function assertPeriodNotFuture(period, code) {
  const currentBrasilia = brasiliaDate().slice(0, 7);
  const currentUtc = new Date().toISOString().slice(0, 7);
  const limit = currentBrasilia > currentUtc ? currentBrasilia : currentUtc;
  if (period > limit) {
    throw AppError.badRequest('O período da exportação não pode ser um mês que ainda não começou.', code);
  }
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
  const { period } = parsePeriod(referencePeriod, 'ACCOUNTING_EXPORT_VALIDATION');
  assertPeriodNotFuture(period, 'ACCOUNTING_EXPORT_VALIDATION');
  // Sem linhas informadas, o batch leva tudo que está pendente de exportação no período.
  const given = Array.isArray(linesInput) && linesInput.length ? linesInput : null;
  if (given && given.length > MAX_LINES) {
    throw AppError.badRequest(`Um batch aceita no máximo ${MAX_LINES} linhas.`, 'ACCOUNTING_EXPORT_VALIDATION');
  }
  const rawLines = given || await listExportCandidates(period, groupId, companyId, transaction);
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw AppError.badRequest('Não há lançamentos pendentes de exportação neste período. Informe as linhas manualmente ou escolha outro mês.', 'ACCOUNTING_EXPORT_VALIDATION');
  }
  const { accountingExportSourceMode: mode } = await getFiscalSettings(groupId, companyId, actorUserId, transaction);

  // 1) Formato: tipo aceito, identificador no formato de UUID (minúsculas), valor numérico a 2 casas e diferente de zero.
  const lines = [];
  const seen = new Set();
  for (const l of rawLines) {
    if (!l || typeof l !== 'object' || !l.sourceType || !l.sourceId) {
      throw AppError.badRequest('Cada linha da exportação precisa de "sourceType" e "sourceId".', 'ACCOUNTING_EXPORT_VALIDATION');
    }
    if (!EXPORT_SOURCE_TYPES.includes(l.sourceType)) {
      throw AppError.badRequest('O tipo de origem da linha de exportação não é aceito. Use COMMISSION_ENTITLEMENT (comissão), NFSE (nota) ou FINANCIAL_ENTRY (lançamento do Financeiro).', 'ACCOUNTING_EXPORT_VALIDATION');
    }
    if (!isUuid(String(l.sourceId))) {
      throw AppError.badRequest('Cada linha da exportação precisa de um "sourceId" no formato de identificador (UUID).', 'ACCOUNTING_EXPORT_VALIDATION');
    }
    const amount = parseMoney(l.amount, 'O valor de cada linha da exportação', 'ACCOUNTING_EXPORT_VALIDATION', { allowNegative: true });
    if (amount === 0) {
      throw AppError.badRequest('Cada linha da exportação precisa de um valor diferente de zero.', 'ACCOUNTING_EXPORT_VALIDATION');
    }
    const sourceId = String(l.sourceId).toLowerCase();
    const key = `${l.sourceType}:${sourceId}`;
    if (seen.has(key)) {
      throw AppError.badRequest(`A origem "${key}" aparece mais de uma vez na mesma exportação.`, 'ACCOUNTING_EXPORT_VALIDATION');
    }
    seen.add(key);
    const description = typeof l.description === 'string' && l.description.trim() ? l.description.trim().slice(0, 1000) : `${SOURCE_TYPE_LABEL[l.sourceType]} ${sourceId}`;
    lines.push({ sourceType: l.sourceType, sourceId, amount, description });
  }

  // 2) Regra da empresa sobre qual origem o contador recebe (evita o mesmo fato em duas linhas).
  if (mode === 'COMMISSION_ONLY' && lines.some((l) => l.sourceType === 'NFSE')) {
    throw AppError.badRequest('Esta empresa exporta só as comissões (Parâmetros): NFS-e não entra na exportação.', 'ACCOUNTING_EXPORT_VALIDATION');
  }
  if (mode === 'NFSE_ONLY' && lines.some((l) => l.sourceType === 'COMMISSION_ENTITLEMENT')) {
    throw AppError.badRequest('Esta empresa exporta só as NFS-e (Parâmetros): comissão não entra na exportação.', 'ACCOUNTING_EXPORT_VALIDATION');
  }

  // 3) Origem real, nesta empresa e de pé; o valor da linha precisa ser o da origem.
  const sameCents = (x, y) => Math.round(Number(x) * 100) === Math.round(Number(y) * 100);
  for (const l of lines) {
    if (l.sourceType === 'COMMISSION_ENTITLEMENT') {
      // eslint-disable-next-line no-await-in-loop
      const origin = await CommissionEntitlement.findOne({ where: { id: l.sourceId, groupId, companyId }, attributes: ['id', 'status', 'amount'], transaction });
      if (!origin) throw AppError.badRequest(`A comissão "${l.sourceId}" não existe nesta empresa.`, 'ACCOUNTING_EXPORT_VALIDATION');
      if (!['RECEIVABLE', 'RECEIVED'].includes(origin.status)) throw AppError.badRequest(`A comissão "${l.sourceId}" não está a receber nem recebida: não entra na exportação.`, 'ACCOUNTING_EXPORT_VALIDATION');
      if (!sameCents(l.amount, origin.amount)) throw AppError.badRequest(`O valor da linha da comissão "${l.sourceId}" não confere com o valor do direito (use o ajuste para corrigir depois).`, 'ACCOUNTING_EXPORT_VALIDATION');
      if (mode === 'NFSE_PREFERRED') {
        // eslint-disable-next-line no-await-in-loop
        const hasInvoice = await InvoiceRequest.count({ where: { groupId, companyId, sourceType: 'COMMISSION_ENTITLEMENT', sourceId: l.sourceId, status: 'AUTHORIZED' }, transaction });
        if (hasInvoice) throw AppError.badRequest(`A comissão "${l.sourceId}" já tem NFS-e autorizada: pela regra da empresa (Parâmetros), o contador recebe a NFS-e, não a comissão.`, 'ACCOUNTING_EXPORT_VALIDATION');
      }
    } else if (l.sourceType === 'NFSE') {
      // eslint-disable-next-line no-await-in-loop
      const origin = await InvoiceRequest.findOne({ where: { id: l.sourceId, groupId, companyId }, attributes: ['id', 'status', 'amount'], transaction });
      if (!origin) throw AppError.badRequest(`A NFS-e "${l.sourceId}" não existe nesta empresa.`, 'ACCOUNTING_EXPORT_VALIDATION');
      if (origin.status !== 'AUTHORIZED') throw AppError.badRequest(`A NFS-e "${l.sourceId}" não está autorizada: não entra na exportação.`, 'ACCOUNTING_EXPORT_VALIDATION');
      if (!sameCents(l.amount, origin.amount)) throw AppError.badRequest(`O valor da linha da NFS-e "${l.sourceId}" não confere com o valor da nota.`, 'ACCOUNTING_EXPORT_VALIDATION');
    } else {
      // eslint-disable-next-line no-await-in-loop
      const origin = await FinancialEntry.findOne({ where: { id: l.sourceId, groupId, companyId }, attributes: ['id', 'status', 'amount'], transaction });
      if (!origin) throw AppError.badRequest(`O lançamento do Financeiro "${l.sourceId}" não existe nesta empresa.`, 'ACCOUNTING_EXPORT_VALIDATION');
      if (['REVERSED', 'CANCELLED'].includes(origin.status)) throw AppError.badRequest(`O lançamento do Financeiro "${l.sourceId}" foi estornado ou cancelado: não entra na exportação.`, 'ACCOUNTING_EXPORT_VALIDATION');
      if (!sameCents(l.amount, origin.amount)) throw AppError.badRequest(`O valor da linha do lançamento "${l.sourceId}" não confere com o valor do lançamento.`, 'ACCOUNTING_EXPORT_VALIDATION');
    }
  }

  const duplicate = await AccountingExportLine.findOne({
    where: {
      groupId,
      companyId,
      adjustmentOfLineId: null,
      [Op.or]: lines.map((l) => ({ sourceType: l.sourceType, sourceId: l.sourceId })),
    },
    transaction,
  });
  if (duplicate) {
    throw AppError.conflict(
      `A origem "${duplicate.sourceType}:${duplicate.sourceId}" já foi exportada no batch ${duplicate.batchId}. Para corrigir um valor já exportado, use o ajuste em vez de exportar de novo.`,
      'ACCOUNTING_EXPORT_DUPLICATE_SOURCE'
    );
  }

  const batchHash = hashLines(lines);
  let batch;
  try {
    batch = await sequelize.transaction({ transaction }, async (savepoint) => {
      const created = await AccountingExportBatch.create(
        { groupId, companyId, referencePeriod: period, batchHash, status: 'EXPORTED', createdBy: actorUserId || null },
        { transaction: savepoint }
      );
      for (const line of lines) {
        // eslint-disable-next-line no-await-in-loop
        await AccountingExportLine.create(
          { groupId, companyId, batchId: created.id, sourceType: line.sourceType, sourceId: line.sourceId, amount: line.amount, description: line.description },
          { transaction: savepoint }
        );
      }
      return created;
    });
  } catch (err) {
    if (err?.name === 'SequelizeUniqueConstraintError') {
      throw AppError.conflict('Alguma origem desta exportação foi exportada por outra pessoa ao mesmo tempo. Gere a lista de pendentes de novo.', 'ACCOUNTING_EXPORT_DUPLICATE_SOURCE');
    }
    throw err;
  }

  await registrarAuditoria(
    {
      groupId, companyId, actorUserId,
      action: 'correspondent.accounting_export.batch_created',
      entityType: 'AccountingExportBatch',
      entityId: batch.id,
      reason: `Batch de export contábil ${period} criado — ${lines.length} linha(s), hash ${batchHash}.`,
    },
    transaction
  );

  return batch;
}

/**
 * listExportCandidates — lançamentos do período ainda NÃO exportados: comissões recebíveis/recebidas
 * (COMMISSION_ENTITLEMENT) e NFS-e autorizadas (NFSE), conforme a regra de origem da empresa (Parâmetros).
 * O mês é o de Brasília. A competência da comissão é a data de recebimento (ou confirmação); a da NFS-e é a
 * data de emissão da nota. Cada linha referencia a origem real.
 */
async function listExportCandidates(referencePeriod, groupId, companyId, transaction) {
  const { end } = parsePeriod(typeof referencePeriod === 'string' ? referencePeriod : '', 'ACCOUNTING_EXPORT_VALIDATION');
  const { accountingExportSourceMode: mode } = await getFiscalSettings(groupId, companyId, null, transaction);

  const wantsCommissions = mode !== 'NFSE_ONLY';
  const wantsInvoices = mode !== 'COMMISSION_ONLY';
  const entitlements = wantsCommissions ? await CommissionEntitlement.findAll({
    // Tudo o que já existia até o fim do mês e ainda não foi exportado entra (a competência não é a data
    // de criação): uma comissão criada em janeiro e confirmada em março não pode ficar sem exportar.
    where: {
      groupId, companyId, status: { [Op.in]: ['RECEIVABLE', 'RECEIVED'] },
      [Op.and]: [literal(`COALESCE("CommissionEntitlement"."received_at", "CommissionEntitlement"."confirmed_at", "CommissionEntitlement"."created_at") < '${end.toISOString()}'`)],
    },
    order: [['id', 'ASC']],
    transaction,
  }) : [];
  let invoices = [];
  if (wantsInvoices || mode === 'NFSE_PREFERRED') {
    const authorized = await InvoiceRequest.findAll({ where: { groupId, companyId, status: 'AUTHORIZED' }, order: [['id', 'ASC']], transaction });
    const docs = authorized.length
      ? await TaxDocument.findAll({ where: { groupId, companyId, invoiceRequestId: authorized.map((i) => i.id) }, attributes: ['invoiceRequestId', 'issuedAt'], transaction })
      : [];
    const issuedByInvoice = new Map(docs.map((d) => [d.invoiceRequestId, d.issuedAt]));
    // Competência da nota = data de emissão (a do emissor); sem documento, a última atualização da nota.
    invoices = authorized.filter((i) => new Date(issuedByInvoice.get(i.id) || i.get('updated_at') || i.get('created_at')) < end);
  }
  const entitlementsWithInvoice = new Set(
    mode === 'NFSE_PREFERRED'
      ? invoices.filter((i) => i.sourceType === 'COMMISSION_ENTITLEMENT').map((i) => i.sourceId)
      : []
  );

  const candidates = [
    ...entitlements.filter((e) => !entitlementsWithInvoice.has(e.id)).map((e) => ({
      sourceType: 'COMMISSION_ENTITLEMENT',
      sourceId: e.id,
      amount: Number(e.amount),
      description: `Comissão de correspondente bancário, provider ${providerLabel(e.providerCode)}, fato gerador: ${TRIGGER_EVENT_LABEL[e.triggerEvent] || 'registro manual'}`,
    })),
    ...(wantsInvoices ? invoices : []).map((i) => ({
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
  if (!isUuid(String(batchId || ''))) {
    throw AppError.badRequest('Identificador de batch inválido.', 'ACCOUNTING_EXPORT_VALIDATION');
  }
  const batch = await AccountingExportBatch.findOne({ where: { id: batchId, groupId, companyId }, transaction });
  if (!batch) {
    throw AppError.notFound('Batch de exportação contábil não encontrado.', 'ACCOUNTING_EXPORT_BATCH_NOT_FOUND');
  }
  const lines = await AccountingExportLine.findAll({ where: { batchId, groupId, companyId }, order: [['created_at', 'ASC'], ['id', 'ASC']], transaction });
  const returns = await AccountingReturnImport.findAll({ where: { batchId, groupId, companyId }, order: [['imported_at', 'DESC']], transaction });
  const adjustments = lines.filter((l) => l.adjustmentOfLineId);
  return {
    batch,
    lines,
    returns,
    // Hash do conjunto atual (originais + ajustes): é o que o contador devolve quando já recebeu os ajustes.
    currentHash: hashLines(lines),
    adjustmentCount: adjustments.length,
    netTotal: Math.round(lines.reduce((sum, l) => sum + Number(l.amount), 0) * 100) / 100,
  };
}

/**
 * importAccountingReturn — retorno do contador. O arquivo devolvido precisa trazer o hash do batch
 * exportado (prova de que é resposta DAQUELE batch). Hash diferente = importação recusada. Hash
 * certo mas valores diferentes = importação registrada como DIVERGENT e issue aberta na reconciliação.
 */
async function importAccountingReturn(batchId, payload, actorUserId, groupId, companyId, transaction) {
  if (!isUuid(String(batchId || ''))) {
    throw AppError.badRequest('Identificador de batch inválido.', 'ACCOUNTING_RETURN_VALIDATION');
  }
  const batch = await AccountingExportBatch.findOne({ where: { id: batchId, groupId, companyId }, transaction });
  if (!batch) {
    throw AppError.notFound('Batch de exportação contábil não encontrado.', 'ACCOUNTING_EXPORT_BATCH_NOT_FOUND');
  }
  const returnedBatchHash = typeof payload?.batchHash === 'string' ? payload.batchHash.trim().toLowerCase() : '';
  if (!returnedBatchHash) {
    throw AppError.badRequest('Informe o hash do batch que consta no arquivo devolvido pelo contador.', 'ACCOUNTING_RETURN_VALIDATION');
  }
  // O hash do batch é o do arquivo exportado (linhas originais, congelado). Depois de ajustes, o
  // contador pode devolver também o hash do conjunto atual (originais + ajustes).
  const allBatchLines = await AccountingExportLine.findAll({ where: { batchId, groupId, companyId }, transaction });
  const currentHash = hashLines(allBatchLines);
  const matchesOriginal = returnedBatchHash === String(batch.batchHash).toLowerCase();
  if (!matchesOriginal && returnedBatchHash !== currentHash) {
    const rejectionAudit = {
      groupId, companyId, actorUserId,
      action: 'correspondent.accounting_return.rejected',
      entityType: 'AccountingExportBatch',
      entityId: batch.id,
      reason: 'Retorno do contador recusado: o hash informado não confere com o do batch exportado.',
    };
    // A recusa devolve erro e a transação volta: a auditoria sobrevive ao rollback pelo middleware de tenant.
    if (transaction) transaction.afterRollbackAudits = [...(transaction.afterRollbackAudits || []), rejectionAudit];
    throw AppError.unprocessable(
      'O hash do arquivo devolvido não confere com o do batch exportado. Confira se o retorno é deste batch.',
      'ACCOUNTING_RETURN_HASH_MISMATCH'
    );
  }
  const rawReturned = payload?.lines;
  if (!Array.isArray(rawReturned) || rawReturned.length === 0) {
    throw AppError.badRequest('O retorno precisa de ao menos uma linha.', 'ACCOUNTING_RETURN_VALIDATION');
  }
  if (rawReturned.length > MAX_LINES * 2) {
    throw AppError.badRequest(`O retorno aceita no máximo ${MAX_LINES * 2} linhas.`, 'ACCOUNTING_RETURN_VALIDATION');
  }
  // Mesma validação da criação do batch: tipo aceito, UUID (minúsculas) e valor numérico a 2 casas (nunca vazio/nulo).
  const returnedLines = rawReturned.map((line, index) => {
    if (!line || typeof line !== 'object' || !EXPORT_SOURCE_TYPES.includes(line.sourceType) || !isUuid(String(line.sourceId || ''))) {
      throw AppError.badRequest(`A linha ${index + 1} do retorno precisa de um tipo de origem válido e de um identificador (UUID).`, 'ACCOUNTING_RETURN_VALIDATION');
    }
    return {
      sourceType: line.sourceType,
      sourceId: String(line.sourceId).toLowerCase(),
      amount: parseMoney(line.amount, `O valor da linha ${index + 1} do retorno`, 'ACCOUNTING_RETURN_VALIDATION', { allowNegative: true }),
    };
  });

  // Hash do batch original informado: compara com as linhas ORIGINAIS (sem ajustes); hash do conjunto atual: com tudo.
  const exportedLines = matchesOriginal && returnedBatchHash !== currentHash
    ? allBatchLines.filter((l) => !l.adjustmentOfLineId)
    : allBatchLines;
  // O mesmo arquivo de retorno não entra duas vezes para o mesmo batch (nem abre divergência em dobro).
  const returnFileHash = hashLines(returnedLines);
  const alreadyImported = await AccountingReturnImport.findOne({ where: { batchId, groupId, companyId, returnedHash: returnFileHash }, transaction });
  if (alreadyImported) {
    throw AppError.conflict('Este arquivo de retorno já foi importado para este batch.', 'ACCOUNTING_RETURN_ALREADY_IMPORTED');
  }
  const net = (list) => {
    const map = new Map();
    for (const l of list) {
      const key = `${l.sourceType}:${String(l.sourceId).toLowerCase()}`;
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

  let record;
  try {
    record = await sequelize.transaction({ transaction }, (savepoint) => AccountingReturnImport.create(
      {
        groupId, companyId,
        batchId: batch.id,
        referencePeriod: batch.referencePeriod,
        fileName: typeof payload?.fileName === 'string' ? payload.fileName.slice(0, 255) : null,
        expectedHash: batch.batchHash,
        informedHash: returnedBatchHash,
        returnedHash: returnFileHash,
        status,
        lineCount: returnedLines.length,
        expectedTotal,
        returnedTotal,
        // As diferenças ficam detalhadas (origem a origem), inclusive quando se compensam no total.
        summaryJson: { divergences, netDifference: Math.round((expectedTotal - returnedTotal) * 100) / 100 },
        importedBy: actorUserId || null,
        importedAt: new Date(),
      },
      { transaction: savepoint }
    ));
  } catch (err) {
    if (err?.name === 'SequelizeUniqueConstraintError') {
      throw AppError.conflict('Este arquivo de retorno já foi importado para este batch.', 'ACCOUNTING_RETURN_ALREADY_IMPORTED');
    }
    throw err;
  }
  // O estado do batch acompanha o último retorno (batida ou divergência).
  batch.status = status === 'MATCHED' ? 'RETURNED' : 'DIVERGENT';
  await batch.save({ transaction });

  if (!divergences.length) {
    // Retorno que bate encerra as divergências de retornos anteriores deste mesmo batch.
    const earlier = await AccountingReturnImport.findAll({ where: { batchId, groupId, companyId, status: 'DIVERGENT', id: { [Op.ne]: record.id } }, attributes: ['id'], transaction });
    for (const prev of earlier) {
      // eslint-disable-next-line no-await-in-loop
      await autoResolveIfOpen('ACCOUNTING_RETURN_X_EXPORT', prev.id, actorUserId, groupId, companyId, transaction, 'um retorno posterior do mesmo batch bateu com a exportação');
    }
  }
  if (divergences.length) {
    // Esperado e real são os totais só das origens que divergem, então "diferença = esperado − real" sempre fecha.
    const expectedDiv = Math.round(divergences.reduce((a, d) => a + d.expected, 0) * 100) / 100;
    const returnedDiv = Math.round(divergences.reduce((a, d) => a + d.returned, 0) * 100) / 100;
    // Divergências que se compensam (+10 e −10) somam zero, mas a issue abre mesmo assim: a tolerância não vale aqui.
    await openReconciliation('ACCOUNTING_RETURN_X_EXPORT', record.id, expectedDiv, returnedDiv, Math.round((expectedDiv - returnedDiv) * 100) / 100, actorUserId, groupId, companyId, transaction);
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
 * `adjustmentOfLineId` — a linha original nunca é alterada. O ajuste de um ajuste não existe: o
 * ajuste sempre aponta para a linha original.
 */
async function adjustExportLine(originalLineId, deltaAmount, reasonText, actorUserId, groupId, companyId, transaction) {
  if (!isUuid(String(originalLineId || ''))) {
    throw AppError.badRequest('Identificador da linha de exportação inválido.', 'ACCOUNTING_EXPORT_VALIDATION');
  }
  const original = await AccountingExportLine.findOne({ where: { id: originalLineId, groupId, companyId }, transaction });
  if (!original) {
    throw AppError.notFound('Linha de export contábil não encontrada.', 'ACCOUNTING_EXPORT_LINE_NOT_FOUND');
  }
  if (original.adjustmentOfLineId) {
    throw AppError.conflict('Esta linha já é um ajuste. Ajuste a linha original, não o ajuste.', 'ACCOUNTING_EXPORT_ADJUSTMENT_OF_ADJUSTMENT');
  }
  const reason = typeof reasonText === 'string' ? reasonText.trim() : '';
  if (!reason) {
    throw AppError.badRequest('Ajustar uma linha exportada exige um motivo documentado.', 'ACCOUNTING_EXPORT_ADJUST_REASON_REQUIRED');
  }
  if (reason.length > 500) {
    throw AppError.badRequest('O motivo do ajuste deve ter no máximo 500 caracteres.', 'ACCOUNTING_EXPORT_ADJUST_REASON_REQUIRED');
  }
  const delta = parseMoney(deltaAmount, 'O campo "deltaAmount"', 'ACCOUNTING_EXPORT_VALIDATION', { allowNegative: true });
  if (Math.abs(delta) < 0.01) {
    throw AppError.badRequest('O campo "deltaAmount" deve ser um número diferente de zero (mínimo R$ 0,01).', 'ACCOUNTING_EXPORT_VALIDATION');
  }
  // Mesma trava do zeramento automático: um ajuste manual e um estorno automático da mesma origem não correm juntos.
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `export-adjust:${companyId}:${original.sourceType}:${original.sourceId}` }, transaction });

  const adjustment = await AccountingExportLine.create(
    {
      groupId, companyId,
      batchId: original.batchId,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      amount: delta,
      description: `Ajuste: ${reason}`,
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
      reason: `Ajuste de R$ ${delta.toFixed(2)} criado sobre a linha ${original.id} (nunca editada diretamente): ${reason}.`,
    },
    transaction
  );

  return adjustment;
}

/**
 * zeroOutExportedSource — a origem (comissão estornada, nota cancelada) já foi exportada ao contador:
 * cria uma linha de AJUSTE que leva o líquido dela a zero (considera os ajustes que já existem, em vez
 * de repetir o valor da linha original). Dois pedidos simultâneos não geram dois ajustes (trava de aviso
 * por origem). Sem exportação anterior, não faz nada.
 */
async function zeroOutExportedSource(sourceType, sourceId, reasonText, actorUserId, groupId, companyId, transaction) {
  // A linha de exportação é só-inserção (sem UPDATE para o papel de runtime): a serialização usa trava de
  // aviso por origem, em vez de FOR UPDATE na linha.
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `export-adjust:${companyId}:${sourceType}:${sourceId}` }, transaction });
  const original = await AccountingExportLine.findOne({
    where: { groupId, companyId, sourceType, sourceId, adjustmentOfLineId: null },
    transaction,
  });
  if (!original) return null;
  const all = await AccountingExportLine.findAll({ where: { groupId, companyId, batchId: original.batchId, sourceType, sourceId }, transaction });
  const net = Math.round(all.reduce((sum, l) => sum + Number(l.amount), 0) * 100) / 100;
  if (Math.abs(net) < 0.01) return null;
  return adjustExportLine(original.id, -net, reasonText, actorUserId, groupId, companyId, transaction);
}

/** listExportBatches — com a contagem de linhas/ajustes, o total líquido e o hash atual de cada batch. */
async function listExportBatches(groupId, companyId, transaction, { limit } = {}) {
  const batches = await AccountingExportBatch.findAll({
    where: { groupId, companyId },
    order: [['created_at', 'DESC'], ['id', 'ASC']],
    limit: Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 500),
    transaction,
  });
  if (batches.length === 0) return [];
  const lines = await AccountingExportLine.findAll({ where: { groupId, companyId, batchId: batches.map((b) => b.id) }, attributes: ['batchId', 'sourceType', 'sourceId', 'amount', 'adjustmentOfLineId'], transaction });
  const byBatch = new Map();
  for (const l of lines) {
    if (!byBatch.has(l.batchId)) byBatch.set(l.batchId, []);
    byBatch.get(l.batchId).push(l);
  }
  return batches.map((b) => {
    const own = byBatch.get(b.id) || [];
    return {
      ...b.toJSON(),
      lineCount: own.length,
      adjustmentCount: own.filter((l) => l.adjustmentOfLineId).length,
      netTotal: Math.round(own.reduce((sum, l) => sum + Number(l.amount), 0) * 100) / 100,
      currentHash: hashLines(own),
    };
  });
}

module.exports = { zeroOutExportedSource, createExportBatch, adjustExportLine, listExportBatches, listExportCandidates, getExportBatch, importAccountingReturn, hashLines };
